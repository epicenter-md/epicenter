/**
 * Reactive browser state for the side panel.
 *
 * Seeds from `browser.windows.getAll({ populate: true })` and receives
 * surgical updates via browser event listeners. Uses a single coupled
 * `SvelteMap<WindowCompositeId, WindowState>` where each window owns its tabs.
 *
 * After seeding, also writes all browser state into Y.Doc tables for
 * cross-device sync. Each browser event handler writes to both:
 * - SvelteMap (reactive UI rendering)
 * - Y.Doc tables (cross-device sync via WebSocket)
 *
 * Y.Doc observers handle remote changes: when another device modifies the
 * Y.Doc (via WebSocket), the observer fires and calls Chrome APIs to
 * create/remove local tabs/windows/groups. Only remote-origin changes
 * trigger Chrome API calls — local writes are skipped via transaction origin.
 *
 * Lifecycle: Created when side panel opens. All listeners die when panel closes.
 * Next open → fresh seed + fresh listeners. No cleanup needed.
 *
 * @example
 * ```svelte
 * <script>
 *   import { browserState } from '$lib/state/browser-state.svelte';
 * </script>
 *
 * {#each browserState.windows as window (window.id)}
 *   {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
 *     <TabItem {tab} />
 *   {/each}
 * {/each}
 * ```
 */

import { SvelteMap } from 'svelte/reactivity';
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
	type GroupCompositeId,
	parseGroupId,
	parseTabId,
	parseWindowId,
	type Tab,
	type TabCompositeId,
	type Window,
	type WindowCompositeId,
	workspaceClient,
} from '$lib/workspace';

const { tables } = workspaceClient;

/**
 * A window and all the tabs it owns, stored together.
 *
 * Browser state is inherently hierarchical — tabs belong to windows. Storing
 * them as a coupled unit means every access pattern (render a window's tabs,
 * remove a window and its tabs, switch active tab within a window) is a direct
 * lookup instead of a filter-all-tabs scan.
 *
 * Each window gets its own inner `SvelteMap` for tabs. Svelte 5's reactivity
 * tracks each SvelteMap independently, so mutating one window's tabs only
 * re-renders that window's `{#each}` block — not every window.
 */
type WindowState = {
	window: Window;
	tabs: SvelteMap<number, Tab>;
};

