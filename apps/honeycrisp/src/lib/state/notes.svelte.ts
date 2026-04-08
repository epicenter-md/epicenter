/**
 * Reactive notes state for Honeycrisp.
 *
 * Manages note CRUD operations and reactive note collections. Backed by
 * a Y.Doc CRDT table, so notes sync across devices. Uses a factory
 * function pattern to encapsulate `$state`.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { notesState } from '$lib/state';
 * </script>
 *
 * {#each notesState.notes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <button onclick={() => notesState.createNote()}>New Note</button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { dateTimeStringNow, generateId } from '@epicenter/workspace';
import { workspace } from '$lib/client';
import type { FolderId, Note, NoteId } from '$lib/workspace';
import { foldersState } from './folders.svelte';

function createNotesState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	const allNotesMap = fromTable(workspace.tables.notes);

	/** All valid notes (including deleted). Cached — only recomputes when table changes. */
	const allNotes = $derived(allNotesMap.values().toArray());

	// ─── Derived State ───────────────────────────────────────────────────

	/** Active notes — not soft-deleted. */
	const notes = $derived(allNotes.filter((n) => n.deletedAt === undefined));

	/** Soft-deleted notes for the Recently Deleted view. */
	const deletedNotes = $derived(
		allNotes.filter((n) => n.deletedAt !== undefined),
	);

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

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get allNotes() {
			return allNotes;
		},
		get notes() {
			return notes;
		},
		get deletedNotes() {
			return deletedNotes;
		},
		get noteCounts() {
			return noteCounts;
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
		 * notesState.createNote();
		 * // New note appears in the list and editor opens
		 * ```
		 */
		createNote() {
			const id = generateId() as string as NoteId;
			const selectedFolderId = workspace.kv.get('selectedFolderId');
			workspace.tables.notes.set({
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
			workspace.kv.set('selectedNoteId', id);
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
		 * notesState.softDeleteNote(noteId);
		 * // Note moves to Recently Deleted, editor closes
		 * ```
		 */
		softDeleteNote(noteId: NoteId) {
			workspace.tables.notes.update(noteId, {
				deletedAt: dateTimeStringNow(),
			});
			if (workspace.kv.get('selectedNoteId') === noteId) {
				workspace.kv.set('selectedNoteId', null);
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
		 * notesState.restoreNote(noteId);
		 * // Note reappears in its original folder (or unfiled)
		 * ```
		 */
		restoreNote(noteId: NoteId) {
			const note = allNotesMap.get(noteId);
			if (!note) return;
			const folderExists = note.folderId
				? foldersState.folders.some((f) => f.id === note.folderId)
				: true;
			workspace.tables.notes.update(noteId, {
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
		 * notesState.permanentlyDeleteNote(noteId);
		 * // Note is removed from Recently Deleted and database
		 * ```
		 */
		permanentlyDeleteNote(noteId: NoteId) {
			workspace.tables.notes.delete(noteId);
			if (workspace.kv.get('selectedNoteId') === noteId) {
				workspace.kv.set('selectedNoteId', null);
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
		 * notesState.pinNote(noteId);
		 * // Note moves to the top of the list
		 * ```
		 */
		pinNote(noteId: NoteId) {
			const note = allNotesMap.get(noteId);
			if (!note) return;
			workspace.tables.notes.update(noteId, {
				pinned: !note.pinned,
			});
		},

		/**
		 * Move a note to a different folder.
		 *
		 * Pass `undefined` to move the note to unfiled (remove from folder).
		 * The note remains selected if it was selected before the move.
		 *
		 * @example
		 * ```typescript
		 * notesState.moveNoteToFolder(noteId, folderId);
		 *
		 * // Move a note to unfiled
		 * notesState.moveNoteToFolder(noteId, undefined);
		 * ```
		 */
		moveNoteToFolder(noteId: NoteId, folderId: FolderId | undefined) {
			workspace.tables.notes.update(noteId, { folderId });
		},

		/**
		 * Update the title, preview, and word count of the currently selected note.
		 *
		 * Called when the editor content changes. Only updates if a note is
		 * currently selected.
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
			const selectedNoteId = workspace.kv.get('selectedNoteId');
			if (!selectedNoteId) return;
			workspace.tables.notes.update(selectedNoteId, {
				title,
				preview,
				wordCount,
			});
		},
	};
}

export const notesState = createNotesState();
