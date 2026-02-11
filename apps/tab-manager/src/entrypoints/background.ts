/**
 * Background service worker for Tab Manager.
 *
 * This is the hub of the extension:
 * 1. Holds the authoritative Y.Doc
 * 2. Syncs Browser ↔ Y.Doc (bidirectional)
 * 3. Syncs Y.Doc ↔ Server via WebSocket
 *
 * Bidirectional sync:
 * - Downstream (Browser → Y.Doc): Browser events trigger incremental updates
 * - Upstream (Y.Doc → Browser): Y.Doc observers trigger Browser APIs
 *
 * Multi-device sync:
 * - Each device has a unique ID stored in storage.local
 * - All IDs (tab, window, group) are scoped: `${deviceId}_${nativeId}`
 * - Each device only manages its own rows, never deleting other devices' data
 *
 * Sync strategy:
 * - Initial sync: `refetchAll()` queries all tabs/windows/groups from Browser
 * - Incremental sync: Event handlers update only the specific tab/window/group that changed
 * - Y.Doc observers call Browser APIs only for THIS device's data
 * - Coordination flags prevent infinite loops between the two directions
 */

import { ySweetSync } from '@epicenter/hq/extensions/y-sweet-sync';
import {
	createWorkspace,
	defineExports,
	defineWorkspace,
} from '@epicenter/hq/static';
import { Ok, tryAsync } from 'wellcrafted/result';
import { defineBackground } from 'wxt/utils/define-background';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Transaction } from 'yjs';
import { createBrowserConverters } from '$lib/browser-helpers';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
	parseGroupId,
	parseTabId,
	parseWindowId,
} from '$lib/device-id';
import type { Tab, Window } from '$lib/epicenter/browser.schema';
import { BROWSER_TABLES } from '$lib/epicenter/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Sync Coordination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bidirectional sync coordination state.
 *
 * Prevents infinite loops during two-way synchronization between Browser and Y.Doc.
 *
 * Primary mechanism: Y.js transaction `origin` parameter
 * - Remote changes (from WebSocket): origin !== null (WebSocket provider instance)
 * - Local changes (our refetch): origin === null (default Y.js behavior)
 *
 * The observers check `origin` to distinguish remote vs local changes and only
 * act on remote changes (when a markdown file changes on the server).
 *
 * Counters for secondary coordination (not booleans - see below):
 * - `yDocChangeCount`: Incremented when calling Browser APIs from Y.Doc observers
 *   Prevents Browser events from triggering refetch during our own API calls.
 * - `refetchCount`: Incremented when syncing Browser → Y.Doc (refetch functions)
 *   Used as a secondary guard in refetch helpers.
 *
 * Why counters instead of booleans:
 * Multiple async operations can run concurrently. A boolean causes race conditions:
 * - Event A sets flag = true, awaits async work
 * - Event B sets flag = true, awaits async work
 * - Event A completes, sets flag = false (BUG! B is still working)
 * - Observer sees false, processes B's side effect, creates infinite loop
 *
 * With counters:
 * - Event A increments to 1, awaits async work
 * - Event B increments to 2, awaits async work
 * - Event A completes, decrements to 1 (still > 0, protected)
 * - Event B completes, decrements to 0
 */
