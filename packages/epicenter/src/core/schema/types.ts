/**
 * @fileoverview Core schema type definitions
 *
 * Contains the foundational types for the schema system:
 * - Column schema types (IdColumnSchema, TextColumnSchema, etc.)
 * - Table and workspace schemas
 * - Row value types (CellValue, SerializedRow, Row)
 *
 * Other schema-related types are co-located with their implementations:
 * - Id type and generateId function → id.ts
 * - DateWithTimezone types and functions → date-with-timezone.ts
 * - Validation types and functions → validation.ts
 */

import type { Type } from 'arktype';
import type * as Y from 'yjs';
import type { YRow } from '../db/table-helper';
import type {
	DateWithTimezone,
	DateWithTimezoneString,
} from './date-with-timezone';

// ============================================================================
// Column Schema Types
// ============================================================================

/**
 * Individual column schema types
 */
export type IdColumnSchema = { type: 'id'; nullable: false };

export type TextColumnSchema<TNullable extends boolean = boolean> = {
	type: 'text';
	nullable: TNullable;
	default?: string | (() => string);
};

export type YtextColumnSchema<TNullable extends boolean = boolean> = {
	type: 'ytext';
	nullable: TNullable;
};

export type IntegerColumnSchema<TNullable extends boolean = boolean> = {
	type: 'integer';
	nullable: TNullable;
	default?: number | (() => number);
};

export type RealColumnSchema<TNullable extends boolean = boolean> = {
	type: 'real';
	nullable: TNullable;
	default?: number | (() => number);
};

export type BooleanColumnSchema<TNullable extends boolean = boolean> = {
	type: 'boolean';
	nullable: TNullable;
	default?: boolean | (() => boolean);
};

export type DateColumnSchema<TNullable extends boolean = boolean> = {
	type: 'date';
	nullable: TNullable;
	default?: DateWithTimezone | (() => DateWithTimezone);
};

export type SelectColumnSchema<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = {
	type: 'select';
	nullable: TNullable;
	options: TOptions;
	default?: TOptions[number];
};

/**
 * Tags column schema for storing arrays of strings.
 * Use with the tags() function for validated or unconstrained string arrays.
 * @example
 * tags({ options: ['a', 'b'] }) // TagsColumnSchema<['a', 'b'], false>
 * tags() // TagsColumnSchema<[string, ...string[]], false>
 */
export type TagsColumnSchema<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = {
	type: 'multi-select';
	nullable: TNullable;
	options?: TOptions;
	default?: TOptions[number][];
};

/**
 * JSON column schema - stores arbitrary JSON-serializable values with StandardSchemaV1 validation.
 *
 * Unlike other column types, JSON columns use a `schema` property instead of `options`.
 * The schema must extend StandardSchemaV1 and is always required.
 *
 * **⚠️ Schema Property Constraints**
 *
 * The `schema` property value is converted to JSON Schema when this table schema is used
 * as an action input (via `validators.toStandardSchema()`) for MCP/CLI/OpenAPI. Avoid:
 *
 * - **Transforms**: `.pipe()` (ArkType), `.transform()` (Zod), `transform()` action (Valibot)
 * - **Custom validation**: `.filter()` (ArkType), `.refine()` (Zod), `check()`/`custom()` (Valibot)
 * - **Non-JSON types**: `bigint`, `symbol`, `undefined`, `Date`, `Map`, `Set`
 *
 * Use basic types (`string`, `number`, `boolean`, objects, arrays) and `.matching(regex)` for patterns.
 * For complex validation, validate in the handler instead.
 *
 * Learn more:
 * - Zod: https://zod.dev/json-schema?id=unrepresentable
 * - Valibot: https://www.npmjs.com/package/@valibot/to-json-schema
 * - ArkType: https://arktype.io/docs/configuration#fallback-codes
 *
 * @example
 * ```typescript
 * import { json } from 'epicenter/schema';
 * import { type } from 'arktype';
 *
 * // ✅ Good: JSON Schema compatible
 * const userPrefs = json({
 *   schema: type({
 *     theme: type.enumerated('light', 'dark'),
 *     notifications: 'boolean',
 *   }),
 * });
 *
 * // ✅ Good: With nullable and default
 * const metadata = json({
 *   schema: type({ key: 'string', value: 'string' }).array(),
 *   nullable: true,
 *   default: [],
 * });
 *
 * // ❌ Bad: Uses .filter() (custom validation)
 * // const badSchema = json({
 * //   schema: type('string').filter(s => s.includes('test'))
 * // });
 *
 * // ❌ Bad: Uses .pipe() (transformation)
 * // const badSchema = json({
 * //   schema: type('string').pipe(s => s.toUpperCase())
 * // });
 * ```
 */
