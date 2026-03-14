/**
 * Workspace — schema and client for Honeycrisp notes.
 *
 * Honeycrisp is an Apple Notes clone with three-column layout: sidebar folders,
 * note list, and rich-text editor. Folders organize notes; notes have Y.Text
 * bodies for collaborative editing via Tiptap + y-prosemirror.
 *
 * Contains branded NoteId/FolderId types, folders and notes table definitions
 * with DateTimeString timestamps, KV settings, and the workspace client with
 * IndexedDB persistence.
 */

import {
	createWorkspace,
	DateTimeString,
	dateTimeStringNow,
	defineKv,
	defineTable,
	defineWorkspace,
	generateId,
	type InferTableRow,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/**
 * Branded note ID — nanoid generated when a note is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type NoteId = string & Brand<'NoteId'>;
export const NoteId = type('string').pipe((s): NoteId => s as NoteId);

/**
 * Branded folder ID — nanoid generated when a folder is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type FolderId = string & Brand<'FolderId'>;
export const FolderId = type('string').pipe((s): FolderId => s as FolderId);

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Folders table — organizational containers for notes.
 *
 * Each folder has a name, optional emoji icon, and sort order for manual
 * reordering in the sidebar. Notes reference folders via `folderId`.
 */
const foldersTable = defineTable(
	type({
		id: FolderId,
		name: 'string',
		'icon?': 'string | undefined',
		sortOrder: 'number',
		_v: '1',
	}),
);
export type Folder = InferTableRow<typeof foldersTable>;

/**
 * Notes table — individual notes with rich-text bodies.
 *
 * Each note belongs to an optional folder (unfiled if `folderId` is undefined),
 * has a title auto-populated from the first line of content, a preview for the
 * list view, and can be pinned to appear at the top of the note list.
 *
 * v2 adds `deletedAt` for soft delete — notes move to "Recently Deleted"
 * instead of being permanently destroyed. The field is `undefined` for active
 * notes and a `DateTimeString` for deleted ones. Also adds optional `wordCount`
 * (computed on each editor update, `undefined` for legacy notes).
 *
 * The Y.XmlFragment document (`body`) provides collaborative rich-text editing.
 * The document GUID matches the note `id` for 1:1 mapping. Updates to the
 * document automatically touch `updatedAt`.
 */
const notesTable = defineTable(
	type({
		id: NoteId,
		'folderId?': FolderId.or('undefined'),
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
	type({
		id: NoteId,
		'folderId?': FolderId.or('undefined'),
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		'deletedAt?': DateTimeString.or('undefined'),
		'wordCount?': 'number | undefined',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '2',
	}),
)
	.migrate((row) => {
		switch (row._v) {
			case 1:
				return { ...row, deletedAt: undefined, _v: 2 };
			case 2:
				return row;
		}
	})
	.withDocument('body', {
		guid: 'id',
		onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
	});
export type Note = InferTableRow<typeof notesTable>;

// ─── Workspace ────────────────────────────────────────────────────────────────

export const honeycrisp = defineWorkspace({
	id: 'epicenter.honeycrisp' as const,
	tables: { folders: foldersTable, notes: notesTable },
	kv: {
		selectedFolderId: defineKv(FolderId.or(type('null')), null),
		selectedNoteId: defineKv(NoteId.or(type('null')), null),
		sortBy: defineKv(type("'dateEdited' | 'dateCreated' | 'title'"), 'dateEdited'),
		sidebarCollapsed: defineKv(type('boolean'), false),
	},
});

/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspaceClient.tables.folders` / `workspaceClient.tables.notes`
 * and KV settings via `workspaceClient.kv`. The client is ready when
 * `workspaceClient.whenReady` resolves.
 */
export default createWorkspace(honeycrisp).withExtension(
	'persistence',
	indexeddbPersistence,
);
