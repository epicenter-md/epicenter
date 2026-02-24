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

import { createWorkspace } from '@epicenter/hq';
import { createSyncExtension } from '@epicenter/hq/extensions/sync';
import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
import { Ok, tryAsync } from 'wellcrafted/result';
import { defineBackground } from 'wxt/utils/define-background';
import type { Transaction } from 'yjs';
import { type ChatRequest, createChatEngine } from '$lib/ai/engine';
import { startCommandConsumer } from '$lib/commands/consumer';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { tabGroupToRow, tabToRow, windowToRow } from '$lib/sync/row-converters';
import {
	createGroupCompositeId,
	createTabCompositeId,
	createWindowCompositeId,
	type DeviceId,
	definition,
	type GroupCompositeId,
	parseGroupId,
	parseTabId,
	parseWindowId,
	type Tab,
	type TabCompositeId,
	type Window,
	type WindowCompositeId,
} from '$lib/workspace';

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
	 * Used to detect echoes: if onAdd fires for a tabId in this set, it's our own echo.
	 * Entries are removed after a short timeout to prevent memory leaks.
	 */
	recentlyAddedTabIds: new Set<number>(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Background Service Worker
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: defineBackground callback CANNOT be async (MV3 constraint).
// Event listeners must be registered synchronously at the top level.
// We use the "deferred handler" pattern: store ready promise, await it in handlers.
export default defineBackground(() => {
	// Open side panel when the extension icon is clicked (Chromium-based browsers).
	// Firefox uses sidebar_action manifest key — no runtime call needed.
	if (!import.meta.env.FIREFOX) {
		browser.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((error: unknown) =>
				console.error('[Background] Failed to set panel behavior:', error),
			);
	}

	console.log('[Background] Initializing Tab Manager...');

	// ─────────────────────────────────────────────────────────────────────────
	// Create Workspace Client with Extensions
	// ─────────────────────────────────────────────────────────────────────────

	const client = createWorkspace(definition)
		.withExtension('persistence', indexeddbPersistence)
		.withExtension(
			'sync',
			/**
			 * WebSocket sync with Y-Sweet protocol.
			 *
			 * Persistence extension loads first (critical for service worker restarts —
			 * Chrome MV3 terminates after ~30s of inactivity). The sync extension
			 * waits for persistence via `context.whenReady`, then connects with
			 * an accurate state vector.
			 *
			 * Server setup: bun run packages/server/
			 * Default: ws://127.0.0.1:3913
			 */
			createSyncExtension({
				url: 'ws://127.0.0.1:3913/rooms/{id}',
			}),
		);

	// ─────────────────────────────────────────────────────────────────────────
	// Device Identity (resolves before refetchAll — prevents deadlock)
	// ─────────────────────────────────────────────────────────────────────────

	const deviceIdPromise = (async () => {
		await client.whenReady;
		console.log('[Background] Persistence loaded');
		const deviceId = await getDeviceId();

		client.awareness.setLocal({
			deviceId,
			deviceType: 'browser-extension',
		});

		return deviceId;
	})();

	// ─────────────────────────────────────────────────────────────────────────
	// Action Helpers (extracted from workspace definition)
	// ─────────────────────────────────────────────────────────────────────────

	const { tables } = client;

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
				lastSeen: new Date().toISOString(),
				browser: getBrowserName(),
				_v: 1,
			});
		},

		/**
		 * Refetch tabs from Browser and diff into Y.Doc.
		 * Only manages THIS device's tabs - other devices' tabs are untouched.
		 */
		async refetchTabs() {
			const deviceId = await deviceIdPromise;
			const browserTabs = await browser.tabs.query({});
			const rows = browserTabs.flatMap((tab) => {
				const row = tabToRow(deviceId, tab);
				return row ? [row] : [];
			});
			const tabIds = new Set(rows.map((r) => r.tabId));
			const existingYDocTabs = tables.tabs.getAllValid();

			client.batch(() => {
				// Set all browser tabs (with device-scoped IDs)
				for (const row of rows) {
					tables.tabs.set(row);
				}

				// Delete only THIS device's tabs that aren't in browser OR have malformed IDs
				for (const existing of existingYDocTabs) {
					if (existing.deviceId !== deviceId) continue; // Skip other devices!

					// Check 1: tabId doesn't exist in browser
					if (!tabIds.has(existing.tabId)) {
						tables.tabs.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					// Expected: "${deviceId}_${tabId}", but copied files may have " copy 2" suffix
					const expectedId = createTabCompositeId(deviceId, existing.tabId);
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
			const browserWindows = await browser.windows.getAll();
			const rows = browserWindows.flatMap((win) => {
				const row = windowToRow(deviceId, win);
				return row ? [row] : [];
			});
			const windowIds = new Set(rows.map((r) => r.windowId));
			const existingYDocWindows = tables.windows.getAllValid();

			client.batch(() => {
				// Set all browser windows (with device-scoped IDs)
				for (const row of rows) {
					tables.windows.set(row);
				}

				// Delete only THIS device's windows that aren't in browser OR have malformed IDs
				for (const existing of existingYDocWindows) {
					if (existing.deviceId !== deviceId) continue; // Skip other devices!

					// Check 1: windowId doesn't exist in browser
					if (!windowIds.has(existing.windowId)) {
						tables.windows.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					const expectedId = createWindowCompositeId(
						deviceId,
						existing.windowId,
					);
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
			const deviceId = await deviceIdPromise;
			if (!browser.tabGroups) return;
			const browserGroups = await browser.tabGroups.query({});
			const groupIds = new Set(browserGroups.map((g) => g.id));
			const existingYDocGroups = tables.tabGroups.getAllValid();

			client.batch(() => {
				// Set all browser groups (with device-scoped IDs)
				for (const group of browserGroups) {
					tables.tabGroups.set(tabGroupToRow(deviceId, group));
				}

				// Delete only THIS device's groups that aren't in browser OR have malformed IDs
				for (const existing of existingYDocGroups) {
					if (existing.deviceId !== deviceId) continue; // Skip other devices!

					// Check 1: groupId doesn't exist in browser
					if (!groupIds.has(existing.groupId)) {
						tables.tabGroups.delete(existing.id);
						continue;
					}

					// Check 2: ID doesn't match expected pattern (e.g., from copied markdown files)
					const expectedId = createGroupCompositeId(deviceId, existing.groupId);
					if (existing.id !== expectedId) {
						tables.tabGroups.delete(existing.id);
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
				tabGroups: tables.tabGroups.getAllValid().length,
			});
		},

		getAllTabs(): Tab[] {
			return tables.tabs.getAllValid().sort((a, b) => a.index - b.index);
		},

		getAllWindows(): Window[] {
			return tables.windows.getAllValid();
		},

		getTabsByWindow(windowId: WindowCompositeId): Tab[] {
			return tables.tabs
				.filter((t) => t.windowId === windowId)
				.sort((a, b) => a.index - b.index);
		},
	};

	// Debug: Listen for all Y.Doc updates to see if we're receiving them
	client.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
		// Get the ytables Y.Map to inspect structure
		const ytables = client.ydoc.getMap('tables');
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
	// Ready Promise (Deferred Handler Pattern)
	// All event handlers await this before processing to avoid race conditions.
	// Resolves with the device ID so handlers get both readiness and identity
	// from a single await.
	// ─────────────────────────────────────────────────────────────────────────

	const whenReady = (async (): Promise<{
		deviceId: DeviceId;
	}> => {
		const deviceId = await deviceIdPromise;

		await actions.refetchAll();
		console.log('[Background] Initial sync complete');

		return Object.freeze({ deviceId });
	})().catch((err) => {
		console.error('[Background] Initialization failed:', err);
		throw err;
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Command Consumer — execute AI commands targeting this device
	// ─────────────────────────────────────────────────────────────────────────

	whenReady.then(({ deviceId }) => {
		startCommandConsumer(
			client.tables.commands,
			client.tables.savedTabs,
			deviceId,
		);
		console.log('[Background] Command consumer started');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// AI Chat Engine — runs chat() directly in the BGSW
	// Side panel sends { type: 'chat', ... } via chrome.runtime.sendMessage.
	// Engine creates adapters, binds tools, streams response, writes to Y.Doc.
	// Side panel observes Y.Doc changes via BroadcastChannel (sub-ms sync).
	// ─────────────────────────────────────────────────────────────────────────

	// Engine is created after workspace + deviceId are ready.
	// The onMessage handler below awaits this promise (deferred handler pattern).
	const chatEnginePromise = whenReady.then(({ deviceId }) => {
		const engine = createChatEngine({
			tables: client.tables,
			deviceId,
		});
		console.log('[Background] Chat engine created');
		return engine;
	});

	// Handle chat messages from the side panel.
	// Registered synchronously (MV3 requirement) — awaits engine inside.
	browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message.type !== 'chat') return;

		// Return true to keep the sendResponse channel open for async work.
		// Without this, Chrome closes the message channel before we respond.
		void (async () => {
			try {
				const engine = await chatEnginePromise;
				const response = await engine.handleChatRequest(message as ChatRequest);
				sendResponse(response);
			} catch (error) {
				console.error('[Background] Chat request failed:', error);
				sendResponse({
					type: 'error',
					message: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		})();

		// Return true to indicate we will call sendResponse asynchronously
		return true;
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Browser Keepalive (Chrome MV3 only)
	// Chrome service workers go dormant after ~30 seconds of inactivity.
	// We use an offscreen document that sends runtime messages every 20 seconds,
	// keeping the WebSocket connection alive for real-time Y.Doc sync.
	// Firefox doesn't have this limitation (uses Event Pages, not service workers).
	//
	// NOTE: WebSocket messages from the server CANNOT wake a dormant service worker.
	// When dormant, the WebSocket connection is suspended/closed. Only Browser events
	// (alarms, tabs, runtime messages, etc.) can wake the worker.
	// ─────────────────────────────────────────────────────────────────────────

	if (import.meta.env.CHROME) {
		const ensureOffscreenDocument = async () => {
			if (await browser.offscreen.hasDocument()) return;
			await browser.offscreen.createDocument({
				url: 'offscreen.html',
				reasons: ['WORKERS'],
				justification:
					'Sends keepalive messages to prevent service worker dormancy',
			});
		};

		ensureOffscreenDocument();

		browser.runtime.onStartup.addListener(() => ensureOffscreenDocument());

		// Handle keepalive messages — receiving the message resets the
		// service worker's inactivity timer. No action needed.
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'keepalive') {
				// No-op: receiving the message is sufficient
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
		await whenReady;
		await actions
			.refetchAll()
			.then(() => console.log('[Background] onInstalled: refetch complete'))
			.catch((err) =>
				console.error('[Background] onInstalled: refetch failed:', err),
			);
	});

	browser.runtime.onStartup.addListener(async () => {
		console.log('[Background] onStartup: re-syncing...');
		await whenReady;
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
		const { deviceId } = await whenReady;
		await tryAsync({
			try: async () => {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(deviceId, tab);
				if (row) tables.tabs.set(row);
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
		const { deviceId } = await whenReady;
		await tryAsync({
			try: async () => {
				const win = await browser.windows.get(windowId);
				const row = windowToRow(deviceId, win);
				if (row) tables.windows.set(row);
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
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;

		// Track this tab as recently added to detect echoes in onAdd observer
		syncCoordination.recentlyAddedTabIds.add(row.tabId);
		// Remove after 5 seconds to prevent memory leaks
		setTimeout(() => {
			syncCoordination.recentlyAddedTabIds.delete(row.tabId);
		}, 5000);

		syncCoordination.refetchCount++;
		tables.tabs.set(row);
		syncCoordination.refetchCount--;
	});

	// onRemoved: Only tabId provided - delete directly
	browser.tabs.onRemoved.addListener(async (tabId) => {
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;
		syncCoordination.refetchCount++;
		tables.tabs.delete(createTabCompositeId(deviceId, tabId));
		syncCoordination.refetchCount--;
	});

	// onUpdated: Full Tab object provided (3rd arg)
	browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;

		syncCoordination.refetchCount++;
		tables.tabs.set(row);
		syncCoordination.refetchCount--;
	});

	// onMoved: Only tabId + moveInfo provided - need to query Browser
	browser.tabs.onMoved.addListener(async (tabId) => {
		await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;
		await setTabById(tabId);
		syncCoordination.refetchCount--;
	});

	// onActivated: Only activeInfo provided - need to query Browser
	// Note: We need to update BOTH the newly activated tab AND the previously active tab
	// in the same window (to set active: false on the old one)
	browser.tabs.onActivated.addListener(async (activeInfo) => {
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;

		const deviceWindowId = createWindowCompositeId(
			deviceId,
			activeInfo.windowId,
		);
		const deviceTabId = createTabCompositeId(deviceId, activeInfo.tabId);

		// Find and update the previously active tab in this window (set active: false)
		const previouslyActiveTabs = tables.tabs
			.filter((t) => t.windowId === deviceWindowId && t.active)
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
		await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;
		await setTabById(tabId);
		syncCoordination.refetchCount--;
	});

	// onDetached: Tab detached from window - need to query Browser
	browser.tabs.onDetached.addListener(async (tabId) => {
		await whenReady;
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
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;
		const row = windowToRow(deviceId, window);
		if (!row) return;

		syncCoordination.refetchCount++;
		tables.windows.set(row);
		syncCoordination.refetchCount--;
	});

	// onRemoved: Only windowId provided - delete directly
	browser.windows.onRemoved.addListener(async (windowId) => {
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;
		syncCoordination.refetchCount++;
		tables.windows.delete(createWindowCompositeId(deviceId, windowId));
		syncCoordination.refetchCount--;
	});

	// onFocusChanged: Only windowId provided - need to query Browser
	// Note: windowId can be WINDOW_ID_NONE (-1) when all windows lose focus
	// We need to update BOTH the newly focused window AND previously focused windows
	browser.windows.onFocusChanged.addListener(async (windowId) => {
		const { deviceId } = await whenReady;
		if (syncCoordination.yDocChangeCount > 0) return;

		syncCoordination.refetchCount++;

		const deviceWindowId = createWindowCompositeId(deviceId, windowId);

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
			const { deviceId } = await whenReady;
			if (syncCoordination.yDocChangeCount > 0) return;
			syncCoordination.refetchCount++;
			tables.tabGroups.set(tabGroupToRow(deviceId, group));
			syncCoordination.refetchCount--;
		});

		// onRemoved: Full TabGroup object provided
		browser.tabGroups.onRemoved.addListener(async (group) => {
			const { deviceId } = await whenReady;
			if (syncCoordination.yDocChangeCount > 0) return;
			syncCoordination.refetchCount++;
			tables.tabGroups.delete(createGroupCompositeId(deviceId, group.id));
			syncCoordination.refetchCount--;
		});

		// onUpdated: Full TabGroup object provided
		browser.tabGroups.onUpdated.addListener(async (group) => {
			const { deviceId } = await whenReady;
			if (syncCoordination.yDocChangeCount > 0) return;
			syncCoordination.refetchCount++;
			tables.tabGroups.set(tabGroupToRow(deviceId, group));
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
						const { deviceId } = await whenReady;

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
						const parsed = parseTabId(id as TabCompositeId);

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
						const { deviceId } = await whenReady;

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

						if (row.deviceId !== deviceId) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: different device',
								row.deviceId,
							);
							return;
						}

						if (!row.url) {
							console.log('[Background] tabs.onAdd SKIPPED: no URL in row');
							return;
						}

						if (syncCoordination.recentlyAddedTabIds.has(row.tabId)) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: tab was recently added locally (echo)',
								row.tabId,
							);
							return;
						}

						const existingTab = await tryAsync({
							try: () => browser.tabs.get(row.tabId),
							catch: () => Ok(undefined),
						});

						if (existingTab.data) {
							console.log(
								'[Background] tabs.onAdd SKIPPED: tab already exists in browser',
								row.tabId,
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
						const { deviceId } = await whenReady;

						if (transaction.origin === null) return;

						const parsed = parseWindowId(id as WindowCompositeId);

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
						const { deviceId } = await whenReady;

						if (transaction.origin === null) return;

						if (row.deviceId !== deviceId) return;

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
		client.tables.tabGroups.observe((changedIds, txn) => {
			const transaction = txn as Transaction;
			for (const id of changedIds) {
				const result = client.tables.tabGroups.get(id);
				if (result.status === 'not_found') {
					// Deleted
					void (async () => {
						const { deviceId } = await whenReady;

						if (transaction.origin === null) return;

						const parsed = parseGroupId(id as GroupCompositeId);

						if (!parsed || parsed.deviceId !== deviceId) return;

						syncCoordination.yDocChangeCount++;
						await tryAsync({
							try: async () => {
								const tabs = await browser.tabs.query({
									groupId: parsed.groupId,
								});
								const tabIds = tabs.flatMap((tab) =>
									tab.id !== undefined ? [tab.id] : [],
								);
								await Promise.allSettled(
									tabIds.map((id) => browser.tabs.ungroup(id)),
								);
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
