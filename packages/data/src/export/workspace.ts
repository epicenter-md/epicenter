/**
 * A workspace export: the legible folder-structured artifact (ADR-0267).
 *
 * Composed on the opened data's public surface, so it is a follower and not a
 * store verb. It returns a map from path to content; assembling those into a
 * ZIP or writing them to a directory is the caller's, because where the bytes
 * land differs by host and the shape here does not.
 *
 * ```txt
 * kv.json                         the kv root's stored values
 * tables/<table>.json             one file per table, rows by id
 * documents/<table>/<row>.<ext>   each row document through its file codec
 * ```
 *
 * One file per table rather than one `tables.json`, for the same reason there
 * is one file per document: the path is already doing the addressing, and two
 * exports of the same workspace diff per table and per note instead of as one
 * enormous hunk.
 *
 * Everything scalar comes from `data.stored()`, never from `list()`. A table
 * handle reads through the declaration and narrows to the fields it names, so
 * exporting through it would drop a value an older release wrote: healthy rows
 * lose it silently, which is the one thing a backup may not do.
 */
import { Ok, type Result } from 'wellcrafted/result';

import type { DataDefinition } from '../definition/index.js';
import type { StoredData } from '../store/store.js';
import {
	type ExportableData,
	type ExportError,
	exportDocuments,
} from './documents.js';

/** The slice of opened data an export reads. */
export type WorkspaceData = ExportableData;

/**
 * Serialize a whole workspace to its export files, keyed by path.
 *
 * Fails closed: a document that cannot be read abandons the artifact rather
 * than producing one that quietly lacks a body, because an import replaces the
 * workspace with what this returns.
 */
export async function exportWorkspace(
	data: WorkspaceData,
	definition: DataDefinition,
): Promise<Result<ReadonlyMap<string, string>, ExportError>> {
	// One faithful read for the whole artifact, so the rows written and the
	// documents walked describe the same instant.
	const state: StoredData = data.stored();

	const documents = await exportDocuments(data, definition, state);
	if (documents.error !== null) return documents;

	const files = new Map<string, string>();
	files.set('kv.json', JSON.stringify(state.kv, null, 2));
	for (const [table, rows] of state.tables) {
		const byId: Record<string, unknown> = {};
		for (const [rowId, values] of rows) byId[rowId] = values;
		files.set(`tables/${table}.json`, JSON.stringify(byId, null, 2));
	}
	for (const file of documents.data) {
		files.set(
			`documents/${file.table}/${file.rowId}.${file.extension}`,
			file.text,
		);
	}
	return Ok(files);
}
