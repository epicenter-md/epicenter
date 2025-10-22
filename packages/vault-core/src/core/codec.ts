import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

// Language-level codec (Markdown, JSON, TOML+body, etc.)
export interface Codec<TID extends string, TExt extends string> {
	/** Unique identifier (e.g., 'markdown', 'json', 'toml', 'yaml-md') */
	id: TID;
	/** Default file extension without dot
	 * @example 'md'
	 */
	fileExtension: TExt;
	/** MIME type for file exports (e.g., 'text/markdown', 'application/json') */
	mimeType: string;
	/**
	 * Parse file text into a flat record. If a free-form body is present,
	 * codecs should use the reserved key 'body' to carry it.
	 */
	parse(text: string): Record<string, unknown>;
	/**
	 * Stringify a flat record into file text. If a 'body' key is present,
	 * codecs that support bodies should place it appropriately (e.g., after
	 * frontmatter); others may serialize it as a normal field.
	 */
	stringify(rec: Record<string, unknown>): string;
}

// Runtime view of a Drizzle table
export type TableEntry = [name: string, table: SQLiteTable];
export type ColumnEntry = [name: string, column: SQLiteColumn];

// Per-codec convention profile that derives mapping decisions from schema + naming
export interface ConventionProfile {
	// compute relative path from table + pk values
	pathFor(adapterId: string, tableName: string, pkValues: string[]): string;
}

// Helpers
export function listTables(schema: Record<string, SQLiteTable>): TableEntry[] {
	return Object.entries(schema) as TableEntry[];
}

export function listColumns(table: SQLiteTable): ColumnEntry[] {
	return Object.entries(table) as ColumnEntry[];
}

/**
 * Find primary key columns in a table.
 *
 * Due to type-safety in adapter.ts, *all* tables should have a primary key.
 * @throws if no primary key found
 */
export function listPrimaryKeys(tableName: string, table: SQLiteTable) {
	const cols = listColumns(table);
	const pkCols = [];
	for (const col of cols) {
		const [, drizzleCol] = col;
		if (drizzleCol.primary) pkCols.push(col);
	}

	if (pkCols.length === 0)
		throw new Error(`Table ${tableName} has no primary key`);

	return pkCols;
}

// Choose body column by common names, prefer notNull string-like columns named body/content/text
// (Body selection moved to the codecs themselves.)

// Default per-codec convention profile (opinionated)
// Picks a body-capable format (prefer 'markdown') when body column exists; else 'json'.
export function defaultConvention(): ConventionProfile {
	return {
		pathFor(adapterId, tableName, pkValues) {
			// Merge PK values with __, sorted by key name for determinism
			const parts = pkValues
				.toSorted((a, b) => a.localeCompare(b))
				.map((v) => String(v));
			const fileId = parts.length > 0 ? parts.join('__') : 'row';
			// extension decided by mode at callsite; we return a directory path root here
			return `vault/${adapterId}/${tableName}/${fileId}`;
		},
	};
}

type NoDotPrefix<T extends string> = T extends `.${string}` ? never : T;

/**
 * defineFormat: identity helper for a single Codec (markdown, json, etc.).
 */
export function defineCodec<TID extends string, TExt extends string>(
	codec: Codec<TID, NoDotPrefix<TExt>>,
) {
	return codec;
}
