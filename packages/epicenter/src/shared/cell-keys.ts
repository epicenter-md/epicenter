/**
 * Cell key primitives for compound key encoding.
 *
 * Encodes (rowId, columnId) pairs as colon-separated strings.
 * - rowId MUST NOT contain ':' (validated, throws on violation)
 * - columnId MAY contain ':' (split on first colon only)
 *
 * ## Type Encoding
 *
 * Template literal types encode the structure of each string shape:
 * ```
 * RowPrefix = `${string}:`              ← "row-1:"
 * CellKey   = `${RowPrefix}${string}`   ← "row-1:title"
 * ```
 *
 * ## Naming Convention
 *
 * PascalCase functions (`CellKey`, `RowPrefix`) are constructors that return
 * typed values. camelCase functions (`parseCellKey`, `extractRowId`) are
 * utilities that return plain strings.
 *
 * @module
 */

/** The separator character used in compound cell keys. */
export const KEY_SEPARATOR = ':' as const;

/** A row prefix: `rowId:`. Used for scanning all cells in a row. */
export type RowPrefix = `${string}${typeof KEY_SEPARATOR}`;

/** A compound cell key: `rowId:columnId`. Composed from a RowPrefix + columnId. */
export type CellKey = `${RowPrefix}${string}`;

/** Compose a cell key from rowId and columnId. Throws if rowId contains ':'. */
export function CellKey(rowId: string, columnId: string): CellKey {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}${columnId}`;
}

/** Parse a cell key into rowId and columnId. Splits on first ':' only. */
export function parseCellKey(key: string): { rowId: string; columnId: string } {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return { rowId: key.slice(0, idx), columnId: key.slice(idx + 1) };
}

/** Create a row prefix for scanning all cells in a row. Throws if rowId contains ':'. */
export function RowPrefix(rowId: string): RowPrefix {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}`;
}

/** Extract rowId from a cell key. Faster than parseCellKey when columnId isn't needed. */
export function extractRowId(key: string): string {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return key.slice(0, idx);
}
