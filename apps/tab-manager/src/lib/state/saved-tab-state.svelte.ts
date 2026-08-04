/**
 * The reactive saved-tab list, plus the one adapter that turns a live Chrome tab
 * into a saved row.
 *
 * Reads go through `fromTable()`, which subscribes before it reads and then
 * re-reads only the rows an invalidation names (ADR-0187). Writes are not
 * re-exported here: a component calls `actions.saved_tabs_*` directly, so a
 * button press and an agent tool call take the same path with nothing in
 * between. `save` is the exception because it adapts a `BrowserTab` rather than
 * forwarding one.
 *
 * Saved tabs are durable whether or not anyone is signed in (ADR-0088); there is
 * no signed-in gate here.
 */

import { fromTable } from '@epicenter/svelte';
import type { TabManagerActions } from '$lib/actions';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { TabManagerData } from '$lib/workspace';

export function createSavedTabState({
	data,
	actions,
}: {
	data: TabManagerData;
	actions: TabManagerActions;
}) {
	const tabsView = fromTable(data.savedTabs);

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
	};
}

export type SavedTabState = ReturnType<typeof createSavedTabState>;
