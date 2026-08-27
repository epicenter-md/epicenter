/**
 * A workspace export: the legible folder-structured artifact (ADR-0267).
 *
 * Composed on the opened data's public surface, so it is a follower and not a
 * store verb. It returns a map from path to content; assembling those into a
 * ZIP or writing them to a directory is the caller's, because where the bytes
 * land differs by host and the shape here does not.
 *
 * ```txt
 * tables.json                     scalar rows and fields, by table
 * kv.json                         the kv root's final state
 * documents/<table>/<row>.<ext>   each row document through its file codec
 * ```
 */
import { type DataDefinition, parseData } from '../definition/index.js';
import type { RowDocumentHandle } from '../store/documents.js';
import { exportDocuments } from './documents.js';

type ExportRow = { id: string } & Record<string, unknown>;

/** The slice of opened data an export reads: kv, each table's rows, and its documents. */
export type WorkspaceData = {
	readonly kv: {
		get(): {
			data: object | null;
			error: { readonly conforming: object } | null;
		};
	};
	readonly tables: Readonly<
		Record<
			string,
			{
				ids(): string[];
				list(): {
					rows: ExportRow[];
					nonconforming: { id: string; raw: object }[];
				};
				openDocument(
					rowId: string,
				): Promise<{ data: RowDocumentHandle | undefined | null }>;
			}
		>
	>;
};

/** Serialize a whole workspace to its export files, keyed by path. */
export async function exportWorkspace(
	data: WorkspaceData,
	definition: DataDefinition,
): Promise<ReadonlyMap<string, string>> {
	const files = new Map<string, string>();

	const kv = data.kv.get();
	files.set(
		'kv.json',
		JSON.stringify(kv.data ?? kv.error?.conforming ?? {}, null, 2),
	);

	const parsed = parseData(definition);
	if (parsed.error !== null) {
		throw new Error(parsed.error.message, { cause: parsed.error });
	}
	const tables: Record<string, ExportRow[]> = {};
	for (const [tableName] of parsed.data.tables) {
		const handle = data.tables[tableName];
		if (handle === undefined) continue;
		const listed = handle.list();
		// A row this release cannot read is exported by its raw stored values, so
		// the artifact never silently drops a row the declaration moved past.
		tables[tableName] = [
			...listed.rows,
			...listed.nonconforming.map((bad) => ({ id: bad.id, ...bad.raw })),
		];
	}
	files.set('tables.json', JSON.stringify(tables, null, 2));

	for (const file of await exportDocuments(data, definition)) {
		files.set(
			`documents/${file.table}/${file.rowId}.${file.extension}`,
			file.text,
		);
	}

	return files;
}
