/**
 * Typed URL search param state for Honeycrisp.
 *
 * The URL is the single source of truth for view preferences. This module
 * defines the complete param schema, provides reactive getters (via
 * `page.url.searchParams`), and a batch `update()` that writes all changes
 * in a single `goto()` call.
 *
 * Defaults are elided from the URL to keep it clean: `/` means all defaults
 * (all notes, no search, no deleted view).
 *
 * @example
 * ```typescript
 * import { searchParams } from './search-params.svelte.js';
 *
 * // Read (reactive, tracked by $derived automatically)
 * const folder = searchParams.folder;
 * const note = searchParams.note;
 *
 * // Write (atomic, one goto() regardless of how many params change)
 * searchParams.update({ view: null, note: null, folder: folderId });
 * ```
 */

import type { FolderId, NoteId } from '@epicenter/honeycrisp';
import { goto } from '$app/navigation';
import { page } from '$app/state';

/**
 * The complete URL state schema for Honeycrisp.
 *
 * Every search param the app uses, its TypeScript type, and its default value.
 * Adding a param here is the only step needed: getters and update() pick it up
 * automatically. Typos in `update({ foler: ... })` are compile-time errors.
 */
type SearchParams = {
	folder: FolderId | null;
	note: NoteId | null;
	view: 'deleted' | null;
	q: string;
};

/** Values that get elided from the URL. Presence in the URL means non-default. */
const DEFAULTS = {
	folder: null,
	note: null,
	view: null,
	q: '',
} satisfies SearchParams;

function createSearchParams() {
	/**
	 * Batch-update URL search params in a single navigation.
	 *
	 * Clones the current URL, applies all changes, elides defaults, then
	 * navigates once. No history entry, no scroll jump, no focus loss.
	 *
	 * @example
	 * ```typescript
	 * // Atomic: one goto(), not three separate calls
	 * searchParams.update({ view: null, note: null, folder: folderId });
	 *
	 * // Single param is fine too
	 * searchParams.update({ note: noteId });
	 * ```
	 */
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

	return {
		/** Currently selected folder, or `null` for "All Notes". */
		get folder(): FolderId | null {
			return page.url.searchParams.get('folder');
		},

		/** Currently selected note, or `null` for no selection. */
		get note(): NoteId | null {
			return page.url.searchParams.get('note');
		},

		/** Whether the Recently Deleted view is active. */
		get isDeletedView(): boolean {
			return page.url.searchParams.get('view') === 'deleted';
		},

		/** Current search query. Defaults to `''` when absent from URL. */
		get q(): string {
			return page.url.searchParams.get('q') ?? '';
		},

		update,
	};
}

export const searchParams = createSearchParams();
