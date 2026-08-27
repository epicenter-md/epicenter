/**
 * The document half of a workspace export (ADR-0267).
 *
 * A follower composed on the opened data's public surface, like the SQL
 * projection: it walks every table that declares a `file` codec (ADR-0264),
 * opens each row's document, and serializes it to one legible file per
 * document. The bytes it never reads and the identity it never keeps are the
 * whole point of the codec living in the application: Epicenter turns the
 * handle into text through the application's own `serialize`, and knows nothing
 * about the format.
 *
 * The codecs are read from `parseData(definition)` rather than the opened
 * `data.definition`, because the latter is the inert snapshot with its behavior
 * functions stripped (ADR-0266). The caller already holds the authored
 * definition it opened the data with, so it passes it here.
 */
import {
	type DataDefinition,
	type DocumentReader,
	parseData,
} from '../definition/index.js';
import type { RowDocumentHandle } from '../store/documents.js';

/** One serialized row document, at its export path's coordinates. */
export type DocumentFile = {
	readonly table: string;
	readonly rowId: string;
	readonly extension: string;
	readonly text: string;
};

/**
 * The slice of opened data an export walks: each table's ids and its document
 * opener. Structural on purpose, so any typed or untyped view satisfies it.
 */
export type ExportableData = {
	readonly tables: Readonly<
		Record<
			string,
			{
				ids(): string[];
				openDocument(
					rowId: string,
				): Promise<{ data: RowDocumentHandle | undefined | null }>;
			}
		>
	>;
};

/**
 * Serialize every row document whose table declares a `file` codec.
 *
 * The path a caller writes each file to is `documents/{table}/{rowId}.{ext}`
 * (ADR-0267); this returns the coordinates and the text, and leaves assembling
 * the archive to the caller. A row that holds no document yet is skipped: it
 * has nothing to serialize, which is a fact rather than a failure.
 */
export async function exportDocuments(
	data: ExportableData,
	definition: DataDefinition,
): Promise<DocumentFile[]> {
	const parsed = parseData(definition);
	if (parsed.error !== null) {
		throw new Error(parsed.error.message, { cause: parsed.error });
	}
	const files: DocumentFile[] = [];
	for (const [table, parsedTable] of parsed.data.tables) {
		const file = parsedTable.document?.file;
		if (file === undefined) continue;
		const handle = data.tables[table];
		if (handle === undefined) continue;
		for (const rowId of handle.ids()) {
			const opened = await handle.openDocument(rowId);
			const doc = opened.data;
			if (doc === undefined || doc === null) continue;
			try {
				files.push({
					table,
					rowId,
					extension: file.extension,
					text: file.serialize(doc as unknown as DocumentReader),
				});
			} finally {
				doc[Symbol.dispose]();
			}
		}
	}
	return files;
}
