import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

// Language-level codec (Markdown, JSON, TOML+body, etc.)
export interface Codec<TID extends string, TExt extends string> {
	/** Unique identifier (e.g., 'markdown', 'json', 'toml', 'yaml-md') */
	id: TID;
	/** Default file extension without dot
	 * @example 'md'
	 */
	fileExtension: TExt;
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
	/** Optional value normalization before writing (e.g., Date -> ISO string) */
	normalize?(value: unknown, columnName: string): unknown;
	/** Optional value denormalization after reading (e.g., ISO string -> Date) */
	denormalize?(value: unknown, columnName: string): unknown;
}

// Runtime view of a Drizzle table
export type TableEntry = [name: string, table: SQLiteTable];
export type ColumnEntry = [name: string, column: SQLiteColumn];

// Per-codec convention profile that derives mapping decisions from schema + naming
export interface ConventionProfile {
	// compute relative path from table + pk values
	pathFor(
		adapterId: string,
		tableName: string,
		pkValues: Record<string, unknown>,
	): string;
	// map a table name to a dataset key used by Importer.validator/upsert
	datasetKeyFor(adapterId: string, tableName: string): string;
}

// Helpers
export function listTables(schema: Record<string, SQLiteTable>): TableEntry[] {
	return Object.entries(schema) as TableEntry[];
}

export function listColumns(table: SQLiteTable): ColumnEntry[] {
	return Object.entries(table) as ColumnEntry[];
}

// Best-effort PK detection from Drizzle runtime objects.
// Falls back to common naming if metadata is absent.
export function detectPrimaryKey(
	tableName: string,
	table: SQLiteTable,
): string[] | undefined {
	const cols = listColumns(table);
	const pkCols: string[] = [];
	for (const [name, col] of cols) {
		// Drizzle columns expose some shape at runtime; check common fields defensively.
		const anyCol = col;
		if (anyCol.primary === true && !pkCols.includes(name)) {
			pkCols.push(name);
		}
	}
	if (pkCols.length > 0) return pkCols;
	// Heuristic fallback by naming
	if ('id' in table) return ['id'];
	if (`${tableName}_id` in table) return [`${tableName}_id`];
	return undefined;
}

// Choose body column by common names, prefer notNull string-like columns named body/content/text
// (Body selection moved to the codecs themselves.)

// Default per-codec convention profile (opinionated)
// Picks a body-capable format (prefer 'markdown') when body column exists; else 'json'.
export function defaultConvention(): ConventionProfile {
	return {
		pathFor(adapterId, tableName, pkValues) {
			const parts = Object.entries(pkValues)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, v]) => String(v));
			const fileId = parts.length > 0 ? parts.join('__') : 'row';
			// extension decided by mode at callsite; we return a directory path root here
			return `vault/${adapterId}/${tableName}/${fileId}`;
		},
		datasetKeyFor(adapterId, tableName) {
			return tableName.startsWith(`${adapterId}_`)
				? tableName.slice(adapterId.length + 1)
				: tableName;
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