export type JsonColumnSchema<
	TSchema extends Type = Type,
	TNullable extends boolean = boolean,
> = {
	type: 'json';
	nullable: TNullable;
	schema: TSchema;
	default?: TSchema['infer'] | (() => TSchema['infer']);
};

/**
 * Discriminated union of all column types
 */
export type ColumnSchema =
	| IdColumnSchema
	| TextColumnSchema
	| YtextColumnSchema
	| IntegerColumnSchema
	| RealColumnSchema
	| BooleanColumnSchema
	| DateColumnSchema
	| SelectColumnSchema
	| TagsColumnSchema
	| JsonColumnSchema;

/**
 * Extract just the type names from ColumnSchema
 */
export type ColumnType = ColumnSchema['type'];

/**
 * Table schema - maps column names to their schemas.
 * This is the pure schema definition that describes the structure of a table.
 * Must always include an 'id' column with IdColumnSchema.
 */
export type TableSchema = { id: IdColumnSchema } & Record<string, ColumnSchema>;

/**
 * Workspace schema - maps table names to their table schemas
 */
export type WorkspaceSchema = Record<string, TableSchema>;

/**
 * Maps a ColumnSchema to its cell value type (Y.js types or primitives).
 * Handles nullable fields and returns Y.js types for ytext and multi-select.
 * Date columns store DateWithTimezoneString (atomic string format, not objects).
 *
 * @example
 * ```typescript
 * type IdValue = CellValue<{ type: 'id' }>; // string
 * type TextField = CellValue<{ type: 'text'; nullable: true }>; // string | null
 * type YtextField = CellValue<{ type: 'ytext'; nullable: false }>; // Y.Text
 * type DateField = CellValue<{ type: 'date'; nullable: false }>; // DateWithTimezoneString
 * type TagsField = CellValue<{ type: 'multi-select'; nullable: false; options: readonly ['x', 'y'] }>; // Y.Array<string>
 * type AnyCellValue = CellValue; // Union of all possible cell values
 * ```
 */
export type CellValue<C extends ColumnSchema = ColumnSchema> =
	C extends IdColumnSchema
		? string
		: C extends TextColumnSchema<infer TNullable>
			? TNullable extends true
				? string | null
				: string
			: C extends YtextColumnSchema<infer TNullable>
				? TNullable extends true
					? Y.Text | null
					: Y.Text
				: C extends IntegerColumnSchema<infer TNullable>
					? TNullable extends true
						? number | null
						: number
					: C extends RealColumnSchema<infer TNullable>
						? TNullable extends true
							? number | null
							: number
						: C extends BooleanColumnSchema<infer TNullable>
							? TNullable extends true
								? boolean | null
								: boolean
							: C extends DateColumnSchema<infer TNullable>
								? TNullable extends true
									? DateWithTimezoneString | null
									: DateWithTimezoneString
								: C extends SelectColumnSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? TOptions[number] | null
										: TOptions[number]
									: C extends TagsColumnSchema<infer TOptions, infer TNullable>
										? TNullable extends true
											? Y.Array<TOptions[number]> | null
											: Y.Array<TOptions[number]>
										: C extends JsonColumnSchema<infer TSchema, infer TNullable>
											? TNullable extends true
												? TSchema['infer'] | null
												: TSchema['infer']
											: never;

/**
 * Maps a ColumnSchema to its serialized cell value type.
 * This is the serialized equivalent of CellValue - what you get after calling serializeCellValue().
 * Uses a distributive conditional type to transform Y.js types to their serialized equivalents.
 * - Y.Text → string
 * - Y.Array<T> → T[]
 * - DateWithTimezone → DateWithTimezoneString
 * - Other types → unchanged
 *
 * @example
 * ```typescript
 * type IdSerialized = SerializedCellValue<{ type: 'id' }>; // string
 * type YtextSerialized = SerializedCellValue<{ type: 'ytext'; nullable: false }>; // string
 * type YtextNullable = SerializedCellValue<{ type: 'ytext'; nullable: true }>; // string | null
 * type Tags = SerializedCellValue<{ type: 'multi-select'; nullable: false; options: readonly ['a', 'b'] }>; // string[]
 * type AnySerialized = SerializedCellValue; // Union of all possible serialized values
 * ```
 */
