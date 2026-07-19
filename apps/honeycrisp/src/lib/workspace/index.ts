/**
 * Honeycrisp's inert SQLite workspace contract.
 *
 * Runtimes own storage, synchronization, and document lifecycles. This module
 * owns only stable workspace identity, release-local row lenses, and the one
 * multi-row folder deletion operation shared by the UI and desktop host.
 */

import { field } from '@epicenter/field';
import {
	defineTable,
	defineWorkspace,
	type RowFor,
	type Workspace,
} from '@epicenter/workspace/sqlite';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

export const foldersTable = defineTable({
	fields: {
		name: field.string(),
		icon: field.string(),
		sortOrder: field.number(),
	},
	optional: ['icon'],
});
export type Folder = RowFor<typeof foldersTable>;

export const notesTable = defineTable({
	fields: {
		folderId: field.string(),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: field.instant(),
		wordCount: field.number(),
	},
	optional: ['folderId', 'deletedAt', 'wordCount'],
});
export type Note = RowFor<typeof notesTable>;

/** Honeycrisp's schema-opaque canonical workspace and this release's lenses. */
export const honeycrispWorkspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
});

export type HoneycrispWorkspace = Workspace<typeof honeycrispWorkspace>;

/**
 * Delete a folder after best-effort re-parenting of its current notes.
 *
 * The row runtime has no workspace action layer or cross-row transaction. A
 * failed note update stops before the folder is deleted, so the operation can
 * be retried without knowingly leaving a dangling folder id.
 */
export async function deleteHoneycrispFolder(
	workspace: HoneycrispWorkspace,
	folderId: FolderId,
): Promise<void> {
	const { rows } = await workspace.tables.notes.list();
	for (const note of rows) {
		if (note.folderId !== folderId) continue;
		const result = await workspace.tables.notes.update(note.id, {
			folderId: undefined,
		});
		if (result.error !== null) throw result.error;
	}
	await workspace.tables.folders.delete(folderId);
}
