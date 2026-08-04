/**
 * The reactive bookmark list, its bookmarked-URL index, and the one adapter that
 * turns a live Chrome tab into a bookmark.
 *
 * Same shape as saved tabs: `fromTable()` for reads (subscribe before read,
 * incremental re-read), and `actions.bookmarks_*` called directly for writes
 * that need no adaptation. Bookmarks are durable signed in or out (ADR-0088).
 */

import { fromTable } from '@epicenter/svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { TabManagerActions } from '$lib/actions';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { TabManagerData } from '$lib/workspace';

export function createBookmarkState({
	data,
	actions,
}: {
	data: TabManagerData;
	actions: TabManagerActions;
}) {
	const bookmarksView = fromTable(data.bookmarks);

	/** All bookmarks, most recently created first. */
	const bookmarks = $derived(
		bookmarksView.all.toSorted((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		),
	);

	/**
	 * Bookmarked URLs, as a `SvelteSet` so `.has()` is a tracked reactive read:
	 * safe to call once per row while rendering a list.
	 */
	const bookmarkedUrls = $derived(
		new SvelteSet(bookmarksView.all.map((bookmark) => bookmark.url)),
	);

	return {
		get bookmarks() {
			return bookmarks;
		},

		/** Resolves once the first read of this table has landed. */
		whenReady: bookmarksView.whenReady,

		/** Whether a URL is currently bookmarked. */
		isUrlBookmarked(url: string | undefined): boolean {
			if (!url) return false;
			return bookmarkedUrls.has(url);
		},

		/** Add a bookmark for a tab, or remove it if the URL is already bookmarked. */
		async toggle(tab: BrowserTab) {
			if (!tab.url) return;
			return actions.bookmarks_toggle({
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
			});
		},
	};
}

export type BookmarkState = ReturnType<typeof createBookmarkState>;
