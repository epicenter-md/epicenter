/**
 * Reactive saved-tab state for the side panel.
 *
 * Reads go through `fromTable()`, which subscribes before it reads and then
 * re-reads only the rows an invalidation names (ADR-0187). Writes go through the
 * capability registry, so a button press and an agent tool call take the same
 * path.
 *
 * Saved tabs are durable whether or not anyone is signed in (ADR-0088); there is
 * no signed-in gate here.
 */

import { fromTable } from '@epicenter/svelte';
import type { TabManagerActions } from '$lib/actions';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { SavedTab, TabManagerData } from '$lib/workspace';

export function createSavedTabState({
	data,
	actions,
}: {
	data: TabManagerData;
	actions: TabManagerActions;
}) {
	const tabsView = fromTable(data.tables.savedTabs);

	/** All saved tabs, most recently saved first. */
	const tabs = $derived(
		tabsView.all.toSorted((left, right) =>
			right.savedAt.localeCompare(left.savedAt),
		),
	);

	return {
		get tabs() {
			return tabs;
		},

		/** Resolves once the first read of this table has landed. */
		whenReady: tabsView.whenReady,

		/**
		 * Save a tab: write the row, then close the browser tab. No-ops for a tab
		 * with no URL. The returned `closeResult` reports the close half only; the
		 * save itself already succeeded.
		 */
		async save(tab: BrowserTab) {
			if (!tab.url) return;
			return actions.saved_tabs_save({
				browserTabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned,
			});
		},

		/**
		 * Restore a saved tab: open it, then delete the row. The row survives a
		 * failed `tabs.create`, so the URL is never lost.
		 */
		async restore(savedTab: SavedTab) {
			return actions.saved_tabs_restore({
				id: savedTab.id,
				url: savedTab.url,
				pinned: savedTab.pinned,
			});
		},

		/** Restore every saved tab. Rows whose tab failed to open stay saved. */
		async restoreAll() {
			return actions.saved_tabs_restore_all();
		},

		/** Delete one saved tab without restoring it. */
		async remove(id: string) {
			return actions.saved_tabs_remove({ id });
		},

		/** Delete every saved tab without restoring them. */
		async removeAll() {
			return actions.saved_tabs_remove_all();
		},
	};
}

export type SavedTabState = ReturnType<typeof createSavedTabState>;
