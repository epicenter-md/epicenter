/**
 * Reactive Fuji view preferences backed by URL search params.
 *
 * View mode, sort order, and search query live in the URL so they're
 * bookmarkable, shareable, and work with browser back/forward.
 * Default values are elided from the URL to keep it clean. `/` means
 * table view, sorted by date, no search.
 *
 * The entry collection and search helpers live in `entries-state.svelte.ts`.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';

const VIEW_MODES = ['table', 'timeline'] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const SORT_KEYS = [
	'date',
	'updatedAt',
	'createdAt',
	'title',
	'rating',
] as const;
type SortBy = (typeof SORT_KEYS)[number];

/** Defaults: elided from the URL to keep it clean. */
type SearchParams = {
	view: ViewMode;
	sort: SortBy;
	q: string;
};

const DEFAULTS = {
	view: 'table',
	sort: 'date',
	q: '',
} satisfies SearchParams;

/** Batch-update URL search params in a single navigation. */
function update(changes: Partial<SearchParams>) {
	const url = new URL(page.url);
	for (const [key, value] of Object.entries(changes)) {
		const def = DEFAULTS[key as keyof SearchParams];
		if (value === null || value === '' || value === def) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, String(value));
		}
	}
	goto(url, { replaceState: true, noScroll: true, keepFocus: true });
}

function createViewState() {
	return {
		get viewMode(): ViewMode {
			const raw = page.url.searchParams.get('view');
			return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : 'table';
		},

		/**
		 * Toggle between table and timeline view modes.
		 *
		 * Updates the `view` search param. Default ('table') is elided
		 * from the URL so `/` always means table view.
		 */
		toggleViewMode() {
			const next: ViewMode = this.viewMode === 'table' ? 'timeline' : 'table';
			update({ view: next });
		},

		get sortBy(): SortBy {
			const raw = page.url.searchParams.get('sort');
			return SORT_KEYS.includes(raw as SortBy) ? (raw as SortBy) : 'date';
		},

		/**
		 * Set the sort preference via the `sort` search param.
		 * Default ('date') is elided to keep URLs clean.
		 */
		set sortBy(value: SortBy) {
			update({ sort: value });
		},

		get searchQuery() {
			return page.url.searchParams.get('q') ?? '';
		},

		/** Update the search query via the `q` search param. Empty values are elided. */
		set searchQuery(value: string) {
			update({ q: value });
		},
	};
}

export const viewState = createViewState();
