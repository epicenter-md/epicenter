import { field } from '@epicenter/data/definition';
/**
 * Honeycrisp's inert data definition.
 *
 * A data definition is pure JSON: closed field descriptors for the fields,
 * and nothing that knows about storage, sync, or documents (ADR-0213,
 * ADR-0240). Runtimes own all of that.
 *
 * The `folders` and `notes` property names are the durable table names. They are
 * what the row addresses carry, what a trusted inspection host mounts as
 * `SELECT * FROM notes`, and what the projection's relations are called.
 */

import type { DataView } from '@epicenter/data';
import { defineData, type RowOf } from '@epicenter/data/definition';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

const foldersTable = {
	name: field.string(),
	// Nullable rather than optional. A data definition has no optional
	// fields on purpose: a field has to be one type through the CRDT attribute,
	// the projection column and the row alike, and "absent" is not a SQL type.
	// Application recovery supplies a value at read time and never writes it as
	// part of the definition (ADR-0255).
	icon: field.nullable(field.string()),
} as const;

const notesTable = {
	folderId: field.nullable(field.string()),
	title: field.string(),
	preview: field.string(),
	pinned: field.boolean(),
	// Validation-only rather than `string.date.parse`: a field has to be one
	// type through the CRDT attribute, the projection column and the row alike,
	// and a parsing form would hand back a `Date` that could not round-trip.
	createdAt: field.instant(),
	updatedAt: field.instant(),
	deletedAt: field.nullable(field.instant()),
} as const;

export const honeycrispDefinition = defineData({
	id: 'so.epicenter.honeycrisp',
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: { fields: foldersTable },
		notes: { fields: notesTable },
	},
});

/** The typed view of one opened Honeycrisp data handle. */
export type HoneycrispData = DataView<typeof honeycrispDefinition>;

export type Folder = RowOf<typeof foldersTable>;
export type Note = RowOf<typeof notesTable>;

/**
 * The root a note's prose lives at, inside the note's own document.
 *
 * One spelling, used at every open. Minting on first use is safe in an
 * independent document: a top-level root is addressed by its name, so two
 * devices first-opening one note converge with both writes retained
 * (ADR-0248).
 */
export const NOTE_BODY = 'body';

/**
 * Delete a folder after re-parenting the notes that were in it.
 *
 * Synchronous, and one pass rather than a stream: `list()` reads the CRDT that
 * is already in memory. A failed note update stops before the folder goes, so
 * the operation can be retried without knowingly leaving a dangling folder id.
 *
 * A note that vanished between the `list()` and its own update is skipped
 * rather than raised: it is no longer in this folder, which is the outcome the
 * caller wanted, and another device deleting a note mid-pass is ordinary in a
 * synced document. Every other refusal means a declaration and this code
 * disagree, and that throws.
 *
 * A note this release cannot read is re-parented too, through its `raw`
 * payload. `list()` returns those separately, and skipping them would leave a
 * note pointing at a folder that no longer exists while reporting success —
 * which is the silent damage nonconformance is supposed not to cause. An
 * `update` validates only the values it is given, so setting `folderId` on an
 * otherwise unreadable row is a legal write (ADR-0125).
 */
export function deleteHoneycrispFolder(
	data: HoneycrispData,
	folderId: FolderId,
): void {
	const listed = data.tables.notes.list();
	const inFolder = [
		...listed.rows
			.filter((note) => note.folderId === folderId)
			.map((note) => note.id),
		...listed.nonconforming
			.filter((issue) => issue.raw.folderId === folderId)
			.map((issue) => issue.id),
	];
	for (const noteId of inFolder) {
		const { error } = data.tables.notes.update(noteId, { folderId: null });
		if (error !== null && error.name !== 'RowAbsent') throw error;
	}
	// Deleting an absent folder is a no-op fact, not an error.
	data.tables.folders.delete(folderId);
}
