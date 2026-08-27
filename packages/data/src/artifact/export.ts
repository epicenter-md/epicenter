/**
 * A workspace export: the legible folder-structured artifact (ADR-0267,
 * ADR-0268).
 *
 * Composed on the opened data's public surface, so it is a follower and not a
 * store verb. It returns a map from path to content; assembling those into a
 * ZIP or writing them to a directory is the caller's, because where the bytes
 * land differs by host and the shape here does not.
 *
 * ```txt
 * kv.json              the kv root's stored values
 * <table>/<rowId>.md   one file per row: raw fields as frontmatter, and the
 *                      document through the table's codec as the body
 * ```
 *
 * One Markdown file per row (ADR-0268): the row's identity is the path, its
 * fields are the frontmatter, and its prose is the body, so a note is one
 * file a person reads whole and an import consumes atomically. Two exports of
 * one workspace diff per row.
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
import { rowFile } from './frontmatter.js';

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
	// Coordinates join bodies to rows losslessly: neither a table name nor a
	// row id can hold a `/` (the address grammar), so the joined key is exact.
	const bodies = new Map<string, string>();
	for (const file of documents.data) {
		bodies.set(`${file.table}/${file.rowId}`, file.text);
	}

	const files = new Map<string, string>();
	files.set('kv.json', JSON.stringify(state.kv, null, 2));
	for (const [table, rows] of state.tables) {
		for (const [rowId, values] of rows) {
			files.set(
				`${table}/${rowId}.md`,
				rowFile(values, bodies.get(`${table}/${rowId}`)),
			);
		}
	}
	return Ok(files);
}
