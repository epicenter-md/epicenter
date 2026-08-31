/**
 * A row becomes one file (ADR-0268, ADR-0271, ADR-0296).
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
 * **The platform owns the format; the table owns the mapping** (ADR-0296).
 * What is here is the fence: the frontmatter block, the blank separator, and
 * the body beneath it. What the codec answers is which values go above the
 * fence and what text goes below it.
 *
 * Composed on the opened data's public surface, so it is a follower and never
 * a store verb. It reads; nothing it returns can reach back in.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	parseData,
} from '../definition/index.js';
import type { Row, StoredData } from '../store/store.js';
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
	 * The table declares a content node and no codec to write it with, so this
	 * row's body has nowhere to go. Fatal for the row: a file that quietly
	 * lacks its prose feeds a restore that would delete that prose everywhere.
	 *
	 * Unreachable through `defineTable`, whose parameter type refuses it. It is
	 * reachable through a definition that arrived as JSON, which cannot carry a
	 * function, and that is exactly the case a silent empty body would ruin.
	 */
	UncodedRow: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Table '${table}' declares a content node and no file codec to write '${rowId}' with`,
		table,
		rowId,
	}),
	/** The faithful row is malformed: it does not own the required content node. */
	MalformedRow: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Row '${table}/${rowId}' has no live content node to write`,
		table,
		rowId,
	}),
	/**
	 * The table's own `encode` threw on this row. Contained rather than
	 * allowed to escape: a codec that throws is a case a person needs told,
	 * not a stack trace in the middle of their data being written to disk.
	 */
	BodyUnwritable: ({
		table,
		rowId,
		cause,
	}: {
		table: string;
		rowId: string;
		cause: unknown;
	}) => ({
		message: `The row at '${table}/${rowId}' could not be serialized`,
		table,
		rowId,
		cause,
	}),
});
export type RenderError = InferErrors<typeof RenderError>;

/**
 * The slice of opened data a render reads: the faithful reads, and each
 * table's content node. Structural on purpose, so any typed or untyped view
 * satisfies it.
 */
/**
 * What a render needs, and it is not a table handle.
 *
 * Two faithful reads, both on the store: everything, and one row. A handle
 * would be the wrong shape twice over, because it narrows to the declared
 * fields and refuses a row it cannot conform, and an export may do neither
 * (ADR-0267). This used to reach through `data.tables[table].stored/content`,
 * which meant the artifact layer's requirements sat on the type every
 * application holds.
 */
export type RenderableData = {
	/**
	 * The raw reads, declared as the slice this module needs rather than taken
	 * as a whole store.
	 *
	 * They live under `store` because they are not application verbs: they
	 * return keys this release no longer declares and rows it cannot conform,
	 * which is the one thing an export may not narrow (ADR-0267). A table
	 * handle answers what an application can see; these answer what is there.
	 */
	stored(): StoredData;
	rowFile(table: string, rowId: string): Row | undefined;
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
 * Synchronous work behind an async signature, because nothing here loads
 * anything any more: a row's content node is in the one document the store
 * already holds (ADR-0295). The signature stays a promise so the mirror and
 * the whole-artifact generator did not have to change shape around it.
 *
 * Everything scalar comes from the faithful read, never from `get` or `list`.
 * A table handle reads through the declaration and narrows to the fields it
 * names, so rendering through the lens would drop a value an older release
 * wrote: the row still conforms, so it is not reported as nonconforming, and
 * the value is simply gone from the file. That is the one thing an artifact
 * may not do, which is why the codec is handed the STORED payload rather than
 * a conformed row, and why a codec that spreads what it was given keeps
 * everything the store holds.
 */
export async function renderRow(
	data: RenderableData,
	definition: ParsedDataDefinition,
	table: string,
	rowId: string,
): Promise<Result<RenderedRow, RenderError>> {
	const path = rowPath(table, rowId);
	const row = data.rowFile(table, rowId);
	if (row === undefined) {
		return Ok({ path, contents: undefined });
	}
	const { id: _id, content, ...values } = row;
	if (!(content instanceof Y.Type)) {
		return RenderError.MalformedRow({ table, rowId });
	}
	// The scalars ARE the frontmatter, by field name. The platform writes them,
	// because the name is already the durable key in the document and a second
	// name on disk would be a second copy of an identifier.
	const fields: JsonObject = {};
	for (const [name, value] of Object.entries(values)) {
		if (!(value instanceof Y.Type)) fields[name] = value as JsonValue;
	}

	const node = content;
	const codec = definition.tables.get(table)?.content;
	if (codec === undefined) {
		// A definition that arrived as JSON carries no codec, and a row whose
		// node is empty has nothing that needed one: its file is its frontmatter,
		// which is the whole of what it is (ADR-0296). A node WITH content and no
		// codec has a body it cannot write, and writing the file without it is
		// the data loss this refuses.
		if (node.length > 0 || [...node.attrKeys()].length > 0) {
			return RenderError.UncodedRow({ table, rowId });
		}
		return Ok({ path, contents: rowFile(fields, undefined) });
	}

	try {
		return Ok({
			path,
			contents: rowFile(fields, codec.encode(node)),
		});
	} catch (cause) {
		return RenderError.BodyUnwritable({ table, rowId, cause });
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
 * the shape rather than a Map.
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
