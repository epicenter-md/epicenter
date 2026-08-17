import { InstantString } from '@epicenter/field';
import {
	type FolderId,
	type HoneycrispData,
	NOTE_BODY,
	type Note,
	type NoteId,
} from '@epicenter/honeycrisp';
import type { ReactiveWorkspace } from '@epicenter/svelte';
import { readNoteText } from '../note-text.js';
import { navigation } from './navigation.svelte.js';

/**
 * Honeycrisp's own note concepts, over the reactive `notes` table.
 *
 * The table already answers "what rows are here right now" reactively
 * (`fromWorkspace`): a read inside `$derived` re-runs on any commit that
 * touched the table, local writes, prose typed into a note's document, and
 * bytes from another device alike (ADR-0221), and a read in an event handler
 * is fresh. What this module adds is what the platform cannot know: which
 * rows count as deleted, per-folder counts, where a note's prose is, and the
 * domain commands (soft delete, pinning, re-parenting) with their URL cleanup.
 */
export function createNotes({
	workspace,
}: {
	workspace: ReactiveWorkspace<HoneycrispData>;
}) {
	const table = workspace.tables.notes;

	const all = $derived(table.rows.filter((note) => note.deletedAt === null));
	const deleted = $derived(
		table.rows.filter((note) => note.deletedAt !== null),
	);
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId)
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
		}
		return counts;
	});

	/** Apply a change, or throw so the caller's toast can present it. */
	function update(noteId: NoteId, changes: Partial<Note>): void {
		const { error } = table.update(noteId, changes);
		if (error !== null) throw error;
	}

	return {
		get(id: NoteId) {
			return table.rows.find((note) => note.id === id);
		},
		/**
		 * This note's prose as one flat string, read straight out of the document.
		 *
		 * A read rather than an index: the text is a type in the application's own
		 * document, so there is nothing to open and nothing to warm, and reading
		 * through means a paragraph that arrived from another device is findable
		 * the moment it lands.
		 */
		text(id: NoteId): string {
			return readNoteText(table.document(id));
		},
		get all() {
			return all;
		},
		get deleted() {
			return deleted;
		},
		get countsByFolder() {
			return countsByFolder;
		},
		get nonconforming() {
			return table.nonconforming;
		},

		create(folderId: FolderId | null): { id: NoteId } {
			const now = InstantString.now();
			const { data, error } = table.create(
				{
					folderId,
					title: '',
					preview: '',
					pinned: false,
					createdAt: now,
					updatedAt: now,
				},
				// Named here, once, at the only moment there is exactly one creator.
				// Reaching for the root lazily would let two devices first-opening
				// one note each mint their own and lose one (ADR-0215).
				{ document: [NOTE_BODY] },
			);
			if (error !== null) throw error;
			return { id: data.id };
		},

		softDelete(noteId: NoteId): void {
			update(noteId, { deletedAt: InstantString.now() });
			navigation.noteRemoved(noteId);
		},

		restore(noteId: NoteId): void {
			update(noteId, { deletedAt: null });
		},

		permanentlyDelete(noteId: NoteId): void {
			// Deleting an absent note is a no-op fact, not an error.
			table.delete(noteId);
			navigation.noteRemoved(noteId);
		},

		togglePin(noteId: NoteId): void {
			const note = table.rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			update(noteId, { pinned: !note.pinned });
		},

		moveToFolder(noteId: NoteId, folderId: FolderId | null): void {
			update(noteId, { folderId });
		},

		/**
		 * Record the row metadata the editor derived from a note's prose.
		 *
		 * Only the row: the prose itself is already durable in the document, which
		 * is where it merges per character (ADR-0207), so this write is the title,
		 * preview and word count the list renders, plus the edit time it sorts on.
		 */
		updateContent(
			noteId: NoteId,
			content: Pick<Note, 'title' | 'preview' | 'wordCount'>,
		): void {
			update(noteId, { ...content, updatedAt: InstantString.now() });
		},
	};
}
