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
	type ContentCodec,
	defineData,
	defineTable,
	plainText,
	type RowOf,
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
 * A note's content node as Markdown, and back (ADR-0296).
 *
 * The whole of what this app declares about its files. The platform writes the
 * scalars as frontmatter under their own field names and joins this below the
 * fence, and reverses both; only Honeycrisp knows that a note's node is a
 * ProseMirror document rather than a line of text or a keyed log.
 *
 * `decode` cannot fail on well-formed input, because any Markdown parses. What
 * it must not do is judge the frontmatter: a value this release cannot read is
 * reported as nonconforming on the first read rather than refused at the door
 * (ADR-0125), which is what keeps an artifact readable by the release that has
 * to fix it, and what keeps one hand-edited file from costing somebody the
 * import of their whole folder.
 */
const noteMarkdown: ContentCodec = {
	encode: (node) => serializeNoteBody(noteBodyAsPm(node)),
	decode: (text) => {
		// Built here and handed over (ADR-0296, amended). Fresh per row: two rows
		// given one node would share it. One `pmToFragment` rather than a loop,
		// because a detached node replays one positional delta and appends would
		// reverse.
		const node = new Y.Type();
		pmToFragment(parseNoteBody(text), node);
		return Ok(node);
	},
};

export const honeycrispDefinition = defineData({
	id: 'so.epicenter.honeycrisp',
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: defineTable({
			name: field.string(),
			// Nullable rather than optional. A data definition has no optional
			// fields on purpose: a field has to be one type through the CRDT
			// attribute, the exported frontmatter value and the row alike, and
			// "absent" is not one. Application recovery supplies a value at read
			// time and never writes it as part of the definition (ADR-0255).
			icon: field.nullable(field.string()),
			// A folder's body, if it ever has one, is text. Nothing writes there
			// today, so its file is its frontmatter and nothing below the fence.
			// That is a capability sitting unused rather than a field standing
			// empty: the day a folder wants a description, writing into
			// `folder.content` exports, imports, and merges with no change here.
			content: plainText(),
		}),
		notes: defineTable({
			folderId: field.nullable(field.string()),
			title: field.string(),
			pinned: field.boolean(),
			// Validation-only rather than `string.date.parse`: a field has to be
			// one type through the CRDT attribute, the exported frontmatter value
			// and the row alike, and a parsing form would hand back a `Date` that
			// could not round-trip.
			// Ordinary fields nobody stamps but Honeycrisp (ADR-0297). The store
			// stopped holding an opinion about time, so `openContent` is what moves
			// `updatedAt`, and `create` is what sets `createdAt`.
			createdAt: field.instant(),
			updatedAt: field.instant(),
			deletedAt: field.nullable(field.instant()),
			content: noteMarkdown,
		}),
	},
});

/** The typed view of one opened Honeycrisp data handle. */
export type HoneycrispData = DataView<typeof honeycrispDefinition>;

export type Folder = RowOf<typeof honeycrispDefinition.tables.folders>;
export type Note = RowOf<typeof honeycrispDefinition.tables.notes>;

/**
 * Delete a folder after re-parenting the notes that were in it.
 *
 * Synchronous, and one pass rather than a stream: `rows` reads the CRDT that
 * is already in memory. A failed note update stops before the folder goes, so
 * the operation can be retried without knowingly leaving a dangling folder id.
 *
 * A note that vanished between the `rows` read and its own update is skipped
 * rather than raised: it is no longer in this folder, which is the outcome the
 * caller wanted, and another device deleting a note mid-pass is ordinary in a
 * synced document. Every other refusal means a declaration and this code
 * disagree, and that throws.
 *
 * A note this release cannot read is re-parented too, through its `raw`
 * payload. `nonconforming` returns those separately, and skipping them would leave a
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
