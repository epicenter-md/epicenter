/**
 * The artifact read back: files in, one envelope out (ADR-0267, ADR-0268).
 *
 * The mirror of `exportStore`, and deliberately the same kind of thing: a
 * pure function over the public vocabulary, composed outside the store. It
 * rebuilds the application document from every row file's frontmatter and each
 * row's own document from that file's body through the table's codec, then
 * encodes both halves as one envelope, exactly the shape `encodeSnapshot`
 * produces from a live replica.
 *
 * Producing bytes rather than writing them is what keeps import honest about
 * where the destruction happens. Replacing a store means discarding its
 * durable record and letting it refill (ADR-0231's supersession), which is an
 * act on an address rather than on a live store, and belongs to whoever owns
 * the address. This function is the half that can be tested by reading its
 * output, and it holds no handle to anything a mistake could destroy.
 *
 * It fails closed, for the same reason the export does: what comes out of here
 * replaces a store, so a file it could not read is a refusal rather than a
 * row quietly left out.
 */

import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type DataDefinition,
	type DocumentReader,
	documentAddress,
	type JsonObject,
	parseData,
} from '../definition/index.js';
import {
	createAppDocument,
	createRow,
	kvRoot,
	tableRoot,
} from '../store/document.js';
import { APP_DOCUMENT } from '../store/log.js';
import { parseRowFile } from './frontmatter.js';
import { parseRowPath } from './layout.js';

export const ImportError = defineErrors({
	/**
	 * The definition handed to the import could not be compiled, so there are
	 * no codecs to deserialize through. The export refuses the same way.
	 */
	MalformedDefinition: ({ reason }: { reason: string }) => ({
		message: `The data definition could not be compiled: ${reason}`,
		reason,
	}),
	/**
	 * A file in the artifact is not the file its path says it is. Fatal: an
	 * import that skipped it would replace a store with less than the
	 * person handed it.
	 */
	MalformedFile: ({ path, reason }: { path: string; reason: string }) => ({
		message: `'${path}' could not be read: ${reason}`,
		path,
		reason,
	}),
	/**
	 * A row file carries a body and its table declares no codec to read it
	 * with, so the prose has nowhere to go. Fatal rather than dropped: losing
	 * a body on import is the failure ADR-0268 exists to prevent, arriving
	 * from the other direction.
	 */
	UncodedBody: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `'${table}/${rowId}.md' has a body and table '${table}' declares no file codec to read it`,
		table,
		rowId,
	}),
	/** The table's own `deserialize` threw on this body. */
	BodyUnreadable: ({
		table,
		rowId,
		cause,
	}: {
		table: string;
		rowId: string;
		cause: unknown;
	}) => ({
		message: `The body of '${table}/${rowId}.md' could not be deserialized`,
		table,
		rowId,
		cause,
	}),
});
export type ImportError = InferErrors<typeof ImportError>;

/** One document an artifact carries, ready to be written or uploaded. */
export type ArtifactDocument = {
	/** `app`, or a row's derived address. */
	readonly document: string;
	/** The document's whole state, as one `updateV2`. */
	readonly bytes: Uint8Array;
};

/**
 * Read a whole artifact into the documents that make up a store.
 *
 * Documents rather than one packed value, because there is nothing left to
 * pack into: a mint uploads them one at a time to their own addresses
 * (ADR-0286), and a local import writes them one at a time into a chain. The
 * envelope this used to return existed to batch several documents into one
 * entry of a positional log, and ADR-0277 deleted the log.
 *
 * Paths are the addressing, as they are on the way out: `kv.json` is the kv
 * root, and every `<table>/<rowId>.md` is one row. A table the definition no
 * longer declares is imported anyway, rows and all, because the artifact is
 * the truth here and a declaration that stopped naming a table never meant its
 * data was gone (ADR-0240). Anything else in the map is not part of the
 * artifact and is left alone: a `.DS_Store` beside a person's folder is not a
 * reason to refuse their data.
 */
export function readArtifact(
	files: ReadonlyMap<string, string>,
	definition: DataDefinition,
): Result<ArtifactDocument[], ImportError> {
	const parsed = parseData(definition);
	if (parsed.error !== null) {
		return ImportError.MalformedDefinition({ reason: parsed.error.message });
	}
	const dataId = parsed.data.id;

	const app = createAppDocument();
	const documents: ArtifactDocument[] = [];
	try {
		const kv = files.get('kv.json');
		if (kv !== undefined) {
			const values = parseKv(kv);
			if (values === undefined) {
				return ImportError.MalformedFile({
					path: 'kv.json',
					reason: 'it is not a JSON object',
				});
			}
			app.transact(() => {
				const root = kvRoot(app);
				for (const [key, value] of Object.entries(values)) {
					root.setAttr(key as never, value as never);
				}
			});
		}

		for (const [path, text] of files) {
			const at = parseRowPath(path);
			if (at === undefined) continue;
			const row = parseRowFile(text);
			if (row === undefined) {
				return ImportError.MalformedFile({
					path,
					reason: 'it does not open with a frontmatter block',
				});
			}
			try {
				app.transact(() => {
					createRow(tableRoot(app, at.table), at.rowId, row.fields);
				});
			} catch (cause) {
				return ImportError.MalformedFile({
					path,
					reason: cause instanceof Error ? cause.message : String(cause),
				});
			}

			if (row.body === '') continue;
			const codec = parsed.data.tables.get(at.table)?.document?.file;
			if (codec === undefined) {
				return ImportError.UncodedBody({ table: at.table, rowId: at.rowId });
			}
			const body = new Y.Doc({ gc: true });
			try {
				codec.deserialize(row.body, body as unknown as DocumentReader);
				documents.push({
					document: documentAddress({
						dataId,
						tableName: at.table,
						rowId: at.rowId,
					}),
					bytes: new Uint8Array(Y.encodeStateAsUpdateV2(body)),
				});
			} catch (cause) {
				return ImportError.BodyUnreadable({
					table: at.table,
					rowId: at.rowId,
					cause,
				});
			} finally {
				body.destroy();
			}
		}

		// The application document leads: a row's document is meaningless
		// without the row it belongs to, and a mint uploads it LAST for the same
		// reason read backwards, since it is what makes a generation reachable
		// (ADR-0286). A consumer that writes in order is safe either way.
		return Ok([
			{
				document: APP_DOCUMENT,
				bytes: new Uint8Array(Y.encodeStateAsUpdateV2(app)),
			},
			...documents,
		]);
	} finally {
		app.destroy();
	}
}

function parseKv(text: string): JsonObject | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as JsonObject;
}