export type SerializedCellValue<C extends ColumnSchema = ColumnSchema> =
	CellValue<C> extends infer T
		? T extends Y.Text
			? string
			: T extends Y.Array<infer U>
				? U[]
				: T extends DateWithTimezone
					? DateWithTimezoneString
					: T // JSON values are already plain JavaScript, no conversion needed
		: never;

/**
 * Maps a TableSchema to a row type with properly typed fields AND Proxy methods.
 * This is a Proxy-wrapped YRow that provides:
 * - Type-safe property access: `row.title`, `row.content`, etc.
 * - `.toJSON()` method: Convert to fully serialized object (Y.Text → string, Y.Array → array[], etc.)
 * - `.$yRow` property: Access underlying YRow when needed
 *
 * Each column name becomes a property with its corresponding YJS or primitive type.
 * Since `TableSchema` always requires an `id` column, every row type includes a guaranteed `id: string` property.
 *
 * @example
 * ```typescript
 * // Type-safe with specific schema
 * type PostSchema = {
 *   id: { type: 'id' };
 *   title: { type: 'text'; nullable: false };
 *   content: { type: 'ytext'; nullable: false };
 *   viewCount: { type: 'integer'; nullable: false };
 * };
 *
 * const row: Row<PostSchema> = table.get('123').row;
 *
 * // Type-safe property access (returns Y.js types)
 * console.log(row.title);         // string
 * console.log(row.content);       // Y.Text
 * console.log(row.viewCount);     // number
 *
 * // Convert to fully serialized object (Y.Text → string, etc.)
 * const serialized = row.toJSON();     // SerializedRow<PostSchema>
 * // { id: string, title: string, content: string, viewCount: number }
 *
 * // Access underlying YRow
 * const yrow = row.$yRow;         // YRow
 * ```
 */
export type Row<TTableSchema extends TableSchema = TableSchema> = {
	readonly [K in keyof TTableSchema]: CellValue<TTableSchema[K]>;
} & {
	/**
	 * Convert the row to a fully serialized plain object.
	 * Y.Text → string, Y.Array → array[], DateWithTimezone → string, etc.
	 */
	toJSON(): SerializedRow<TTableSchema>;

	/**
	 * Access the underlying YRow for advanced YJS operations.
	 * Use this when you need direct Y.Map API access.
	 */
	readonly $yRow: YRow;
};

/**
 * Serialized row - all cell values converted to plain JavaScript types.
 * This type is useful for:
 * - Storing data in formats that don't support YJS types (SQLite, markdown, JSON APIs)
 * - Passing data across boundaries where YJS types aren't available
 * - Input validation before converting to YJS types
 *
 * The `id` field is explicitly typed as `string` since all TableSchemas require
 * an IdColumnSchema for the id field, which always serializes to string.
 *
 * @example
 * ```typescript
 * type PostSchema = {
 *   id: { type: 'id' };
 *   title: { type: 'ytext'; nullable: false };
 *   tags: { type: 'multi-select'; options: ['a', 'b']; nullable: false };
 *   publishedAt: { type: 'date'; nullable: false };
 * };
 *
 * type SerializedPost = SerializedRow<PostSchema>;
 * // { id: string; title: string; tags: string[]; publishedAt: DateWithTimezoneString }
 * ```
 */
export type SerializedRow<TTableSchema extends TableSchema = TableSchema> = {
	[K in keyof TTableSchema]: K extends 'id'
		? string
		: SerializedCellValue<TTableSchema[K]>;
};

/**
 * Represents a partial row update where id is required but all other fields are optional.
 *
 * Takes a TableSchema, converts it to SerializedRow to get the input variant,
 * then makes all fields except 'id' optional.
 *
 * Only the fields you include will be updated - the rest remain unchanged. Each field is
 * updated individually in the underlying YJS Map.
 *
 * @example
 * // Update only the title field, leaving other fields unchanged
 * db.posts.update({ id: '123', title: 'New Title' });
 *
 * @example
 * // Update multiple fields at once
 * db.posts.update({ id: '123', title: 'New Title', published: true });
 */
export type PartialSerializedRow<
	TTableSchema extends TableSchema = TableSchema,
> = {
	id: string;
} & Partial<Omit<SerializedRow<TTableSchema>, 'id'>>;