const syncCoordination = {
	/** Count of concurrent Y.Doc change handlers calling Browser APIs */
	yDocChangeCount: 0,
	/** Count of concurrent refetch operations (Browser → Y.Doc) */
	refetchCount: 0,
	/**
	 * Set of tab IDs that were recently added by local Browser events.
	 * Used to detect echoes: if onAdd fires for a tab_id in this set, it's our own echo.
	 * Entries are removed after a short timeout to prevent memory leaks.
	 */
	recentlyAddedTabIds: new Set<number>(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Background Service Worker
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: defineBackground callback CANNOT be async (MV3 constraint).
// Event listeners must be registered synchronously at the top level.
// We use the "deferred handler" pattern: store initPromise, await it in handlers.
export default defineBackground(() => {
	console.log('[Background] Initializing Tab Manager...');

	// Get device ID early (cached after first call)
	const deviceIdPromise = getDeviceId();

	// ─────────────────────────────────────────────────────────────────────────
	// Workspace Definition (pure schema, no runtime)
	// ─────────────────────────────────────────────────────────────────────────

	const definition = defineWorkspace({
		id: 'tab-manager', // Stable ID for persistence
		tables: BROWSER_TABLES,
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Create Workspace Client with Extensions
	// ─────────────────────────────────────────────────────────────────────────

	const client = createWorkspace(definition).withExtensions({
		/**
		 * IndexedDB persistence for service worker restarts.
		 * Chrome MV3 service workers terminate after ~30 seconds of inactivity.
		 * Without persistence, Y.Doc state would be lost on every restart.
		 */
		persistence: ({ ydoc }) => {
			const provider = new IndexeddbPersistence('tab-manager', ydoc);
			return defineExports({
				provider,
				whenSynced: provider.whenSynced,
				destroy: () => provider.destroy(),
			});
		},

		/**
		 * Y-Sweet sync for real-time collaboration.
		 *
		 * Y-Sweet provides:
		 * - WebSocket-based real-time sync
		 * - Token-based authentication (for hosted mode)
		 * - Automatic reconnection
		 *
		 * Server setup: npx y-sweet@latest serve
		 * Default: http://127.0.0.1:8080
		 *
		 * @see specs/y-sweet-sync-extension.md
		 */
		sync: ySweetSync({
			mode: 'direct',
			serverUrl: 'http://127.0.0.1:8080',
		}),
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Action Helpers (extracted from workspace definition)
	// ─────────────────────────────────────────────────────────────────────────

	const { tables, ydoc } = client;

	const actions = {
		/**
		 * Register this device in the devices table.
		 */
		async registerDevice() {
			const deviceId = await deviceIdPromise;
			const existingDevice = tables.devices.get(deviceId);

			// Get existing name if valid, otherwise generate default
			const existingName =
				existingDevice.status === 'valid' ? existingDevice.row.name : null;

			tables.devices.set({
				id: deviceId,
				// Keep existing name if set, otherwise generate default
				name: existingName ?? (await generateDefaultDeviceName()),
				last_seen: new Date().toISOString(),
				browser: getBrowserName(),
			});
		},

		/**
		 * Refetch tabs from Browser and diff into Y.Doc.
		 * Only manages THIS device's tabs - other devices' tabs are untouched.
		 */
		async refetchTabs() {
			const deviceId = await deviceIdPromise;
			const { tabToRow, TabId } = createBrowserConverters(deviceId);
			const browserTabs = await browser.tabs.query({});
			const tabIds = new Set(
				browserTabs
					.filter((t): t is typeof t & { id: number } => t.id !== undefined)
					.map((t) => t.id),
			);
			const existingYDocTabs = tables.tabs.getAllValid();

			ydoc.transact(() => {
				// Set all browser tabs (with device-scoped IDs)
				for (const tab of browserTabs) {
					if (tab.id === undefined) continue;
					tables.tabs.set(tabToRow(tab));
				}

				// Delete only THIS device's tabs that aren't in browser OR have malformed IDs
				for (const existing of existingYDocTabs) {
					if (existing.device_id !== deviceId) continue; // Skip other devices!

					// Check 1: tab_id doesn't exist in browser
					if (!tabIds.has(existing.tab_id)) {
						tables.tabs.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					// Expected: "${deviceId}_${tabId}", but copied files may have " copy 2" suffix
					const expectedId = TabId(existing.tab_id);
					if (existing.id !== expectedId) {
						tables.tabs.delete(existing.id);
					}
				}
			});
		},

		/**
		 * Refetch windows from Browser and diff into Y.Doc.
		 * Only manages THIS device's windows - other devices' windows are untouched.
		 */
		async refetchWindows() {
			const deviceId = await deviceIdPromise;
			const { windowToRow, WindowId } = createBrowserConverters(deviceId);
			const browserWindows = await browser.windows.getAll();
			const windowIds = new Set(
				browserWindows
					.filter((w): w is typeof w & { id: number } => w.id !== undefined)
					.map((w) => w.id),
			);
			const existingYDocWindows = tables.windows.getAllValid();

			ydoc.transact(() => {
				// Set all browser windows (with device-scoped IDs)
				for (const win of browserWindows) {
					if (win.id === undefined) continue;
					tables.windows.set(windowToRow(win));
				}

				// Delete only THIS device's windows that aren't in browser OR have malformed IDs
				for (const existing of existingYDocWindows) {
					if (existing.device_id !== deviceId) continue; // Skip other devices!

					// Check 1: window_id doesn't exist in browser
					if (!windowIds.has(existing.window_id)) {
						tables.windows.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					const expectedId = WindowId(existing.window_id);
					if (existing.id !== expectedId) {
						tables.windows.delete(existing.id);
					}
				}
			});
		},

		/**
		 * Refetch tab groups from Browser and diff into Y.Doc.
		 * Only manages THIS device's groups - other devices' groups are untouched.
		 */
		async refetchTabGroups() {
			if (!browser.tabGroups) return;

			const deviceId = await deviceIdPromise;
			const { tabGroupToRow, GroupId } = createBrowserConverters(deviceId);
			const browserGroups = await browser.tabGroups.query({});
			const groupIds = new Set(browserGroups.map((g) => g.id));
			const existingYDocGroups = tables.tab_groups.getAllValid();

			ydoc.transact(() => {
				// Set all browser groups (with device-scoped IDs)
				for (const group of browserGroups) {
					tables.tab_groups.set(tabGroupToRow(group));
				}

				// Delete only THIS device's groups that aren't in browser OR have malformed IDs
				for (const existing of existingYDocGroups) {
					if (existing.device_id !== deviceId) continue; // Skip other devices!

					// Check 1: group_id doesn't exist in browser
					if (!groupIds.has(existing.group_id)) {
						tables.tab_groups.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					const expectedId = GroupId(existing.group_id);
					if (existing.id !== expectedId) {
						tables.tab_groups.delete(existing.id);
					}
				}
			});
		},

		/**
		 * Refetch all (tabs, windows, tab groups) from Browser.
		 */
		async refetchAll() {
			// Register device first
			await this.registerDevice();
			// Refetch windows first (tabs reference windows)
			await this.refetchWindows();
			await this.refetchTabs();
			await this.refetchTabGroups();

			console.log('[Background] Refetched all from Browser:', {
				tabs: tables.tabs.getAllValid().length,
				windows: tables.windows.getAllValid().length,
				tabGroups: tables.tab_groups.getAllValid().length,
			});
		},

		getAllTabs(): Tab[] {
			return tables.tabs.getAllValid().sort((a, b) => a.index - b.index);
		},

		getAllWindows(): Window[] {
			return tables.windows.getAllValid();
		},

		getTabsByWindow(windowId: string): Tab[] {
			return tables.tabs
				.filter((t) => t.window_id === windowId)
				.sort((a, b) => a.index - b.index);
		},
	};

	// Debug: Listen for all Y.Doc updates to see if we're receiving them
	ydoc.on('update', (update: Uint8Array, origin: unknown) => {
		// Get the ytables Y.Map to inspect structure
		const ytables = ydoc.getMap('tables');
		const tabsTable = ytables.get('tabs') as Map<string, unknown> | undefined;

		// Get entries from tabs table if it's a Y.Map
		let tabsEntries: string[] = [];
		if (tabsTable && typeof tabsTable.keys === 'function') {
			tabsEntries = Array.from(tabsTable.keys()).slice(0, 5);
		}

		console.log('[Background] Y.Doc update received', {
			updateSize: update.length,
			origin: origin === null ? 'local' : 'remote',
			ytablesSize: ytables.size,
			ytablesKeys: Array.from(ytables.keys()),
			tabsTableExists: !!tabsTable,
			tabsTableSize: tabsTable?.size ?? 'N/A',
			tabsFirstFiveKeys: tabsEntries,
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Initialization Promise (Deferred Handler Pattern)
	// All event handlers await this before processing to avoid race conditions.
	// This ensures Browser state is synced to Y.Doc before any handler runs.
	// ─────────────────────────────────────────────────────────────────────────

	const initPromise = (async () => {
		// Wait for IndexedDB to load existing state (critical for service worker restarts)
		await client.extensions.persistence.whenSynced;
		console.log('[Background] IndexedDB persistence synced');

		// Then refetch to sync Y.Doc with current browser state
		await actions.refetchAll();
		console.log('[Background] Initial sync complete');
	})().catch((err) =>
		console.error('[Background] Initialization failed:', err),
	);

	// ─────────────────────────────────────────────────────────────────────────
	// Browser Keepalive (Chrome MV3 only)
	// Chrome service workers go dormant after ~30 seconds of inactivity.
	// We use Chrome Alarms API to wake the service worker periodically,
	// keeping the WebSocket connection alive for real-time Y.Doc sync.
	// Firefox doesn't have this limitation (uses Event Pages, not service workers).
	//
	// NOTE: WebSocket messages from the server CANNOT wake a dormant service worker.
	// When dormant, the WebSocket connection is suspended/closed. Only Browser events
	// (alarms, tabs, runtime messages, etc.) can wake the worker.
	// ─────────────────────────────────────────────────────────────────────────

	if (import.meta.env.CHROME && browser.alarms) {
		const KEEPALIVE_ALARM = 'keepalive';
		const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds (under 30s threshold)

		// Create the keepalive alarm
		browser.alarms.create(KEEPALIVE_ALARM, {
			periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
		});

		// Handle alarm - the act of waking the service worker keeps the WebSocket alive
		browser.alarms.onAlarm.addListener((alarm) => {
			if (alarm.name === KEEPALIVE_ALARM) {
				// No-op: just waking the service worker is sufficient
			}
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Lifecycle Events - Re-sync on explicit browser events
	// onInstalled: Extension install, update, or Browser update
	// onStartup: Browser session start (user profile loads)
	// ─────────────────────────────────────────────────────────────────────────

	browser.runtime.onInstalled.addListener(async () => {
		console.log('[Background] onInstalled: re-syncing...');
		await actions
			.refetchAll()
			.then(() => console.log('[Background] onInstalled: refetch complete'))
			.catch((err) =>
				console.error('[Background] onInstalled: refetch failed:', err),
			);
	});

	browser.runtime.onStartup.addListener(async () => {
		console.log('[Background] onStartup: re-syncing...');
		await actions
			.refetchAll()
			.then(() => console.log('[Background] onStartup: refetch complete'))
			.catch((err) =>
				console.error('[Background] onStartup: refetch failed:', err),
			);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Browser Event Listeners - Incremental Updates
	// Instead of refetching ALL tabs on every event, we only update the
	// specific tab/window/group that changed. This dramatically reduces
	// YJS operations (from N upserts to 1 upsert per event).
	// ─────────────────────────────────────────────────────────────────────────

	// Helper: Set a single tab by querying Browser (for events that don't provide full tab)
	const setTabById = async (tabId: number) => {
		const deviceId = await deviceIdPromise;
		const { tabToRow } = createBrowserConverters(deviceId);
		await tryAsync({
			try: async () => {
				const tab = await browser.tabs.get(tabId);
				tables.tabs.set(tabToRow(tab));
			},
			catch: (error) => {
				// Tab may have been closed already
				console.warn(`[Background] Failed to get tab ${tabId}:`, error);
				return Ok(undefined);
			},
		});
	};

	// Helper: Set a single window by querying Browser
	const setWindowById = async (windowId: number) => {
		const deviceId = await deviceIdPromise;
		const { windowToRow } = createBrowserConverters(deviceId);
		await tryAsync({
			try: async () => {
				const window = await browser.windows.get(windowId);
				tables.windows.set(windowToRow(window));
			},
			catch: (error) => {
				// Window may have been closed already
				console.warn(`[Background] Failed to get window ${windowId}:`, error);
				return Ok(undefined);
			},
		});
	};

	// ─────────────────────────────────────────────────────────────────────────
	// Tab Event Handlers - Incremental updates (1 tab at a time)
	// ─────────────────────────────────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener(async (tab) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;
		const tabId = tab.id;
		if (tabId === undefined) return;

		const deviceId = await deviceIdPromise;
		const { tabToRow } = createBrowserConverters(deviceId);

		// Track this tab as recently added to detect echoes in onAdd observer
		syncCoordination.recentlyAddedTabIds.add(tabId);
		// Remove after 5 seconds to prevent memory leaks
		setTimeout(() => {
			syncCoordination.recentlyAddedTabIds.delete(tabId);
		}, 5000);

		syncCoordination.refetchCount++;
		tables.tabs.set(tabToRow(tab));
		syncCoordination.refetchCount--;
	});

	// onRemoved: Only tabId provided - delete directly
	browser.tabs.onRemoved.addListener(async (tabId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		const deviceId = await deviceIdPromise;
		const { TabId } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;
		tables.tabs.delete(TabId(tabId));
		syncCoordination.refetchCount--;
	});

	// onUpdated: Full Tab object provided (3rd arg)
	browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;
		if (tab.id === undefined) return;

		const deviceId = await deviceIdPromise;
		const { tabToRow } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;
		tables.tabs.set(tabToRow(tab));
		syncCoordination.refetchCount--;
	});

	// onMoved: Only tabId + moveInfo provided - need to query Browser
	browser.tabs.onMoved.addListener(async (tabId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;
		await setTabById(tabId);
		syncCoordination.refetchCount--;
	});

	// onActivated: Only activeInfo provided - need to query Browser
	// Note: We need to update BOTH the newly activated tab AND the previously active tab
	// in the same window (to set active: false on the old one)
	browser.tabs.onActivated.addListener(async (activeInfo) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		const deviceId = await deviceIdPromise;
		const { TabId, WindowId } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;

		const deviceWindowId = WindowId(activeInfo.windowId);
		const deviceTabId = TabId(activeInfo.tabId);

		// Find and update the previously active tab in this window (set active: false)
		const previouslyActiveTabs = tables.tabs
			.filter((t) => t.window_id === deviceWindowId && t.active)
			.filter((t) => t.id !== deviceTabId);

		for (const prevTab of previouslyActiveTabs) {
			tables.tabs.set({ ...prevTab, active: false });
		}

		// Update the newly activated tab
		await setTabById(activeInfo.tabId);

		syncCoordination.refetchCount--;
	});

	// onAttached: Tab moved between windows - need to query Browser
	browser.tabs.onAttached.addListener(async (tabId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;
		await setTabById(tabId);
		syncCoordination.refetchCount--;
	});

	// onDetached: Tab detached from window - need to query Browser
	browser.tabs.onDetached.addListener(async (tabId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;
		await setTabById(tabId);
		syncCoordination.refetchCount--;
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Window Event Handlers - Incremental updates (1 window at a time)
	// ─────────────────────────────────────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener(async (window) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;
		if (window.id === undefined) return;

		const deviceId = await deviceIdPromise;
		const { windowToRow } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;
		tables.windows.set(windowToRow(window));
		syncCoordination.refetchCount--;
	});

	// onRemoved: Only windowId provided - delete directly
	browser.windows.onRemoved.addListener(async (windowId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		const deviceId = await deviceIdPromise;
		const { WindowId } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;
		tables.windows.delete(WindowId(windowId));
		syncCoordination.refetchCount--;
	});

	// onFocusChanged: Only windowId provided - need to query Browser
	// Note: windowId can be WINDOW_ID_NONE (-1) when all windows lose focus
	// We need to update BOTH the newly focused window AND previously focused windows
	browser.windows.onFocusChanged.addListener(async (windowId) => {
		await initPromise;
		if (syncCoordination.yDocChangeCount > 0) return;

		const deviceId = await deviceIdPromise;
		const { WindowId } = createBrowserConverters(deviceId);
		syncCoordination.refetchCount++;

		const deviceWindowId = WindowId(windowId);

		// Find and update previously focused windows (set focused: false)
		const previouslyFocusedWindows = tables.windows
			.filter((w) => w.focused)
			.filter((w) => w.id !== deviceWindowId);

		for (const prevWindow of previouslyFocusedWindows) {
			tables.windows.set({ ...prevWindow, focused: false });
		}

		// Update the newly focused window (if not WINDOW_ID_NONE)
		if (windowId !== browser.windows.WINDOW_ID_NONE) {
			await setWindowById(windowId);
		}

		syncCoordination.refetchCount--;
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Tab Group Event Handlers - Incremental updates (Chrome 88+ only)
	// ─────────────────────────────────────────────────────────────────────────

	if (browser.tabGroups) {
		// onCreated: Full TabGroup object provided
		browser.tabGroups.onCreated.addListener(async (group) => {
			await initPromise;
			if (syncCoordination.yDocChangeCount > 0) return;

			const deviceId = await deviceIdPromise;
			const { tabGroupToRow } = createBrowserConverters(deviceId);
			syncCoordination.refetchCount++;
			tables.tab_groups.set(tabGroupToRow(group));
			syncCoordination.refetchCount--;
		});

		// onRemoved: Full TabGroup object provided
		browser.tabGroups.onRemoved.addListener(async (group) => {
			await initPromise;
			if (syncCoordination.yDocChangeCount > 0) return;

			const deviceId = await deviceIdPromise;
			const { GroupId } = createBrowserConverters(deviceId);
			syncCoordination.refetchCount++;
			tables.tab_groups.delete(GroupId(group.id));
			syncCoordination.refetchCount--;
		});

		// onUpdated: Full TabGroup object provided
		browser.tabGroups.onUpdated.addListener(async (group) => {
			await initPromise;
			if (syncCoordination.yDocChangeCount > 0) return;

			const deviceId = await deviceIdPromise;
			const { tabGroupToRow } = createBrowserConverters(deviceId);
			syncCoordination.refetchCount++;
			tables.tab_groups.set(tabGroupToRow(group));
			syncCoordination.refetchCount--;
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Y.Doc Observers - trigger Browser APIs on upstream changes
	// These handle changes synced from the server (e.g., markdown file deletions)
	// Only process changes for THIS device - other devices manage themselves
	// ─────────────────────────────────────────────────────────────────────────

	client.tables.tabs.observe((changedIds, txn) => {
		const transaction = txn as Transaction;
		for (const id of changedIds) {
			const result = client.tables.tabs.get(id);
			switch (result.status) {
				case 'not_found':
					// Deleted
					void (async () => {
						await initPromise;

						console.log('[Background] tabs.onDelete fired:', {
							id,
							origin: transaction.origin,
							isRemote: transaction.origin !== null,
						});

						if (transaction.origin === null) {
							console.log(
								'[Background] tabs.onDelete SKIPPED: local origin (our own change)',
							);
							return;
						}

						const deviceId = await deviceIdPromise;
						const parsed = parseTabId(id);

						if (!parsed || parsed.deviceId !== deviceId) {
							console.log(
								'[Background] tabs.onDelete SKIPPED: different device or invalid ID',
							);
							return;
						}

						console.log(
							'[Background] tabs.onDelete REMOVING Browser tab:',
							parsed.tabId,
						);
						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								await browser.tabs.remove(parsed.tabId);
								console.log(
									'[Background] tabs.onDelete SUCCESS: removed tab',
									parsed.tabId,
								);
							},
							catch: (error) => {
								console.log(`[Background] Failed to close tab ${id}:`, error);
								return Ok(undefined);
							},
						});
						syncCoordination.yDocChangeCount--;
					})();
					break;
				case 'valid': {
					// Added or updated
					const row = result.row;
					void (async () => {
						await initPromise;

						console.log('[Background] tabs.onAdd fired:', {
							origin: transaction.origin,
							isRemote: transaction.origin !== null,
							row,
						});

						if (transaction.origin === null) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: local origin (our own change)',
							);
							return;
						}

						const deviceId = await deviceIdPromise;

						if (row.device_id !== deviceId) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: different device',
								row.device_id,
							);
							return;
						}

						if (!row.url) {
							console.log('[Background] tabs.onAdd SKIPPED: no URL in row');
							return;
						}

						if (syncCoordination.recentlyAddedTabIds.has(row.tab_id)) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: tab was recently added locally (echo)',
								row.tab_id,
							);
							return;
						}

						const existingTab = await tryAsync({
							try: () => browser.tabs.get(row.tab_id),
							catch: () => Ok(undefined),
						});

						if (existingTab.data) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: tab already exists in browser',
								row.tab_id,
							);
							return;
						}

						console.log(
							'[Background] tabs.onAdd CREATING tab with URL:',
							row.url,
						);
						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								await browser.tabs.create({ url: row.url });
								console.log(
									'[Background] tabs.onAdd tab created, now refetching...',
								);

								syncCoordination.refetchCount++;
								await actions.refetchTabs();
								syncCoordination.refetchCount--;
								console.log('[Background] tabs.onAdd refetch complete');
							},
							catch: (error) => {
								console.log(
									`[Background] Failed to create tab from ${row.id}:`,
									error,
								);
								return Ok(undefined);
							},
						});
						syncCoordination.yDocChangeCount--;
					})();
					break;
				}
			}
		}
	});

	client.tables.windows.observe((changedIds, txn) => {
		const transaction = txn as Transaction;
		for (const id of changedIds) {
			const result = client.tables.windows.get(id);
			switch (result.status) {
				case 'not_found':
					// Deleted
					void (async () => {
						await initPromise;

						if (transaction.origin === null) return;

						const deviceId = await deviceIdPromise;
						const parsed = parseWindowId(id);

						if (!parsed || parsed.deviceId !== deviceId) return;

						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								await browser.windows.remove(parsed.windowId);
							},
							catch: (error) => {
								console.log(
									`[Background] Failed to close window ${id}:`,
									error,
								);
								return Ok(undefined);
							},
						});
						syncCoordination.yDocChangeCount--;
					})();
					break;
				case 'valid': {
					// Added or updated
					const row = result.row;
					void (async () => {
						await initPromise;

						if (transaction.origin === null) return;

						const deviceId = await deviceIdPromise;

						if (row.device_id !== deviceId) return;

						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								await browser.windows.create({});

								syncCoordination.refetchCount++;
								await actions.refetchWindows();
								syncCoordination.refetchCount--;
							},
							catch: (error) => {
								console.log(
									`[Background] Failed to create window from ${row.id}:`,
									error,
								);
								return Ok(undefined);
							},
						});
						syncCoordination.yDocChangeCount--;
					})();
					break;
				}
			}
		}
	});

	if (browser.tabGroups) {
		client.tables.tab_groups.observe((changedIds, txn) => {
			const transaction = txn as Transaction;
			for (const id of changedIds) {
				const result = client.tables.tab_groups.get(id);
				if (result.status === 'not_found') {
					// Deleted
					void (async () => {
						await initPromise;

						if (transaction.origin === null) return;

						const deviceId = await deviceIdPromise;
						const parsed = parseGroupId(id);

						if (!parsed || parsed.deviceId !== deviceId) return;

						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								const tabs = await browser.tabs.query({
									groupId: parsed.groupId,
								});
								for (const tab of tabs) {
									if (tab.id !== undefined) {
										await browser.tabs.ungroup(tab.id);
									}
								}
							},
							catch: (error) => {
								console.log(
									`[Background] Failed to ungroup tab group ${id}:`,
									error,
								);
								return Ok(undefined);
							},
						});
						syncCoordination.yDocChangeCount--;
					})();
				}
			}
		});
	}

	console.log('[Background] Tab Manager initialized', {
		tabs: actions.getAllTabs().length,
		windows: actions.getAllWindows().length,
	});
});
