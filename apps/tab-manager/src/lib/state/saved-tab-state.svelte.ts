/**
 * Reactive saved tab state for the popup.
 *
 * Backed by a Y.Doc CRDT table, so saved tabs sync across devices and
 * survive browser restarts. Unlike {@link browserState} which seeds from the
 * browser API and tracks ephemeral browser state, saved tabs are
 * persistent user data — a tab saved on your laptop appears on your
 * desktop automatically.
 *
 * Uses a plain `$state` array (not `SvelteMap`) because the access pattern is
 * always "render the full sorted list." There's no keyed lookup, no partial
 * mutation — the Y.Doc observer wholesale-replaces the array on every change,
 * which is the simplest reactive model for a list that's always read in full.
 *
 * Reactivity: The Y.Doc observer fires on persistence load AND on any
 * remote/local modification, so the UI stays in sync without polling.
 *
 * @example
 * ```svelte
 * <script>
 *   import { savedTabState } from '$lib/state/saved-tab-state.svelte';
 * </script>
 *
 * {#each savedTabState.tabs as tab (tab.id)}
 *   <SavedTabItem {tab} />
 * {/each}
 *
 * <button onclick={() => savedTabState.actions.restoreAll()}>
 *   Restore all
 * </button>
 * ```
 */

import { getDeviceId } from '$lib/device/device-id';
import {
	generateSavedTabId,
	type SavedTab,
	type SavedTabId,
	type Tab,
	workspaceClient,
} from '$lib/workspace';

function createSavedTabState() {
	/** Read all valid saved tabs, most recently saved first. */
	const readAll = () =>
		workspaceClient.tables.savedTabs
			.getAllValid()
			.sort((a, b) => b.savedAt - a.savedAt);

	/**
	 * The full sorted list of saved tabs.
	 *
	 * Wholesale-replaced on every Y.Doc change rather than surgically mutated.
	 * This is intentional — the Y.Doc observer doesn't tell us *what* changed,
	 * only *that* something changed, so a full re-read is the simplest correct
	 * approach. The list is small enough that this is never a perf concern.
	 */
	let tabs = $state<SavedTab[]>(readAll());

	// Re-read on every Y.Doc change — observer fires when persistence
	// loads and on any subsequent remote/local modification.
	const _unobserveSavedTabs = workspaceClient.tables.savedTabs.observe(() => {
		tabs = readAll();
	});

	return {
		/** All saved tabs, sorted by most recently saved first. */
		get tabs() {
			return tabs;
		},

		/**
		 * Actions that mutate saved tab state.
		 *
		 * All mutations go through the Y.Doc table, which fires the observer,
		 * which re-reads the full list into `tabs`. This keeps the mutation path
		 * unidirectional — components call actions, actions write to Y.Doc,
		 * Y.Doc observer updates the reactive array. No direct `tabs` mutation
		 * outside the observer.
		 */
		actions: {
			/**
			 * Save a tab — snapshot its metadata to Y.Doc and close the
			 * browser tab. The tab can be restored later on any synced device.
			 *
			 * Silently no-ops for tabs without a URL (e.g. `chrome://` pages
			 * that can't be re-opened via `browser.tabs.create`).
			 */
			async save(tab: Tab) {
				if (!tab.url) return;
				const deviceId = await getDeviceId();
				workspaceClient.tables.savedTabs.set({
					id: generateSavedTabId(),
					url: tab.url,
					title: tab.title || 'Untitled',
					favIconUrl: tab.favIconUrl,
					pinned: tab.pinned,
					sourceDeviceId: deviceId,
					savedAt: Date.now(),
					_v: 1,
				});
				await browser.tabs.remove(tab.tabId);
			},

			/**
			 * Restore a saved tab — re-open it in the browser and remove
			 * the record from Y.Doc. Preserves the tab's pinned state.
			 */
			async restore(savedTab: SavedTab) {
				await browser.tabs.create({
					url: savedTab.url,
					pinned: savedTab.pinned,
				});
				workspaceClient.tables.savedTabs.delete(savedTab.id);
			},

			/**
			 * Restore all saved tabs at once.
			 *
			 * Fires all `browser.tabs.create()` calls in parallel (no sequential
			 * awaiting) and batch-deletes from Y.Doc in a single transaction.
			 *
			 * This avoids two problems with the naive sequential approach:
			 * 1. **Popup teardown**: `browser.tabs.create()` shifts focus, which
			 *    can cause Chrome to destroy the popup mid-loop — killing the
			 *    async context and leaving remaining tabs un-restored.
			 * 2. **Observer spam**: Each individual `delete()` fires the Y.Doc
			 *    observer, triggering a full `readAll()`. Wrapping in `transact()`
			 *    collapses N observer callbacks into one.
			 */
			async restoreAll() {
				const all = workspaceClient.tables.savedTabs.getAllValid();
				if (!all.length) return;

				// Fire all tab creations without awaiting each one individually.
				// browser.tabs.create() sends IPC to the browser process immediately —
				// the tabs will be created even if the popup is torn down afterward.
				const createPromises = all.map((tab) =>
					browser.tabs.create({ url: tab.url, pinned: tab.pinned }),
				);

				// Batch-delete from Y.Doc in a single transaction so the observer
				// fires exactly once (not N times).
				workspaceClient.batch(() => {
					for (const tab of all) {
						workspaceClient.tables.savedTabs.delete(tab.id);
					}
				});

				// Best-effort await — popup may die before this resolves, which is
				// fine because the browser process is already creating the tabs.
				await Promise.allSettled(createPromises);
			},

			/** Delete a saved tab without restoring it. */
			remove(id: SavedTabId) {
				workspaceClient.tables.savedTabs.delete(id);
			},

			/**
			 * Delete all saved tabs without restoring them.
			 *
			 * Wrapped in a Y.Doc transaction so the observer fires once
			 * (not N times for N tabs).
			 */
			removeAll() {
				const all = workspaceClient.tables.savedTabs.getAllValid();
				if (!all.length) return;

				workspaceClient.batch(() => {
					for (const tab of all) {
						workspaceClient.tables.savedTabs.delete(tab.id);
					}
				});
			},

			/** Update a saved tab's metadata in Y.Doc. */
			update(savedTab: SavedTab) {
				workspaceClient.tables.savedTabs.set(savedTab);
			},
		},
	};
}

export const savedTabState = createSavedTabState();
