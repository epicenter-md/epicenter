/**
 * Honeycrisp's inert Data definitions.
 *
 * Runtimes own storage, synchronization, and document lifecycles. This module
 * owns only the Lens over Honeycrisp's namespace, release-local row lenses, and
 * the one multi-row folder deletion operation shared by the UI and desktop host.
 */

import {
	type BoundData,
	defineLens,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

export const foldersTable = defineTable({
	fields: {
		name: field.string(),
		icon: optional(field.string()),
		sortOrder: field.number(),
	},
});
export type Folder = RowFor<typeof foldersTable>;

export const notesTable = defineTable({
	fields: {
		folderId: optional(field.string()),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: optional(field.instant()),
		wordCount: optional(field.number()),
	},
});
export type Note = RowFor<typeof notesTable>;

/**
 * Honeycrisp's inert Lens for this release.
 *
 * The namespace is declared once here. The `folders` and `notes` property names
 * are the durable table names: they are what the row addresses carry, and what a
 * trusted inspection host would mount as `SELECT * FROM notes`.
 */
export const honeycrispLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
});

export type HoneycrispData = BoundData<typeof honeycrispLens.tables>;

/**
 * Delete a folder after best-effort re-parenting of its current notes.
 *
 * The row runtime has no workspace action layer or cross-row transaction. A
 * failed note update stops before the folder is deleted, so the operation can
 * be retried without knowingly leaving a dangling folder id.
 */
export async function deleteHoneycrispFolder(
	data: HoneycrispData,
	folderId: FolderId,
): Promise<void> {
	for await (const entry of data.notes.entries()) {
		if (entry.error !== null) continue;
		const note = entry.data;
		if (note.folderId !== folderId) continue;
		const result = await data.notes.patch(note.id, {
			folderId: undefined,
		});
		if (result.error !== null) throw result.error;
	}
	await data.folders.delete(folderId);
}
