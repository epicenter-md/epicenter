import type { NonconformingRowError } from '@epicenter/lens';
import { InstantString } from '@epicenter/field';
import {
	type FolderId,
	type HoneycrispData,
	NOTE_BODY,
	type Note,
	type NoteId,
} from '@epicenter/honeycrisp';
import type { NoteSearchIndex } from '../../lib/search-index.svelte.js';
import { searchParams } from './search-params.svelte.js';

/**
 * Honeycrisp's notes, read straight out of the store.
 *
 * There is no `refresh`, no generation counter, and no `await` on a read. The
 * store's `subscribe` says which rows a commit touched and fires for a local
 * write, for prose typed into a note's document, and for bytes that arrived from
 * another device alike (ADR-0221), so a re-read after a mutation is something
 * this module hears about rather than something every call site remembers.
 *
 * `$state.raw` holding a re-read snapshot rather than a reactive proxy: the rows
 * are plain JSON that the store hands back fresh each time, so there is nothing
 * for fine-grained reactivity to track and a whole-array swap is the honest
 * shape.
 */
export function createNotes({
	db,
	searchIndex,
	reportBackgroundError,
}: {
	db: HoneycrispData;
	searchIndex: NoteSearchIndex;
	reportBackgroundError(cause: unknown): void;
}) {
	let rows = $state.raw<Note[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);

	function read(): void {
		const { data, error } = db.tables.notes.list();
		if (error !== null) {
			// Reported, not just remembered. A read that fails after boot leaves
			// `rows` at its last value, which for a first read is empty, and an
			// empty list renders as "you have never written one of these". The
			// boot path has `{:catch}`; this path had nothing.
			loadError = error;
			reportBackgroundError(error);
			return;
		}
		rows = data.rows;
		nonconforming = data.nonconforming;
		loadError = null;
	}

	read();
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187).
	const stop = db.tables.notes.subscribe(read);

	const all = $derived(rows.filter((note) => note.deletedAt === null));
	const deleted = $derived(rows.filter((note) => note.deletedAt !== null));
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId) counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
		}
		return counts;
	});

	/** Apply a change, or throw so the caller's toast can present it. */
	function update(noteId: NoteId, changes: Partial<Note>): void {
		const { error } = db.tables.notes.update(noteId, changes);
		if (error !== null) throw error;
	}

	return {
		[Symbol.dispose]: stop,
		get(id: NoteId) {
			return rows.find((note) => note.id === id);
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
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},

		create(folderId: FolderId | null): { id: NoteId } {
			const now = InstantString.now();
			const { data, error } = db.tables.notes.create(
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
			if (searchParams.note === noteId) searchParams.update({ note: null });
		},

		restore(noteId: NoteId): void {
			update(noteId, { deletedAt: null });
		},

		permanentlyDelete(noteId: NoteId): void {
			const { error } = db.tables.notes.delete(noteId);
			if (error !== null) throw error;
			searchIndex.forget(noteId);
			if (searchParams.note === noteId) searchParams.update({ note: null });
		},

		togglePin(noteId: NoteId): void {
			const note = rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			update(noteId, { pinned: !note.pinned });
		},

		moveToFolder(noteId: NoteId, folderId: FolderId | null): void {
			update(noteId, { folderId });
		},

		updateContent(
			noteId: NoteId,
			content: Pick<Note, 'title' | 'preview'> & {
				wordCount: number;
				text: string;
			},
		): void {
			// The body's text goes to the device-local index, never to the row:
			// prose stays in the document plane so it can merge per character
			// (ADR-0207), and this keeps the open note's index entry current
			// without a sweep ever reaching it.
			const { text, ...row } = content;
			searchIndex.record(noteId, text);
			update(noteId, { ...row, updatedAt: InstantString.now() });
		},
	};
}
