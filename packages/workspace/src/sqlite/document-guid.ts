import { docGuid } from '../document/doc-guid.js';
import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { sha256Hex } from '../shared/sha256.js';
import {
	type DocumentFormat,
	inspectDocumentFormat,
} from './document-format.js';

/**
 * Derive one format-addressed child-document guid for the SQLite workspace path.
 *
 * The established four owner segments remain readable from the left. The final
 * digest segment fences incompatible document formats without coupling them to
 * records-epoch changes:
 *
 * `<workspace>.<table>.<row-id digest>.<document>.<format digest>`
 *
 * Record ids are application values, not storage-path segments. Hashing the
 * complete JSON string encoding gives every admissible JavaScript string one
 * collision-resistant fixed-size safe segment without narrowing the record
 * schema to a filename grammar. JSON escaping preserves distinct lone UTF-16
 * surrogates that `TextEncoder` alone would replace with the same character.
 */
export function formatDocumentGuid({
	workspaceId,
	table,
	rowId,
	document,
	format,
}: {
	workspaceId: string;
	table: string;
	rowId: string;
	document: string;
	format: DocumentFormat;
}): Guid {
	const rowIdDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify(rowId)}`,
	);
	const base = docGuid({
		workspaceId,
		collection: table,
		rowId: rowIdDigest,
		field: document,
	});
	const digest = inspectDocumentFormat(format).formatHash.slice(
		'sha256:'.length,
	);
	assertSafeSegment(digest, 'document format hash');
	return `${base}.${digest}` as Guid;
}
