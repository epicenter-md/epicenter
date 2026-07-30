/**
 * Reactive bookmark state for the side panel.
 *
 * Same shape as saved tabs: `fromTable()` for reads (subscribe before read,
 * incremental re-read), the capability registry for writes. Bookmarks are
 * durable signed in or out (ADR-0088).
 */

import { fromTable } from '@epicenter/svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { TabManagerActions } from '$lib/actions';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { Bookmark, TabManagerData } from '$lib/workspace';

export function createBookmarkState({
	data,
	actions,
}: {
	data: TabManagerData;
	actions: TabManagerActions;
}) {
	const bookmarksView = fromTable(data.tables.bookmarks);

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

		/** Open a bookmark in a new tab. The bookmark stays. */
		async open(bookmark: Bookmark) {
			return actions.bookmarks_open({ url: bookmark.url });
		},

		/** Delete one bookmark. */
		async remove(id: string) {
			return actions.bookmarks_remove({ id });
		},

		/** Delete every bookmark. */
		async removeAll() {
			return actions.bookmarks_remove_all();
		},
	};
}

export type BookmarkState = ReturnType<typeof createBookmarkState>;
