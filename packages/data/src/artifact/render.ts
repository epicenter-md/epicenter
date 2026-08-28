/**
 * A row becomes one file (ADR-0268, ADR-0271).
 *
 * This is the unit, and everything else is iteration: the mirror renders the
 * rows a commit touched, and a whole render is the same call in a loop. The
 * artifact used to be assembled the other way around, whole-store first,
 * because ADR-0267's layout put a row's fields and its document in two
 * separate trees correlated by coordinates. ADR-0268 collapsed that layout
 * into one file per row; this is the code catching up to it. A row's fields
 * and its prose go in the same file, so they are read in the same function
 * and never rejoined.
 *
 * Composed on the opened data's public surface, so it is a follower and never
 * a store verb. It reads; nothing it returns can reach back in.
 *
 * Everything scalar comes from the faithful read, never from `get` or `list`.
 * A table handle reads through the declaration and narrows to the fields it
 * names, so rendering through the lens would drop a value an older release
 * wrote: the row still conforms, so it is not reported as nonconforming, and
 * the value is simply gone from the file. That is the one thing an artifact
 * may not do.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type DataDefinition,
	type DocumentReader,
	type JsonObject,
	parseData,
	type ParsedDataDefinition,
} from '../definition/index.js';
import type { RowDocumentHandle } from '../store/documents.js';
import type { StoredData } from '../store/store.js';
import { rowFile } from './frontmatter.js';
import { rowPath } from './layout.js';

export const RenderError = defineErrors({
	/**
	 * The definition handed here could not be compiled, so there are no codecs
	 * to serialize through. A programmer error surfaced as a value, because the
	 * caller is a person pressing a button or a mirror running at boot.
	 */
	MalformedDefinition: ({ reason }: { reason: string }) => ({
		message: `The data definition could not be compiled: ${reason}`,
		reason,
	}),
	/**
	 * A row's document could not be opened, so this render cannot say what that
	 * body holds. Fatal for the row: a file that quietly lacks its prose feeds
	 * a restore that would delete that prose everywhere.
	 */
	DocumentUnreadable: ({
		table,
		rowId,
		cause,
	}: { table: string; rowId: string; cause: unknown }) => ({
		message: `Document for '${table}/${rowId}' could not be read`,
		table,
		rowId,
		cause,
	}),
	/**
	 * The table's own `serialize` threw on this document. Contained rather than
	 * allowed to escape: a codec that throws is a case a person needs told,
	 * not a stack trace in the middle of their data being written to disk.
	 */
	BodyUnwritable: ({
		table,
		rowId,
		cause,
	}: { table: string; rowId: string; cause: unknown }) => ({
		message: `The document at '${table}/${rowId}' could not be serialized`,
		table,
		rowId,
		cause,
	}),
});
export type RenderError = InferErrors<typeof RenderError>;

/**
 * The slice of opened data a render reads: the faithful reads, and each
 * table's document opener. Structural on purpose, so any typed or untyped
 * view satisfies it.
 */
export type RenderableData = {
	stored(): StoredData;
	readonly tables: Readonly<
		Record<
			string,
			{
				stored(rowId: string): JsonObject | undefined;
				openDocument(
					rowId: string,
				): Promise<{
					data: RowDocumentHandle | undefined | null;
					error: unknown;
				}>;
			}
		>
	>;
};

/**
 * One row's file: the path it lives at, and what is in it.
 *
 * `contents` is `undefined` when the row is gone, which is the same answer a
 * subscriber needs for a deletion: the ids a commit touched include the ones
 * it removed, so the caller asks about each and writes or unlinks.
 */
export type RenderedRow = {
	readonly path: string;
	readonly contents: string | undefined;
};

/**
 * Render one row to its file.
 *
 * It opens the row's document itself rather than taking a body, and that is
 * what deletes the join: a row's fields and its prose belong to one file, so
 * one function reads both. The handle is disposed here, so a document opened
 * only to be rendered unloads again, and one that a person already has open
 * is simply borrowed for the read.
 */
export async function renderRow(
	data: RenderableData,
	definition: ParsedDataDefinition,
	table: string,
	rowId: string,
): Promise<Result<RenderedRow, RenderError>> {
	const path = rowPath(table, rowId);
	const handle = data.tables[table];
	const fields = handle?.stored(rowId);
	if (handle === undefined || fields === undefined) {
		return Ok({ path, contents: undefined });
	}

	const codec = definition.tables.get(table)?.document?.file;
	if (codec === undefined) return Ok({ path, contents: rowFile(fields, undefined) });

	const opened = await handle.openDocument(rowId);
	if (opened.error !== null && opened.error !== undefined) {
		return RenderError.DocumentUnreadable({ table, rowId, cause: opened.error });
	}
	const doc = opened.data;
	// Taken between the read and the open. It has no body to carry, and its
	// file is about to be unlinked by whoever asks about it next.
	if (doc === undefined || doc === null) {
		return Ok({ path, contents: rowFile(fields, undefined) });
	}
	try {
		return Ok({
			path,
			contents: rowFile(fields, codec.serialize(doc as unknown as DocumentReader)),
		});
	} catch (cause) {
		return RenderError.BodyUnwritable({ table, rowId, cause });
	} finally {
		doc[Symbol.dispose]();
	}
}

/**
 * Every file a store renders to, one at a time.
 *
 * The loop over `renderRow`, plus `kv.json`, which is the one file that is not
 * a row: one object, no body, and nothing frontmatter would buy (ADR-0268).
 *
 * The mirror runs this at boot, because a store changes while an
 * application is closed: another device syncs, and the folder is stale until
 * something renders it whole. After that the mirror renders only the rows a
 * commit touched.
 *
 * Yielded rather than collected, because the one consumer writes each file as
 * it arrives and never wants the set. A caller that does want the set builds
 * one from this in a line; the reverse is not true, which is what makes this
 * the shape rather than a Map. It also means an application's whole prose is
 * never resident at once, which is more than the store itself promises: row
 * documents hydrate one at a time and unload again, and this holds one file.
 *
 * Row ids come from the faithful read, so a table this declaration no longer
 * names is rendered too (ADR-0240).
 *
 * **It does not fail closed, and the read direction does.** One row whose
 * codec throws yields one `Err` and the pass continues, because a mirror that
 * writes nothing over one bad note is worse than a mirror missing one file,
 * and the next commit re-renders it anyway. `readArtifact` keeps the opposite
 * contract for the opposite reason: it feeds a restore that replaces a
 * store, so a file it silently skipped is data deleted everywhere.
 */
export async function* renderArtifact(
	data: RenderableData,
	definition: DataDefinition,
): AsyncGenerator<Result<RenderedRow, RenderError>> {
	const parsed = parseData(definition);
	if (parsed.error !== null) {
		yield RenderError.MalformedDefinition({ reason: parsed.error.message });
		return;
	}
	// One faithful read for the whole pass, so every file describes one instant.
	const state = data.stored();

	yield Ok({
		path: 'kv.json',
		contents: JSON.stringify(state.kv, null, 2),
	});
	for (const [table, rows] of state.tables) {
		for (const rowId of rows.keys()) {
			yield await renderRow(data, parsed.data, table, rowId);
		}
	}
}
