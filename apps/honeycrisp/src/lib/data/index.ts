import { field } from '@epicenter/data/definition';
/**
 * Honeycrisp's inert data definition.
 *
 * A data definition is pure JSON: closed field descriptors for the fields,
 * and nothing that knows about storage, sync, or documents (ADR-0213,
 * ADR-0240). Runtimes own all of that.
 *
 * The `folders` and `notes` property names are the durable table names. They
 * are what the row addresses carry and what the export names its folders
 * (ADR-0268).
 */

import type { DataView } from '@epicenter/data';
import {
	defineData,
	defineTable,
	type RowOf,
	type ScalarsOf,
} from '@epicenter/data/definition';
import { fragmentToPm, pmToFragment } from '@y/prosemirror';
import * as Y from '@y/y';
import { EditorState } from 'prosemirror-state';
import { Ok } from 'wellcrafted/result';
import { parseNoteBody, serializeNoteBody } from '../editor/markdown.js';
import { noteSchema } from '../editor/schema.js';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

const foldersTable = {
	scalars: {
		name: field.string(),
		// Nullable rather than optional. A data definition has no optional
		// fields on purpose: a field has to be one type through the CRDT
		// attribute, the exported frontmatter value and the row alike, and
		// "absent" is not one. Application recovery supplies a value at read time
		// and never writes it as part of the definition (ADR-0255).
		icon: field.nullable(field.string()),
	},
} as const;

const notesTable = {
	scalars: {
		folderId: field.nullable(field.string()),
		title: field.string(),
		pinned: field.boolean(),
		// Validation-only rather than `string.date.parse`: a field has to be one
		// type through the CRDT attribute, the exported frontmatter value and the
		// row alike, and a parsing form would hand back a `Date` that could not
		// round-trip.
		// Ordinary fields nobody stamps but Honeycrisp (ADR-0297). The store
		// stopped holding an opinion about time, so `openBody` is what moves
		// `updatedAt`, and `create` is what sets `createdAt`.
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: field.nullable(field.instant()),
	},
	/**
	 * The note's prose: a live `Y.Type` on the row (ADR-0295, ADR-0296).
	 *
	 * A name and nothing else, because there is nothing to configure. Minted
	 * with the row and never again, and bound directly by `@y/prosemirror`,
	 * which is typed against `Y.Type` and makes no root assumption.
	 */
	types: ['body'],
} as const;

/**
 * A note's prose as a ProseMirror node, read headlessly.
 *
 * A note nobody has typed into has an empty body, and an empty fragment is not
 * a valid ProseMirror document: `fragmentToPm` refuses it outright. What that
 * note actually is, is the empty document the schema mints, so an untouched
 * note derives an empty title and exports an empty body rather than throwing
 * at whoever reads it.
 */
export function noteBodyAsPm(body: Y.Type) {
	const state = EditorState.create({ schema: noteSchema });
	if (body.length === 0) return state.doc;
	return fragmentToPm(body, state.tr);
}

/**
 * The notes table's file codec (ADR-0296).
 *
 * The platform owns the file format: it emits `data` as frontmatter and
 * `content` beneath the fence, and parses both back. This owns the mapping.
 * The scalars go up verbatim, so a value an older release wrote survives the
 * round trip, and the prose goes down as Markdown.
 *
 * `serialize` and `deserialize` are inverses: a row goes out as a file, a file
 * comes back as a row, prose included. `deserialize` used to be handed a
 * `types.body` the platform had already minted and fill it in place; that
 * requirement was measured against the wrong thing (ADR-0296, amended).
 */
const noteFile = {
	serialize: ({ id: _id, body, ...fields }: RowOf<typeof notesTable>) => ({
		data: fields,
		content: serializeNoteBody(noteBodyAsPm(body)),
	}),
	deserialize: (file: { data: Record<string, unknown>; content: string }) => {
		// Built here and handed over, rather than filled into a type the platform
		// minted first (ADR-0296, amended). `create` integrates it in the
		// transaction that mints the row.
		const body = new Y.Type();
		pmToFragment(parseNoteBody(file.content), body);
		// Verbatim, including a key this release no longer names: the artifact is
		// the truth on the way in, and a row this declaration cannot read is
		// reported on the first read rather than repaired here (ADR-0125).
		return Ok({
			...(file.data as ScalarsOf<typeof notesTable>),
			body,
		});
	},
};

export const honeycrispDefinition = defineData({
	id: 'so.epicenter.honeycrisp',
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: foldersTable,
		notes: defineTable({ ...notesTable, file: noteFile }),
	},
});

/** The typed view of one opened Honeycrisp data handle. */
export type HoneycrispData = DataView<typeof honeycrispDefinition>;

export type Folder = RowOf<typeof foldersTable>;
export type Note = RowOf<typeof notesTable>;

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
	const notes = data.tables.notes;
	const inFolder = [
		...notes.rows
			.filter((note) => note.folderId === folderId)
			.map((note) => note.id),
		...notes.nonconforming
			.filter((issue) => issue.raw.folderId === folderId)
			.map((issue) => issue.id),
	];
	// One commit for the whole re-parenting. Without it a folder holding fifty
	// notes cost fifty-one commits, fifty-one durable appends, and fifty-one
	// notifications to every list on screen, for one user action.
	data.transact(() => {
		for (const noteId of inFolder) {
			const { error } = data.tables.notes.update(noteId, { folderId: null });
			if (error !== null && error.name !== 'RowAbsent') throw error;
		}
		// Deleting an absent folder is a no-op fact, not an error.
		data.tables.folders.delete(folderId);
	});
}
