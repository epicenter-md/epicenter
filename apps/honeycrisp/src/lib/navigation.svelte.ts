/**
 * Where the user is looking, held in the URL.
 *
 * The URL is the single source of truth for navigation, so it is bookmarkable,
 * shareable, and works with browser back and forward. Defaults are elided to
 * keep it clean: `/` means all notes, no search, no deleted view.
 *
 * A module singleton rather than something the application object provides, and
 * that is honest rather than lazy: the browser URL is genuinely one global
 * thing, `page.url` is already a module import, and routing it through
 * per-generation context bought nothing. Selecting a note is not a fact about
 * which document is open.
 *
 * The surface is six named transitions and no raw writer. Every param change in
 * the app goes through one of them, which is what keeps the "clearing a folder
 * also clears the note" rules in one readable place instead of spread across
 * the call sites that happen to know them.
 *
 * @example
 * ```svelte
 * <script>
 *   import { navigation } from '$lib/navigation.svelte.js';
 * </script>
 * <button onclick={() => navigation.selectFolder(null)}>All Notes</button>
 * ```
 */

import type { FolderId, NoteId } from '@epicenter/honeycrisp';
import { goto } from '$app/navigation';
import { page } from '$app/state';

/**
 * The complete URL state schema for Honeycrisp.
 *
 * Every search param the app uses, its TypeScript type, and its default value.
 * Adding a param here is the only step needed: the transitions below pick it up
 * automatically, and a typo in `write({ foler: ... })` is a compile-time error.
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

/**
 * Batch-write URL search params in a single navigation.
 *
 * Clones the current URL, applies all changes, elides defaults, then navigates
 * once. No history entry, no scroll jump, no focus loss. Private: the exported
 * transitions are the whole writable surface, so no caller has to remember
 * which params clear together.
 */
function write(changes: Partial<SearchParams>): void {
	const url = new URL(page.url);
	for (const [key, value] of Object.entries(changes)) {
		const fallback = DEFAULTS[key as keyof SearchParams];
		if (value === null || value === '' || value === fallback) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, String(value));
		}
	}
	goto(url, { replaceState: true, noScroll: true, keepFocus: true });
}

function createNavigation() {
	// Not in the URL, because it is a request rather than a place: "put the
	// caret in the editor now". The note pane is keyed on the note id, so it
	// remounts and focuses on its own whenever the selection changes; this
	// counter is what makes re-selecting the note already open focus it again.
	let editorFocusRequest = $state(0);

	const folderId = (): FolderId | null => page.url.searchParams.get('folder');
	const noteId = (): NoteId | null => page.url.searchParams.get('note');

	return {
		/** Currently selected folder, or `null` for "All Notes". */
		get folderId(): FolderId | null {
			return folderId();
		},

		/** Currently selected note, or `null` for no selection. */
		get noteId(): NoteId | null {
			return noteId();
		},

		/** Whether the Recently Deleted view is active. */
		get isDeletedView(): boolean {
			return page.url.searchParams.get('view') === 'deleted';
		},

		/** Current search query. Empty string when absent from the URL. */
		get query(): string {
			return page.url.searchParams.get('q') ?? '';
		},

		/** Bumped every time a note is selected, including the one already open. */
		get editorFocusRequest(): number {
			return editorFocusRequest;
		},

		/**
		 * Show a folder's notes, or every note when passed `null`. Leaves
		 * Recently Deleted and drops the note selection, because the note that
		 * was open is usually not in the folder being opened.
		 */
		selectFolder(folderId: FolderId | null): void {
			write({ view: null, note: null, folder: folderId });
		},

		/** Show soft-deleted notes only. Leaves the folder and note selection. */
		selectRecentlyDeleted(): void {
			write({ folder: null, note: null, view: 'deleted' });
		},

		/** Open a note in the editor and put the caret in it. */
		selectNote(noteId: NoteId): void {
			editorFocusRequest += 1;
			write({ note: noteId });
		},

		/**
		 * Filter the list by title or body text. Empty string clears it.
		 *
		 * A plain param write: reading every note's prose is the cost of an
		 * active query and it is paid by the filter, not prepaid by a sweep here.
		 */
		setQuery(query: string): void {
			write({ q: query });
		},

		/** This note is gone. Stop pointing at it, if we were. */
		noteRemoved(removed: NoteId): void {
			if (noteId() === removed) write({ note: null });
		},

		/** This folder is gone. Stop pointing at it, and at whatever was open in it. */
		folderRemoved(removed: FolderId): void {
			if (folderId() === removed) write({ folder: null, note: null });
		},
	};
}

export const navigation = createNavigation();
