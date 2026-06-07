/**
 * Generate SQLite DDL from a workspace table's latest-version row schema.
 *
 * Callers pass `definition.schema` (a TypeBox `TObject` which is itself a
 * JSON Schema). Column storage class and nullability are read from the schema
 * structure (the lenient `deriveStorage` / `isNullable` helpers below), so
 * `nullable(column.X())` rows map cleanly to nullable SQLite columns.
 *
 * Since `_v` is library-managed and stripped from the user-facing row schema,
 * the generated DDL never contains a `_v` column. SQLite projects only what
 * the user declared.
 *
 * @module
 */

import type { TSchema } from 'typebox';

type JsonSchema = Record<string, unknown>;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement for a workspace table.
 *
 * Maps the table's latest-version row JSON Schema into a SQLite table
 * definition. Required scalar fields become `NOT NULL`, `id` becomes the
 * primary key, and complex values are stored as JSON text.
 *
 * @param tableName - The SQLite table name to create
 * @param jsonSchema - The JSON Schema for the table's row type
 * @returns A `CREATE TABLE IF NOT EXISTS` SQL statement
 *
 * @example
 * ```typescript
 * const sql = generateDdl('posts', {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string' },
 *     title: { type: 'string' },
 *     published: { type: 'boolean' },
 *   },
 *   required: ['id', 'title'],
 * });
 *
 * // CREATE TABLE IF NOT EXISTS "posts" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "published" INTEGER)
 * ```
 */
export function generateDdl(tableName: string, jsonSchema: TSchema): string {
	const resolved = jsonSchema as unknown as JsonSchema;

	if (!isRecord(resolved.properties)) {
		throw new Error(
			'SQLite DDL generation requires an object schema with properties.',
		);
	}

	const properties = resolved.properties;
	const required = new Set(
		Array.isArray(resolved.required)
			? (resolved.required as unknown[]).filter(
					(value): value is string => typeof value === 'string',
				)
			: [],
	);

	const columns = Object.entries(properties).map(([name, propSchema]) => {
		if (!isRecord(propSchema)) {
			throw new Error(
				`SQLite DDL generation requires property "${name}" schema to be an object.`,
			);
		}
		return columnDef(name, propSchema as TSchema, required.has(name));
	});

	return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columns.join(', ')})`;
}

/** Double-quote a SQL identifier, escaping embedded quotes. */
export function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`;
}

// ════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function columnDef(
	name: string,
	propSchema: TSchema,
	isRequired: boolean,
): string {
	const quotedName = quoteIdentifier(name);

	if (name === 'id') {
		return `${quotedName} TEXT PRIMARY KEY`;
	}

	const storage = deriveStorage(propSchema);
	const nullable = !isRequired || isNullable(propSchema);

	return nullable
		? `${quotedName} ${storage}`
		: `${quotedName} ${storage} NOT NULL`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── storage-class and nullability derivation ────────────────────────────────
//
// The materializer reads schemas directly: storage class and nullability fall
// out of the JSON Schema structure, not from any column wrapper or extension
// keyword. `FlatJsonTSchema` already restricts every column to a `~kind` with a
// single SQLite storage class, so these reads only have to look at what is there.

type SqliteStorage = 'TEXT' | 'INTEGER' | 'REAL';

type SchemaShape = {
	type?: string;
	const?: unknown;
	anyOf?: TSchema[];
};

function asShape(schema: TSchema): SchemaShape {
	return schema as unknown as SchemaShape;
}

/**
 * Derive the SQLite storage class for a column.
 *
 * - `string` / array / object → `TEXT` (objects and arrays are JSON-encoded)
 * - `integer` / `boolean` → `INTEGER` (booleans store as 0/1 by SQLite convention)
 * - `number` → `REAL`
 * - `const`: numeric integer → `INTEGER`, otherwise `TEXT`
 * - `anyOf` with a single non-null branch → recurse into that branch
 * - `anyOf` mixed → `TEXT` (JSON-encoded fallback)
 */
function deriveStorage(schema: TSchema): SqliteStorage {
	const s = asShape(schema);
	if (s.type === 'integer') return 'INTEGER';
	if (s.type === 'number') return 'REAL';
	if (s.type === 'boolean') return 'INTEGER';
	if (s.type === 'string') return 'TEXT';
	if (s.type === 'array' || s.type === 'object') return 'TEXT';
	if (s.const !== undefined) {
		return typeof s.const === 'number' && Number.isInteger(s.const)
			? 'INTEGER'
			: 'TEXT';
	}
	if (s.anyOf) {
		const nonNull = s.anyOf.filter((branch) => asShape(branch).type !== 'null');
		if (nonNull.length === 1) {
			const only = nonNull[0];
			if (only) return deriveStorage(only);
		}
		return 'TEXT';
	}
	return 'TEXT';
}

/** Whether the column's union includes a `Type.Null()` branch. */
function isNullable(schema: TSchema): boolean {
	const s = asShape(schema);
	return Boolean(s.anyOf?.some((branch) => asShape(branch).type === 'null'));
}
