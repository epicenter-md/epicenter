/**
 * Reactive view state for Honeycrisp, backed by URL search params.
 *
 * The lens the user is currently looking through. Owns navigation,
 * selection, search, view mode, and the derived "what notes does
 * the user see right now" question (`currentNotes` plus its title and
 * empty-state messaging).
 *
 * Navigation state lives in the URL so it's bookmarkable, shareable, and
 * works with browser back/forward. Default values are elided from the URL to
 * keep it clean: `/` means all defaults (all notes, no search). Transient
 * editor focus requests stay in memory.
 *
 * @example
 * ```svelte
 * <script>
 *   import { getHoneycrisp } from '$lib/honeycrisp/index.js';
 *   const honeycrisp = getHoneycrisp();
 * </script>
 *
 * {#each honeycrisp.view.currentNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current title: {honeycrisp.view.currentTitle}</p>
 * ```
 */

import type { FolderId, NoteId } from '@epicenter/honeycrisp';
import type { createFolders } from './folders.svelte.js';
import type { createNotes } from './notes.svelte.js';
import { searchParams } from './search-params.svelte.js';

export function createView({
	folders,
	notes,
}: {
	folders: ReturnType<typeof createFolders>;
	notes: ReturnType<typeof createNotes>;
}) {
	let editorFocusRequest = $state(0);

	// ─── Derived State ───────────────────────────────────────────────────

	// The one order notes appear in: newest edit first. There is no
	// user-selectable sort by decision; the earlier sort control was inert (the
	// list re-sorted by updatedAt regardless) and nobody noticed, so the
	// feature was deleted rather than repaired. This comparator is ordering's
	// single owner: the list component groups (pinned, date labels) without
	// ever re-sorting.
	const byRecentEdit = (
		a: { updatedAt: string },
		b: { updatedAt: string },
	): number => b.updatedAt.localeCompare(a.updatedAt);

	/** Notes filtered by selected folder and search query, newest edit first. */
	const filteredNotes = $derived.by(() => {
		const folderId = searchParams.folder;
		const q = searchParams.q.trim().toLowerCase();

		return notes.all
			.filter((n) => folderId === null || n.folderId === folderId)
			.filter((n) => {
				if (!q) return true;
				if (n.title.toLowerCase().includes(q)) return true;
				// The whole note, read out of its document. `preview` is a hundred
				// characters for a list subtitle, so searching it alone could not
				// find a word past the first line, and prose is not the row's to
				// carry (ADR-0207). It answers for a note whose document has not
				// arrived yet, which is what search could do before.
				return (notes.text(n.id) || n.preview).toLowerCase().includes(q);
			})
			.toSorted(byRecentEdit);
	});

	/** Human-readable name for the current folder. Feeds `currentTitle`. */
	const folderName = $derived.by(() => {
		const folderId = searchParams.folder;
		return folderId ? (folders.get(folderId)?.name ?? 'Notes') : 'All Notes';
	});

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived.by(() => {
		const noteId = searchParams.note;
		return noteId ? (notes.get(noteId) ?? null) : null;
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get selectedFolderId(): FolderId | null {
			return searchParams.folder;
		},
		get selectedNoteId(): NoteId | null {
			return searchParams.note;
		},
		get selectedNote() {
			return selectedNote;
		},
		get editorFocusRequest() {
			return editorFocusRequest;
		},
		get searchQuery() {
			return searchParams.q;
		},
		get isRecentlyDeletedView() {
			return searchParams.isDeletedView;
		},

		/**
		 * The list of notes the user currently sees: deleted notes when in
		 * Recently Deleted, otherwise the folder/search-filtered + sorted list.
		 */
		get currentNotes() {
			return searchParams.isDeletedView
				? notes.deleted.toSorted(byRecentEdit)
				: filteredNotes;
		},
		/** The header title for the current notes list. */
		get currentTitle(): string {
			return searchParams.isDeletedView ? 'Recently Deleted' : folderName;
		},
		/** Whether the new-note control should appear. Off in Recently Deleted. */
		get currentShowControls(): boolean {
			return !searchParams.isDeletedView;
		},
		/**
		 * The empty-state message for the current notes list.
		 *
		 * "No notes yet" is a claim about the person's history, and it is false
		 * when the list is empty because this release cannot INTERPRET what they
		 * wrote. A note written by a newer release, or by a workspace this one has
		 * since changed, reads as `Nonconforming` (ADR-0125); the row is intact
		 * and unreadable, which is a different thing from absent and deserves a
		 * different sentence.
		 */
		get currentEmptyMessage(): string {
			if (notes.nonconforming.length > 0) {
				const count = notes.nonconforming.length;
				return `${count} ${count === 1 ? 'note is' : 'notes are'} here but this version of Honeycrisp cannot read ${count === 1 ? 'it' : 'them'}. Nothing has been lost.`;
			}
			return searchParams.isDeletedView
				? 'No deleted notes'
				: 'No notes yet. Click + to create one.';
		},
		/** How many rows are stored but unreadable, for anything that wants to say so. */
		get unreadableCount(): number {
			return notes.nonconforming.length;
		},

		/**
		 * Select a folder and clear the note selection.
		 *
		 * Switches the view to show notes in the selected folder. If `null` is
		 * passed, shows all notes (unfiled + all folders). Also clears the
		 * Recently Deleted view if it was active.
		 *
		 * @example
		 * ```typescript
		 * honeycrisp.view.selectFolder(folderId);
		 *
		 * // Show all notes
		 * honeycrisp.view.selectFolder(null);
		 * ```
		 */
		selectFolder(folderId: FolderId | null) {
			searchParams.update({ view: null, note: null, folder: folderId });
		},

		/**
		 * Switch to the Recently Deleted view.
		 *
		 * Shows only soft-deleted notes. Clears the folder selection and note
		 * selection.
		 *
		 * @example
		 * ```typescript
		 * honeycrisp.view.selectRecentlyDeleted();
		 * ```
		 */
		selectRecentlyDeleted() {
			searchParams.update({ folder: null, note: null, view: 'deleted' });
		},

		/**
		 * Select a note by ID to open it in the editor.
		 *
		 * @example
		 * ```typescript
		 * honeycrisp.view.selectNote(noteId);
		 * ```
		 */
		selectNote(noteId: NoteId) {
			editorFocusRequest += 1;
			searchParams.update({ note: noteId });
		},

		/**
		 * Update the search filter text.
		 *
		 * Filters the note list to show only notes whose title or body contains
		 * the query (case-insensitive). Pass an empty string to clear it.
		 *
		 * Reading every note's prose is the cost of a query, and it is paid only
		 * while one is active: an empty query short-circuits before the body is
		 * ever touched, so typing inside a note never walks the vault. The prose
		 * is a type in the application's own document, so a walk is memory, not
		 * I/O.
		 *
		 * @example
		 * ```typescript
		 * honeycrisp.view.setSearchQuery('meeting');
		 * honeycrisp.view.setSearchQuery(''); // clear
		 * ```
		 */
		setSearchQuery(query: string) {
			searchParams.update({ q: query });
		},
	};
}
