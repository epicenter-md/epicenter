/**
 * Reactive view state for Honeycrisp.
 *
 * Manages navigation, selection, search, sort, and view mode. Cross-cutting
 * derivations (filteredNotes, folderName, selectedNote) live here because
 * they combine data from multiple domains.
 *
 * Uses a factory function pattern to encapsulate `$state`. Observers are
 * registered once during factory construction and never cleaned up (SPA
 * lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { viewState } from '$lib/state';
 * </script>
 *
 * {#each viewState.filteredNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current folder: {viewState.folderName}</p>
 * ```
 */

import { fromKv } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { FolderId, NoteId } from '$lib/workspace';
import { foldersState } from './folders.svelte';
import { notesState } from './notes.svelte';

function createViewState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	const selectedFolderId = fromKv(workspace.kv, 'selectedFolderId');
	const selectedNoteId = fromKv(workspace.kv, 'selectedNoteId');
	const sortBy = fromKv(workspace.kv, 'sortBy');
	let searchQuery = $state('');
	let isRecentlyDeletedView = $state(false);

	// ─── Derived State ───────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query. */
	const filteredNotes = $derived.by(() => {
		let result =
			selectedFolderId.current === null
				? notesState.notes
				: notesState.notes.filter(
						(n) => n.folderId === selectedFolderId.current,
					);
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(
				(n) =>
					n.title.toLowerCase().includes(q) ||
					n.preview.toLowerCase().includes(q),
			);
		}
		return [...result].sort((a, b) => {
			if (sortBy.current === 'title') return a.title.localeCompare(b.title);
			if (sortBy.current === 'dateCreated')
				return b.createdAt.localeCompare(a.createdAt);
			return b.updatedAt.localeCompare(a.updatedAt);
		});
	});

	/** Human-readable name for the current folder (used as NoteList title). */
	const folderName = $derived(
		selectedFolderId.current
			? (foldersState.folders.find((f) => f.id === selectedFolderId.current)
					?.name ?? 'Notes')
			: 'All Notes',
	);

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived(
		notesState.allNotes.find((n) => n.id === selectedNoteId.current) ?? null,
	);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get selectedFolderId() {
			return selectedFolderId.current;
		},
		get selectedNoteId() {
			return selectedNoteId.current;
		},
		get selectedNote() {
			return selectedNote;
		},
		get searchQuery() {
			return searchQuery;
		},
		get sortBy() {
			return sortBy.current;
		},
		get isRecentlyDeletedView() {
			return isRecentlyDeletedView;
		},
		get folderName() {
			return folderName;
		},
		get filteredNotes() {
			return filteredNotes;
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
		 * viewState.selectFolder(folderId);
		 *
		 * // Show all notes
		 * viewState.selectFolder(null);
		 * ```
		 */
		selectFolder(folderId: FolderId | null) {
			isRecentlyDeletedView = false;
			selectedFolderId.current = folderId;
			selectedNoteId.current = null;
		},

		/**
		 * Switch to the Recently Deleted view.
		 *
		 * Shows only soft-deleted notes. Clears the folder selection and note
		 * selection.
		 *
		 * @example
		 * ```typescript
		 * viewState.selectRecentlyDeleted();
		 * ```
		 */
		selectRecentlyDeleted() {
			isRecentlyDeletedView = true;
			selectedFolderId.current = null;
			selectedNoteId.current = null;
		},

		/**
		 * Select a note by ID to open it in the editor.
		 *
		 * @example
		 * ```typescript
		 * viewState.selectNote(noteId);
		 * ```
		 */
		selectNote(noteId: NoteId) {
			selectedNoteId.current = noteId;
		},

		/**
		 * Change the note sort order.
		 *
		 * Sorts the note list by the specified criteria. The sort preference
		 * is persisted to the workspace KV store.
		 *
		 * @example
		 * ```typescript
		 * viewState.setSortBy('title');
		 * viewState.setSortBy('dateEdited');
		 * ```
		 */
		setSortBy(value: 'dateEdited' | 'dateCreated' | 'title') {
			sortBy.current = value;
		},

		/**
		 * Update the search filter text.
		 *
		 * Filters the note list to show only notes whose title or preview
		 * contains the search query (case-insensitive). Pass an empty string
		 * to clear the search.
		 *
		 * @example
		 * ```typescript
		 * viewState.setSearchQuery('meeting');
		 * viewState.setSearchQuery(''); // clear
		 * ```
		 */
		setSearchQuery(query: string) {
			searchQuery = query;
		},
	};
}

export const viewState = createViewState();
