import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import {
	type DocumentFormat,
	inspectDocumentFormat,
} from './document-format.js';
import { formatDocumentGuid } from './document-guid.js';

declare const documentReferenceBrand: unique symbol;

/** One explicit format-addressed child-document identity. */
export type DocumentReference<TFormat extends DocumentFormat = DocumentFormat> =
	{
		guid(rowId: string): Guid;
		readonly [documentReferenceBrand]: TFormat;
	};

/** Coordinates for one retained child-document endpoint. */
export type HistoricalDocumentDefinition<
	TFormat extends DocumentFormat = DocumentFormat,
> = {
	workspaceId: string;
	table: string;
	document: string;
	format: TFormat;
};

const definitions = new WeakMap<object, HistoricalDocumentDefinition>();

/** @internal Build current references from an immutable workspace definition. */
export function createDocumentReference<const TFormat extends DocumentFormat>({
	workspaceId,
	table,
	document,
	format,
}: HistoricalDocumentDefinition<TFormat>): DocumentReference<TFormat> {
	assertSafeSegment(workspaceId, 'document workspace id');
	assertSafeSegment(table, 'document table name');
	assertSafeSegment(document, 'document name');
	inspectDocumentFormat(format);

	const reference = Object.freeze({
		guid: (rowId: string) =>
			formatDocumentGuid({ workspaceId, table, rowId, document, format }),
	}) as DocumentReference<TFormat>;
	definitions.set(
		reference,
		Object.freeze({ workspaceId, table, document, format }),
	);
	return reference;
}

/**
 * Name one retained old child-document endpoint for explicit conversion.
 *
 * This creates no registry and opens nothing. The current workspace's document
 * runtime may open it only when `workspaceId` matches the workspace it
 * already owns.
 */
export function historicalDocument<const TFormat extends DocumentFormat>(
	definition: HistoricalDocumentDefinition<TFormat>,
): DocumentReference<TFormat> {
	return createDocumentReference(definition);
}

/** @internal Inspect a nominal reference at the workspace-owned open seam. */
export function inspectDocumentReference<TFormat extends DocumentFormat>(
	reference: DocumentReference<TFormat>,
): HistoricalDocumentDefinition<TFormat> {
	const definition = definitions.get(reference);
	if (!definition) throw new Error('Unknown document reference');
	return definition as HistoricalDocumentDefinition<TFormat>;
}
