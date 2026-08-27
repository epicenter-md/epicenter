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
 * It fails closed. A document whose stored chain cannot be read is not a file
 * this export may omit: an export feeds an import that REPLACES the workspace,
 * so a quietly missing body is a body destroyed on every device. Enumeration
 * trouble aborts the whole artifact rather than shipping a partial one.
 *
 * The codecs are read from `parseData(definition)` rather than the opened
 * `data.definition`, because the latter is the inert snapshot with its behavior
 * functions stripped (ADR-0266). The caller already holds the authored
 * definition it opened the data with, so it passes it here.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type DataDefinition,
	type DocumentReader,
	parseData,
} from '../definition/index.js';
import type { RowDocumentHandle } from '../store/documents.js';
import type { StoredData } from '../store/store.js';

export const ExportError = defineErrors({
	/**
	 * The definition handed to the export could not be compiled, so there are
	 * no codecs to serialize through. A programmer error surfaced as a value,
	 * because the caller here is a person pressing a button.
	 */
	MalformedDefinition: ({ reason }: { reason: string }) => ({
		message: `The data definition could not be compiled: ${reason}`,
		reason,
	}),
	/**
	 * A row's document could not be opened, so this export cannot say what that
	 * body holds. Fatal on purpose: the artifact is the input to a destructive
	 * import, and one that silently lacks a body deletes it everywhere.
	 */
	DocumentUnreadable: ({
		table,
		rowId,
		cause,
	}: { table: string; rowId: string; cause: unknown }) => ({
		message: `Document for '${table}/${rowId}' could not be read, so the export was abandoned`,
		table,
		rowId,
		cause,
	}),
});
export type ExportError = InferErrors<typeof ExportError>;

/** One serialized row document, at its export path's coordinates. */
export type DocumentFile = {
	readonly table: string;
	readonly rowId: string;
	readonly extension: string;
	readonly text: string;
};

/**
 * The slice of opened data an export walks: the faithful read, and each
 * table's document opener. Structural on purpose, so any typed or untyped
 * view satisfies it.
 */
export type ExportableData = {
	stored(): StoredData;
	readonly tables: Readonly<
		Record<
			string,
			{
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
 * Serialize every row document whose table declares a `file` codec.
 *
 * The path a caller writes each file to is `documents/{table}/{rowId}.{ext}`
 * (ADR-0267); this returns the coordinates and the text, and leaves assembling
 * the archive to the caller. Row ids come from the faithful read, so a row a
 * newer declaration no longer names still has its body exported.
 *
 * A row whose document was never written serializes as whatever the codec
 * makes of an empty document, which is the application's own answer to "this
 * body is empty" rather than a decision taken here.
 */
export async function exportDocuments(
	data: ExportableData,
	definition: DataDefinition,
	state: StoredData = data.stored(),
): Promise<Result<DocumentFile[], ExportError>> {
	const parsed = parseData(definition);
	if (parsed.error !== null) {
		return ExportError.MalformedDefinition({ reason: parsed.error.message });
	}
	const files: DocumentFile[] = [];
	for (const [table, parsedTable] of parsed.data.tables) {
		const file = parsedTable.document?.file;
		if (file === undefined) continue;
		const handle = data.tables[table];
		if (handle === undefined) continue;
		for (const rowId of state.tables.get(table)?.keys() ?? []) {
			const opened = await handle.openDocument(rowId);
			if (opened.error !== null && opened.error !== undefined) {
				return ExportError.DocumentUnreadable({
					table,
					rowId,
					cause: opened.error,
				});
			}
			const doc = opened.data;
			// The row was taken between the faithful read and this open. It has no
			// body to carry, and it is already absent from the rows being written.
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
	return Ok(files);
}