function createBrowserState() {
	/**
	 * Single source of truth for all browser windows and tabs.
	 *
	 * Keyed by composite window ID so every lookup (by window, by tab's parent
	 * window) is O(1). The outer SvelteMap triggers reactivity when windows are
	 * added/removed; each inner SvelteMap triggers reactivity when that window's
	 * tabs change. This gives per-window reactive granularity for free.
	 */
	const windowStates = new SvelteMap<WindowCompositeId, WindowState>();

	/**
	 * Doubles as the readiness signal for event handlers.
	 *
	 * Set to a real value only AFTER the seed populates `windowStates`.
	 * Every event handler guards with `if (!deviceId) return`, which means
	 * events that arrive before the seed completes are silently dropped
	 * (they'd be stale anyway — the seed is the authoritative snapshot).
	 */
	let deviceId: DeviceId | null = null;

	/**
	 * Set of tab IDs that were recently added by local browser events.
	 * Used to detect echoes: if the Y.Doc observer fires for a tabId in this set,
	 * it's our own echo from a browser event, not a remote change.
	 */
	const recentlyAddedTabIds = new Set<number>();

	// ── Seed ─────────────────────────────────────────────────────────────
	// Single IPC call via `getAll({ populate: true })` returns windows with
	// their tabs already nested — a natural fit for our WindowState shape.
	//
	// deviceId is assigned LAST so that event handlers (which guard on
	// `!deviceId`) ignore any events that fire during this async window.
	// Those events would be redundant anyway — the seed is a complete snapshot.
	//
	// After seeding the SvelteMap, we also seed the Y.Doc tables for cross-device
	// sync. This runs a full diff against the existing Y.Doc rows to clean up
	// stale entries from previous sessions.

	const whenReady = (async () => {
		// Parallelize independent async operations
		const [browserWindows, id] = await Promise.all([
			browser.windows.getAll({ populate: true }),
			getDeviceId(),
		]);

		for (const win of browserWindows) {
			const windowRow = windowToRow(id, win);
			if (!windowRow) continue;

			const tabsMap = new SvelteMap<number, Tab>();
			if (win.tabs) {
				for (const tab of win.tabs) {
					const tabRow = tabToRow(id, tab);
					if (tabRow) {
						tabsMap.set(tabRow.tabId, tabRow);
					}
				}
			}

			windowStates.set(windowRow.id, { window: windowRow, tabs: tabsMap });
		}

		// ── Seed Y.Doc (refetchAll equivalent) ──────────────────────────
		// Wait for persistence to load before writing, so we don't get
		// overwritten when IndexedDB state is applied.
		await workspaceClient.whenReady;

		// Register device
		const existingDevice = tables.devices.get(id);
		const existingName =
			existingDevice.status === 'valid' ? existingDevice.row.name : null;
		tables.devices.set({
			id,
			name: existingName ?? (await generateDefaultDeviceName()),
			lastSeen: new Date().toISOString(),
			browser: getBrowserName(),
			_v: 1,
		});

		// Reuse already-fetched window data for Y.Doc seed
		const windowRows = browserWindows.flatMap((win) => {
			const row = windowToRow(id, win);
			return row ? [row] : [];
		});
		const windowIdSet = new Set(windowRows.map((r) => r.windowId));
		const existingYDocWindows = tables.windows.getAllValid();

		// Reuse already-fetched tab data for Y.Doc seed (flatten from populated windows)
		const tabRows = browserWindows.flatMap((win) =>
			(win.tabs ?? []).flatMap((tab) => {
				const row = tabToRow(id, tab);
				return row ? [row] : [];
			}),
		);
		const tabIdSet = new Set(tabRows.map((r) => r.tabId));
		const existingYDocTabs = tables.tabs.getAllValid();

		// Fetch tab groups (Chrome only) — no cached data available
		const allBrowserGroups = browser.tabGroups
			? await browser.tabGroups.query({})
			: [];
		const groupIdSet = new Set(allBrowserGroups.map((g) => g.id));
		const existingYDocGroups = tables.tabGroups.getAllValid();

		// Single batch for all Y.Doc seed writes
		workspaceClient.batch(() => {
			// Windows
			for (const row of windowRows) {
				tables.windows.set(row);
			}
			for (const existing of existingYDocWindows) {
				if (existing.deviceId !== id) continue;
				if (!windowIdSet.has(existing.windowId)) {
					tables.windows.delete(existing.id);
					continue;
				}
				const expectedId = createWindowCompositeId(id, existing.windowId);
				if (existing.id !== expectedId) {
					tables.windows.delete(existing.id);
				}
			}

			// Tabs
			for (const row of tabRows) {
				tables.tabs.set(row);
			}
			for (const existing of existingYDocTabs) {
				if (existing.deviceId !== id) continue;
				if (!tabIdSet.has(existing.tabId)) {
					tables.tabs.delete(existing.id);
					continue;
				}
				const expectedId = createTabCompositeId(id, existing.tabId);
				if (existing.id !== expectedId) {
					tables.tabs.delete(existing.id);
				}
			}

			// Tab groups (Chrome only)
			for (const group of allBrowserGroups) {
				tables.tabGroups.set(tabGroupToRow(id, group));
			}
			for (const existing of existingYDocGroups) {
				if (existing.deviceId !== id) continue;
				if (!groupIdSet.has(existing.groupId)) {
					tables.tabGroups.delete(existing.id);
					continue;
				}
				const expectedId = createGroupCompositeId(id, existing.groupId);
				if (existing.id !== expectedId) {
					tables.tabGroups.delete(existing.id);
				}
			}
		});

		// Set deviceId LAST — after both SvelteMap and Y.Doc are seeded.
		// Event handlers guard with `if (!deviceId) return`, so any browser
		// events that fire during the async seed are safely dropped.
		deviceId = id;

		console.log('[SidePanel] Seeded browser state + Y.Doc:', {
			tabs: tables.tabs.getAllValid().length,
			windows: tables.windows.getAllValid().length,
			tabGroups: tables.tabGroups.getAllValid().length,
		});
	})();

	// ── Tab Event Listeners ───────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener((tab) => {
		if (!deviceId) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;
		const state = windowStates.get(row.windowId);
		if (!state) return;
		state.tabs.set(row.tabId, row);

		// Y.Doc write
		tables.tabs.set(row);

		// Track to detect echoes in Y.Doc observer
		recentlyAddedTabIds.add(row.tabId);
		setTimeout(() => recentlyAddedTabIds.delete(row.tabId), 5000);
	});

	// onRemoved: Use removeInfo.windowId for a direct window lookup instead
	// of scanning all tabs. When isWindowClosing is true, the window's
	// onRemoved handler will delete the entire WindowState (and all its tabs
	// with it), so per-tab cleanup is unnecessary.
	browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
		if (!deviceId) return;
		if (removeInfo.isWindowClosing) return;
		const compositeId = createWindowCompositeId(deviceId, removeInfo.windowId);
		windowStates.get(compositeId)?.tabs.delete(tabId);

		// Y.Doc write
		tables.tabs.delete(createTabCompositeId(deviceId, tabId));
	});

	// onUpdated: Full Tab in 3rd arg — route to correct window
	browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		if (!deviceId) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;
		const state = windowStates.get(row.windowId);
		if (!state) return;
		state.tabs.set(row.tabId, row);

		// Y.Doc write
		tables.tabs.set(row);
	});

	// onMoved: Re-query tab to get updated index
	browser.tabs.onMoved.addListener(async (tabId) => {
		if (!deviceId) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			const state = windowStates.get(row.windowId);
			if (!state) return;
			state.tabs.set(row.tabId, row);

			// Y.Doc write
			tables.tabs.set(row);
		} catch {
			// Tab may have been closed during move
		}
	});

	// onActivated: Only scans the affected window's tabs (not all tabs across
	// all windows) to flip the active flag. This is the main perf win of the
	// coupled structure — a 50-tab window with 5 other windows only iterates 50
	// tabs, not 300.
	browser.tabs.onActivated.addListener((activeInfo) => {
		if (!deviceId) return;
		const compositeId = createWindowCompositeId(deviceId, activeInfo.windowId);
		const state = windowStates.get(compositeId);
		if (!state) return;

		workspaceClient.batch(() => {
			// Deactivate previous active tab(s) in this window only
			for (const [tabId, tab] of state.tabs) {
				if (tab.active) {
					const updated = { ...tab, active: false };
					state.tabs.set(tabId, updated);
					tables.tabs.set(updated);
				}
			}

			// Activate the new tab
			const tab = state.tabs.get(activeInfo.tabId);
			if (tab) {
				const updated = { ...tab, active: true };
				state.tabs.set(activeInfo.tabId, updated);
				tables.tabs.set(updated);
			}
		});
	});

	// ── Attach / Detach ──────────────────────────────────────────────────
	// Moving a tab between windows fires two events in order:
	//   1. onDetached (old window) — we remove the tab from the old window's map
	//   2. onAttached (new window) — we re-query the tab and add it to the new
	//      window's map (re-query is needed to get the updated windowId + index)
	//
	// Between detach and attach, the tab exists in neither window. This is fine
	// because the side panel doesn't render mid-event-dispatch.

	browser.tabs.onAttached.addListener(async (tabId) => {
		if (!deviceId) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			const state = windowStates.get(row.windowId);
			if (!state) return;
			state.tabs.set(row.tabId, row);

			// Y.Doc write
			tables.tabs.set(row);
		} catch {
			// Tab may have been closed
		}
	});

	browser.tabs.onDetached.addListener((tabId, detachInfo) => {
		if (!deviceId) return;
		const compositeId = createWindowCompositeId(
			deviceId,
			detachInfo.oldWindowId,
		);
		windowStates.get(compositeId)?.tabs.delete(tabId);

		// Y.Doc: tab will be updated by onAttached with new windowId
	});

	// ── Window Event Listeners ────────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener((window) => {
		if (!deviceId) return;
		const row = windowToRow(deviceId, window);
		if (!row) return;
		windowStates.set(row.id, { window: row, tabs: new SvelteMap() });

		// Y.Doc write
		tables.windows.set(row);
	});

	// onRemoved: Deleting the WindowState entry removes the window AND all its
	// tabs in one operation — no orphan cleanup needed.
	browser.windows.onRemoved.addListener((windowId) => {
		if (!deviceId) return;
		const currentDeviceId = deviceId; // Capture narrowed value for closure
		const compositeId = createWindowCompositeId(currentDeviceId, windowId);

		// Delete tabs belonging to this window from Y.Doc before removing from SvelteMap
		const state = windowStates.get(compositeId);
		if (state) {
			workspaceClient.batch(() => {
				for (const [tabId] of state.tabs) {
					tables.tabs.delete(createTabCompositeId(currentDeviceId, tabId));
				}
				tables.windows.delete(compositeId);
			});
		}

		windowStates.delete(compositeId);
	});

	// onFocusChanged: We call `windowStates.set()` (not just mutate the
	// window object in place) because the `window` property is a plain object,
	// not wrapped in $state. Calling `.set()` on the outer SvelteMap bumps its
	// version signal, which notifies the `windows` getter's consumers.
	browser.windows.onFocusChanged.addListener((windowId) => {
		if (!deviceId) return;

		workspaceClient.batch(() => {
			for (const [id, state] of windowStates) {
				if (state.window.focused) {
					const updated = { ...state.window, focused: false };
					windowStates.set(id, { ...state, window: updated });
					tables.windows.set(updated);
				}
			}

			// WINDOW_ID_NONE means all windows lost focus (e.g. user clicked desktop)
			if (windowId !== browser.windows.WINDOW_ID_NONE) {
				const compositeId = createWindowCompositeId(deviceId, windowId);
				const state = windowStates.get(compositeId);
				if (state) {
					const updated = { ...state.window, focused: true };
					windowStates.set(compositeId, { ...state, window: updated });
					tables.windows.set(updated);
				}
			}
		});
	});

	// ── Tab Group Event Listeners (Chrome only) ──────────────────────────

	if (browser.tabGroups) {
		browser.tabGroups.onCreated.addListener((group) => {
			if (!deviceId) return;
			tables.tabGroups.set(tabGroupToRow(deviceId, group));
		});

		browser.tabGroups.onRemoved.addListener((group) => {
			if (!deviceId) return;
			const compositeId = createGroupCompositeId(deviceId, group.id);
			if (compositeId) tables.tabGroups.delete(compositeId);
		});

		browser.tabGroups.onUpdated.addListener((group) => {
			if (!deviceId) return;
			tables.tabGroups.set(tabGroupToRow(deviceId, group));
		});
	}

	// ── Y.Doc Observers — handle remote changes ─────────────────────────
	// These fire when another device modifies the Y.Doc via WebSocket sync.
	// Only remote-origin changes (transaction.origin !== null) trigger Chrome
	// API calls. Local writes (origin === null) are our own → skip.

	const _unobserveTabs = tables.tabs.observe((changedIds, transaction) => {
		for (const id of changedIds) {
			const result = tables.tabs.get(id);
			switch (result.status) {
				case 'not_found':
					// Tab deleted remotely → remove from browser
					void (async () => {
						if (transaction.origin === null) return;
						if (!deviceId) return;
						const parsed = parseTabId(id);
						if (!parsed || parsed.deviceId !== deviceId) return;

						try {
							await browser.tabs.remove(parsed.tabId);
						} catch {
							// Tab may already be closed
						}
					})();
					break;
				case 'valid': {
					const row = result.row;
					void (async () => {
						if (transaction.origin === null) return;
						if (!deviceId) return;
						if (row.deviceId !== deviceId) return;
						if (!row.url) return;
						if (recentlyAddedTabIds.has(row.tabId)) return;

						try {
							await browser.tabs.get(row.tabId);
							return; // Tab already exists
						} catch {
							// Tab doesn't exist — create it
						}

						try {
							await browser.tabs.create({ url: row.url });
						} catch {
							// Failed to create tab
						}
					})();
					break;
				}
			}
		}
	});

	const _unobserveWindows = tables.windows.observe((changedIds, transaction) => {
		for (const id of changedIds) {
			const result = tables.windows.get(id);
			switch (result.status) {
				case 'not_found':
					void (async () => {
						if (transaction.origin === null) return;
						if (!deviceId) return;
						const parsed = parseWindowId(id);
						if (!parsed || parsed.deviceId !== deviceId) return;

						try {
							await browser.windows.remove(parsed.windowId);
						} catch {
							// Window may already be closed
						}
					})();
					break;
				case 'valid': {
					const row = result.row;
					void (async () => {
						if (transaction.origin === null) return;
						if (!deviceId) return;
						if (row.deviceId !== deviceId) return;

						// Check if this window already exists — skip updates, only create new
						try {
							await browser.windows.get(row.windowId);
							return; // Window exists, this is an update not a create
						} catch {
							// Window doesn't exist — create it
						}

						try {
							await browser.windows.create({});
						} catch {
							// Failed to create window
						}
					})();
					break;
				}
			}
		}
	});

	if (browser.tabGroups) {
		const _unobserveTabGroups = tables.tabGroups.observe((changedIds, transaction) => {
			for (const id of changedIds) {
				const result = tables.tabGroups.get(id);
				if (result.status === 'not_found') {
					void (async () => {
						if (transaction.origin === null) return;
						if (!deviceId) return;
						const parsed = parseGroupId(id);
						if (!parsed || parsed.deviceId !== deviceId) return;

						try {
							const groupTabs = await browser.tabs.query({
								groupId: parsed.groupId,
							});
							const tabIds = groupTabs.flatMap((tab) =>
								tab.id !== undefined ? [tab.id] : [],
							);
							await Promise.allSettled(
								tabIds.map((tid) => browser.tabs.ungroup(tid)),
							);
						} catch {
							// Failed to ungroup tabs
						}
					})();
				}
			}
		});
	}

	return {
		/**
		 * Resolves after the initial browser state seed completes.
		 *
		 * Use this to gate UI rendering so child components can safely read
		 * `windows` and `tabsByWindow` synchronously at construction time.
		 *
		 * @example
		 * ```svelte
		 * {#await browserState.whenReady}
		 *   <LoadingSpinner />
		 * {:then}
		 *   <UnifiedTabList />
		 * {/await}
		 * ```
		 */
		whenReady,

		/** All browser windows. */
		get windows() {
			return [...windowStates.values()].map((s) => s.window);
		},

		/**
		 * Get tabs for a specific window, sorted by tab strip index.
		 *
		 * @example
		 * ```svelte
		 * {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
		 *   <TabItem {tab} />
		 * {/each}
		 * ```
		 */
		tabsByWindow(windowId: WindowCompositeId): Tab[] {
			const state = windowStates.get(windowId);
			if (!state) return [];
			return [...state.tabs.values()].sort((a, b) => a.index - b.index);
		},

		/**
		 * Browser API calls that trigger state changes indirectly.
		 *
		 * None of these mutate `windowStates` directly — they call the browser
		 * API, which fires an event (e.g. `onRemoved`, `onUpdated`), and the
		 * event listener above handles the state update. This keeps mutation
		 * in one place (the listeners) and makes actions safe to call from
		 * any component without worrying about state consistency.
		 */
		actions: {
			/** Close a tab. Browser onRemoved event updates state. */
			async close(tabId: number) {
				await browser.tabs.remove(tabId);
			},

			/** Activate a tab and focus its window. */
			async activate(tabId: number) {
				const tab = await browser.tabs.update(tabId, { active: true });
				if (tab?.windowId) {
					await browser.windows.update(tab.windowId, { focused: true });
				}
			},

			/** Pin a tab. */
			async pin(tabId: number) {
				await browser.tabs.update(tabId, { pinned: true });
			},

			/** Unpin a tab. */
			async unpin(tabId: number) {
				await browser.tabs.update(tabId, { pinned: false });
			},

			/** Mute a tab. */
			async mute(tabId: number) {
				await browser.tabs.update(tabId, { muted: true });
			},

			/** Unmute a tab. */
			async unmute(tabId: number) {
				await browser.tabs.update(tabId, { muted: false });
			},

			/** Reload a tab. */
			async reload(tabId: number) {
				await browser.tabs.reload(tabId);
			},

			/** Duplicate a tab. */
			async duplicate(tabId: number) {
				await browser.tabs.duplicate(tabId);
			},
		},
	};
}

export const browserState = createBrowserState();
