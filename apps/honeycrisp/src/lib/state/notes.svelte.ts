/**
 * Reactive notes state for Honeycrisp.
 *
 * Backed by a Y.Doc CRDT table, so notes sync across devices. Uses a
 * factory function pattern to encapsulate `$state` — Svelte 5 doesn't
 * allow exporting reassigned `$state` from modules.
 *
 * Uses a plain `$state` array (not `SvelteMap`) because the access pattern
 * is always "render the full sorted list." There's no keyed lookup, no
 * partial mutation — the Y.Doc observer wholesale-replaces the array on
 * every change, which is the simplest reactive model for a list that's
 * always read in full.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime). Same pattern as tab-manager's
 * `saved-tab-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { notesState } from '$lib/state/notes.svelte';
 * </script>
 *
 * {#each notesState.notes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <button onclick={() => notesState.createNote()}>New Note</button>
 * ```
 */

import { dateTimeStringNow, generateId } from '@epicenter/workspace';
import workspaceClient, {
	type Folder,
	type FolderId,
	type Note,
	type NoteId,
} from '$lib/workspace';

function createNotesState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	/** Read all valid folders, used as initial seed + observer refresh. */
	const readFolders = () => workspaceClient.tables.folders.getAllValid();

	/** Read all valid notes (including deleted), used as initial seed + observer refresh. */
	const readNotes = () => workspaceClient.tables.notes.getAllValid();

	let folders = $state<Folder[]>(readFolders());
	let allNotes = $state<Note[]>(readNotes());

	let selectedFolderId = $state<FolderId | null>(
		workspaceClient.kv.get('selectedFolderId'),
	);
	let selectedNoteId = $state<NoteId | null>(
		workspaceClient.kv.get('selectedNoteId'),
	);
	let sortBy = $state<'dateEdited' | 'dateCreated' | 'title'>(
		workspaceClient.kv.get('sortBy'),
	);
	let searchQuery = $state('');
	let isRecentlyDeletedView = $state(false);

	// ─── Workspace Observers ─────────────────────────────────────────────

	// Observers fire on Y.Doc changes (local + remote). They wholesale-replace
	// the $state arrays — same pattern as tab-manager's saved-tab-state.

	const _unobserveFolders = workspaceClient.tables.folders.observe(() => {
		folders = readFolders();
	});

	const _unobserveNotes = workspaceClient.tables.notes.observe(() => {
		allNotes = readNotes();
	});

	const _unobserveSelectedFolder = workspaceClient.kv.observe('selectedFolderId', (change) => {
		selectedFolderId = change.type === 'set' ? change.value : null;
	});

	const _unobserveSelectedNote = workspaceClient.kv.observe('selectedNoteId', (change) => {
		selectedNoteId = change.type === 'set' ? change.value : null;
	});

	const _unobserveSortBy = workspaceClient.kv.observe('sortBy', (change) => {
		sortBy = change.type === 'set' ? change.value : 'dateEdited';
	});

	// ─── Derived State ───────────────────────────────────────────────────

	/** Active notes — not soft-deleted. */
	const notes = $derived(allNotes.filter((n) => n.deletedAt === undefined));

	/** Soft-deleted notes for the Recently Deleted view. */
	const deletedNotes = $derived(
		allNotes.filter((n) => n.deletedAt !== undefined),
	);

	/** Notes filtered by selected folder and search query. */
	const filteredNotes = $derived.by(() => {
		let result =
			selectedFolderId === null
				? notes
				: notes.filter((n) => n.folderId === selectedFolderId);
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(
				(n) =>
					n.title.toLowerCase().includes(q) ||
					n.preview.toLowerCase().includes(q),
			);
		}
		return [...result].sort((a, b) => {
			if (sortBy === 'title') return a.title.localeCompare(b.title);
			if (sortBy === 'dateCreated')
				return b.createdAt.localeCompare(a.createdAt);
			return b.updatedAt.localeCompare(a.updatedAt);
		});
	});

	/** Per-folder note counts for the sidebar (active notes only). */
	const noteCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of notes) {
			if (note.folderId) {
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
			}
		}
		return counts;
	});

	/** Human-readable name for the current view (sidebar + NoteList header). */
	const folderName = $derived(
		isRecentlyDeletedView
			? 'Recently Deleted'
			: selectedFolderId
				? (folders.find((f) => f.id === selectedFolderId)?.name ?? 'Notes')
				: 'All Notes',
	);

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived(
		allNotes.find((n) => n.id === selectedNoteId) ?? null,
	);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		// State (read-only via getters)
		get folders() {
			return folders;
		},
		get allNotes() {
			return allNotes;
		},
		get notes() {
			return notes;
		},
		get deletedNotes() {
			return deletedNotes;
		},
		get filteredNotes() {
			return filteredNotes;
		},
		get noteCounts() {
			return noteCounts;
		},
		get selectedFolderId() {
			return selectedFolderId;
		},
		get selectedNoteId() {
			return selectedNoteId;
		},
		get selectedNote() {
			return selectedNote;
		},
		get searchQuery() {
			return searchQuery;
		},
		get sortBy() {
			return sortBy;
		},
		get isRecentlyDeletedView() {
			return isRecentlyDeletedView;
		},
		get folderName() {
			return folderName;
		},

		// Actions

		/**
		 * Create a new folder with the default name "New Folder".
		 *
		 * The folder is added to the end of the folder list and can be renamed
		 * immediately. Use this when the user clicks "New Folder" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * // Create a new folder
		 * notesState.createFolder();
		 * // Folder appears in sidebar with name "New Folder"
		 * ```
		 */
		createFolder() {
			const id = generateId() as string as FolderId;
			workspaceClient.tables.folders.set({
				id,
				name: 'New Folder',
				sortOrder: folders.length,
				_v: 1,
			});
		},

		/**
		 * Rename an existing folder.
		 *
		 * Updates the folder name in the sidebar and all references. The folder
		 * must exist; if it doesn't, the update is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * // Rename a folder to "Work"
		 * notesState.renameFolder(folderId, 'Work');
		 * // Sidebar updates immediately
		 * ```
		 */
		renameFolder(folderId: FolderId, name: string) {
			workspaceClient.tables.folders.update(folderId, { name });
		},

		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * The folder is removed from the sidebar. All notes that were in this
		 * folder are moved to the unfiled section (folderId set to undefined).
		 * If the deleted folder was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * // Delete a folder and move its notes to unfiled
		 * notesState.deleteFolder(folderId);
		 * // Folder disappears from sidebar, its notes move to "All Notes"
		 * ```
		 */
		deleteFolder(folderId: FolderId) {
			const folderNotes = allNotes.filter((n) => n.folderId === folderId);
			for (const note of folderNotes) {
				workspaceClient.tables.notes.update(note.id, {
					folderId: undefined,
				});
			}
			workspaceClient.tables.folders.delete(folderId);
			if (selectedFolderId === folderId) {
				workspaceClient.kv.set('selectedFolderId', null);
			}
		},

		/**
		 * Create a new note in the currently selected folder.
		 *
		 * The note starts with an empty title and preview. It's automatically
		 * selected after creation so the editor opens immediately. If no folder
		 * is selected, the note is created as unfiled.
		 *
		 * @example
		 * ```typescript
		 * // From a Svelte component:
		 * notesState.createNote();
		 * // New note appears in the list and editor opens
		 * ```
		 */
		createNote() {
			const id = generateId() as string as NoteId;
			workspaceClient.tables.notes.set({
				id,
				folderId: selectedFolderId ?? undefined,
				title: '',
				preview: '',
				pinned: false,
				deletedAt: undefined,
				wordCount: 0,
				createdAt: dateTimeStringNow(),
				updatedAt: dateTimeStringNow(),
				_v: 2,
			});
			workspaceClient.kv.set('selectedNoteId', id);
		},

		/**
		 * Soft-delete a note — moves it to Recently Deleted.
		 *
		 * The note is marked with a `deletedAt` timestamp but not permanently
		 * removed. It can be restored from the Recently Deleted view. If the
		 * deleted note was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * // Soft-delete a note
		 * notesState.softDeleteNote(noteId);
		 * // Note moves to Recently Deleted, editor closes
		 * ```
		 */
		softDeleteNote(noteId: NoteId) {
			workspaceClient.tables.notes.update(noteId, {
				deletedAt: dateTimeStringNow(),
			});
			if (selectedNoteId === noteId) {
				workspaceClient.kv.set('selectedNoteId', null);
			}
		},

		/**
		 * Restore a soft-deleted note from Recently Deleted.
		 *
		 * Removes the `deletedAt` timestamp. If the note's original folder no
		 * longer exists, the note is restored to unfiled instead.
		 *
		 * @example
		 * ```typescript
		 * // Restore a deleted note
		 * notesState.restoreNote(noteId);
		 * // Note reappears in its original folder (or unfiled)
		 * ```
		 */
		restoreNote(noteId: NoteId) {
			const note = allNotes.find((n) => n.id === noteId);
			if (!note) return;
			// If the note's folder no longer exists, restore to unfiled
			const folderExists = note.folderId
				? folders.some((f) => f.id === note.folderId)
				: true;
			workspaceClient.tables.notes.update(noteId, {
				deletedAt: undefined,
				...(folderExists ? {} : { folderId: undefined }),
			});
		},

		/**
		 * Permanently delete a note — no recovery.
		 *
		 * Removes the note from the database completely. This cannot be undone.
		 * If the deleted note was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * // Permanently delete a note
		 * notesState.permanentlyDeleteNote(noteId);
		 * // Note is removed from Recently Deleted and database
		 * ```
		 */
		permanentlyDeleteNote(noteId: NoteId) {
			workspaceClient.tables.notes.delete(noteId);
			if (selectedNoteId === noteId) {
				workspaceClient.kv.set('selectedNoteId', null);
			}
		},

		/**
		 * Toggle the pin state of a note.
		 *
		 * Pinned notes typically appear at the top of the note list. If the note
		 * doesn't exist, the operation is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * // Pin a note to keep it at the top
		 * notesState.pinNote(noteId);
		 * // Note moves to the top of the list
		 * ```
		 */
		pinNote(noteId: NoteId) {
			const note = allNotes.find((n) => n.id === noteId);
			if (!note) return;
			workspaceClient.tables.notes.update(noteId, {
				pinned: !note.pinned,
			});
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
		 * // Select a specific folder
		 * notesState.selectFolder(folderId);
		 * // View updates to show only notes in that folder
		 *
		 * // Show all notes
		 * notesState.selectFolder(null);
		 * // View updates to show all notes
		 * ```
		 */
		selectFolder(folderId: FolderId | null) {
			isRecentlyDeletedView = false;
			workspaceClient.kv.set('selectedFolderId', folderId);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		/**
		 * Switch to the Recently Deleted view.
		 *
		 * Shows only soft-deleted notes. Clears the folder selection and note
		 * selection. Use this when the user clicks "Recently Deleted" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * // Switch to Recently Deleted view
		 * notesState.selectRecentlyDeleted();
		 * // View updates to show only deleted notes
		 * ```
		 */
		selectRecentlyDeleted() {
			isRecentlyDeletedView = true;
			workspaceClient.kv.set('selectedFolderId', null);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		/**
		 * Select a note by ID to open it in the editor.
		 *
		 * The note can be active or soft-deleted. The editor will open and
		 * display the selected note's content.
		 *
		 * @example
		 * ```typescript
		 * // Select a note to open it in the editor
		 * notesState.selectNote(noteId);
		 * // Editor opens and displays the note
		 * ```
		 */
		selectNote(noteId: NoteId) {
			workspaceClient.kv.set('selectedNoteId', noteId);
		},

		/**
		 * Update the title, preview, and word count of the currently selected note.
		 *
		 * Called when the editor content changes. Only updates if a note is
		 * currently selected. The preview is typically the first line or a
		 * summary of the note content. Word count is computed from the full
		 * editor text.
		 *
		 * @example
		 * ```typescript
		 * notesState.updateNoteContent({
		 *   title: 'My Note Title',
		 *   preview: 'First line of content...',
		 *   wordCount: 42,
		 * });
		 * ```
		 */
		updateNoteContent({
			title,
			preview,
			wordCount,
		}: {
			title: string;
			preview: string;
			wordCount: number;
		}) {
			if (!selectedNoteId) return;
			workspaceClient.tables.notes.update(selectedNoteId, {
				title,
				preview,
				wordCount,
			});
		},

		/**
		 * Change the note sort order.
		 *
		 * Sorts the note list by the specified criteria. The sort preference
		 * is persisted to the workspace KV store.
		 *
		 * @example
		 * ```typescript
		 * // Sort by title alphabetically
		 * notesState.setSortBy('title');
		 *
		 * // Sort by date edited (most recent first)
		 * notesState.setSortBy('dateEdited');
		 *
		 * // Sort by date created (most recent first)
		 * notesState.setSortBy('dateCreated');
		 * ```
		 */
		setSortBy(value: 'dateEdited' | 'dateCreated' | 'title') {
			workspaceClient.kv.set('sortBy', value);
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
		 * // Search for notes containing "meeting"
		 * notesState.setSearchQuery('meeting');
		 * // List updates to show only matching notes
		 *
		 * // Clear search
		 * notesState.setSearchQuery('');
		 * // List shows all notes again
		 * ```
		 */
		setSearchQuery(query: string) {
			searchQuery = query;
		},

		/**
		 * Move a note to a different folder.
		 *
		 * Pass `undefined` to move the note to unfiled (remove from folder).
		 * The note remains selected if it was selected before the move.
		 *
		 * @example
		 * ```typescript
		 * // Move a note to a specific folder
		 * notesState.moveNoteToFolder(noteId, folderId);
		 *
		 * // Move a note to unfiled
		 * notesState.moveNoteToFolder(noteId, undefined);
		 * ```
		 */
		moveNoteToFolder(noteId: NoteId, folderId: FolderId | undefined) {
			workspaceClient.tables.notes.update(noteId, { folderId });
		},
	};
}

export const notesState = createNotesState();
