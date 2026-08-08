/**
 * Honeycrisp's inert Lens.
 *
 * A Lens is pure JSON: arktype expressions for the fields, and nothing that
 * knows about storage, sync, or documents (ADR-0213). Runtimes own all of that.
 *
 * The `folders` and `notes` property names are the durable table names. They are
 * what the row addresses carry, what a trusted inspection host mounts as
 * `SELECT * FROM notes`, and what the projection's relations are called.
 */

import type { BoundOf } from '@epicenter/data';
import { defineLens, type RowOf } from '@epicenter/lens/lens';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

const foldersTable = {
	name: 'string',
	// Nullable with a default rather than optional. A Lens has no optional
	// fields on purpose: a field has to be one type through the CRDT attribute,
	// the projection column and the row alike, and "absent" is not a SQL type.
	// A default is applied at read time and never written (ADR-0213).
	icon: 'string|null = null',
	sortOrder: 'number',
} as const;

const notesTable = {
	folderId: 'string|null = null',
	title: 'string',
	preview: 'string',
	pinned: 'boolean',
	// Validation-only rather than `string.date.parse`: a field has to be one
	// type through the CRDT attribute, the projection column and the row alike,
	// and a parsing form would hand back a `Date` that could not round-trip.
	createdAt: 'string.date.iso',
	updatedAt: 'string.date.iso',
	deletedAt: 'string.date.iso|null = null',
	wordCount: 'number|null = null',
} as const;

export const honeycrispLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	title: 'Honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
});

/** The typed view of one store through Honeycrisp's Lens. */
export type HoneycrispData = BoundOf<typeof honeycrispLens>;

export type Folder = RowOf<typeof foldersTable>;
export type Note = RowOf<typeof notesTable>;

/**
 * The root a note's prose lives at, inside the note's own document.
 *
 * Named at `create` rather than felt for on first open, and that is a
 * correctness requirement rather than tidiness. `document(id).get(name)` creates
 * on miss and a created nested type is addressed by the operation that made it,
 * so two devices first-opening one note would each mint a root here and map LWW
 * would discard one along with everything typed into it (ADR-0215).
 */
export const NOTE_BODY = 'body';

/**
 * Delete a folder after re-parenting the notes that were in it.
 *
 * Synchronous, and one pass rather than a stream: `list()` reads the CRDT that
 * is already in memory. A failed note update stops before the folder goes, so
 * the operation can be retried without knowingly leaving a dangling folder id.
 */
export function deleteHoneycrispFolder(
	db: HoneycrispData,
	folderId: FolderId,
): void {
	const listed = db.notes.list();
	if (listed.error !== null) throw listed.error;
	for (const note of listed.data.rows) {
		if (note.folderId !== folderId) continue;
		const { error } = db.notes.update(note.id, { folderId: null });
		if (error !== null) throw error;
	}
	const { error } = db.folders.delete(folderId);
	if (error !== null) throw error;
}
