/**
 * @fileoverview Core field type definitions
 *
 * Contains the foundational types for the schema system:
 * - Field types (IdField, TextField, etc.)
 * - Table and workspace schemas
 * - Row value types (CellValue, Row, PartialRow)
 *
 * ## Field Structure
 *
 * Each field is a minimal object with `type` as the discriminant:
 * - `type`: Field type ('text', 'select', 'tags', etc.)
 * - `nullable`: Optional boolean for nullability
 * - Type-specific fields (e.g., `options` for select/tags)
 *
 * This is a Notion-like format optimized for user configuration and storage.
 * JSON Schema can be derived on-demand for MCP/OpenAPI export.
 *
 * ## Nullability
 *
 * Nullability is encoded in a simple boolean `nullable` field:
 * - Non-nullable: `nullable` omitted or `false`
 * - Nullable: `nullable: true`
 *
 * Special cases:
 * - `id`: Never nullable (implicit)
 *
 * ## Related Files
 *
 * - `factories.ts` - Factory functions for creating fields
 * - `../converters/` - Converters for arktype, drizzle, typebox
 * - `helpers.ts` - isNullableField helper
 */

import type { Static, TSchema } from 'typebox';
import type { DateTimeString } from './datetime';
import type { Id } from './id';

// ============================================================================
// Icon Type (Tagged String)
// ============================================================================

/**
 * Icon as a tagged string format: `{type}:{value}`
 *
 * Uses template literal types for compile-time safety. Tagged strings are
 * LWW-safe in YJS (concurrent edits produce valid icons) and require no
 * encode/decode layer.
 *
 * @example
 * ```typescript
 * // Emoji icon
 * const icon: Icon = 'emoji:📝';
 *
 * // Lucide icon
 * const icon: Icon = 'lucide:file-text';
 *
 * // External URL
 * const icon: Icon = 'url:https://example.com/icon.png';
 *
 * // Parsing when needed
 * const [type, value] = icon.split(':') as [IconType, string];
 * ```
 */
export type Icon = `emoji:${string}` | `lucide:${string}` | `url:${string}`;

/**
 * Icon type discriminator.
 */
export type IconType = 'emoji' | 'lucide' | 'url';

/**
 * Parse an Icon tagged string into its components.
 *
 * @example
 * ```typescript
 * const { type, value } = parseIcon('emoji:📝');
 * // type: 'emoji', value: '📝'
 * ```
 */
export function parseIcon(icon: Icon): { type: IconType; value: string } {
	const colonIndex = icon.indexOf(':');
	return {
		type: icon.slice(0, colonIndex) as IconType,
		value: icon.slice(colonIndex + 1),
	};
}

/**
 * Create an Icon tagged string from type and value.
 *
 * @example
 * ```typescript
 * const icon = createIcon('emoji', '📝'); // 'emoji:📝'
 * ```
 */
export function createIcon(type: IconType, value: string): Icon {
	return `${type}:${value}` as Icon;
}

/**
 * Check if a string is a valid Icon format.
 */
export function isIcon(value: string): value is Icon {
	return (
		value.startsWith('emoji:') ||
		value.startsWith('lucide:') ||
		value.startsWith('url:')
	);
}

/**
 * Normalize icon input to canonical Icon format.
 *
 * Converts various input formats to a canonical `Icon | null`:
 * - Valid Icon strings (tagged format) → unchanged
 * - Plain emoji strings → converted to `'emoji:{value}'`
 * - `null` or `undefined` → `null`
 *
 * This provides DX convenience: users can write `icon: '📝'` instead of
 * `icon: 'emoji:📝'` in schema definitions.
 *
 * @example
 * ```typescript
 * normalizeIcon('📝');           // 'emoji:📝'
 * normalizeIcon('emoji:📝');     // 'emoji:📝' (unchanged)
 * normalizeIcon('lucide:file');  // 'lucide:file' (unchanged)
 * normalizeIcon(null);           // null
 * normalizeIcon(undefined);      // null
 * ```
 */
export function normalizeIcon(
	icon: string | Icon | null | undefined,
): Icon | null {
	if (icon === undefined || icon === null) return null;
	if (isIcon(icon)) return icon;
	// Plain string (emoji) → convert to tagged format
	return `emoji:${icon}` as Icon;
}

// ============================================================================
// Field Metadata
// ============================================================================

/**
 * Metadata for individual fields (columns) in a table.
 *
 * Every field schema includes these properties for Notion-like UI display,
 * where each column can have its own display name, icon, and description.
 * Factory functions provide sensible defaults (empty string, null icon).
 *
 * The `id` is included here because every field must have an identifier -
 * it's as fundamental to a field's identity as its name.
 *
 * ```
 * TableDefinition
 * ├── name, icon, description    ← TableMetadata (table-level)
 * └── fields
 *     ├── { id: "id", ... }
 *     │   ├── id, name, icon, description  ← FieldMetadata (column-level)
 *     │   └── type: "id"
 *     └── { id: "title", ... }
 *         ├── id, name, icon, description  ← FieldMetadata (column-level)
 *         ├── type: "text"
 *         └── nullable: false
 * ```
 *
 * @example
 * ```typescript
 * // Field with custom metadata
 * const titleField = text({ id: 'title', name: 'Post Title', icon: 'emoji:📝', description: 'The main title displayed on the blog' });
 *
 * // Field with defaults (name: '', icon: null, description: '')
 * const simpleField = text({ id: 'title' });
 * ```
 */
export type FieldMetadata = {
	/** Unique identifier for the field within its table. */
	id: string;
	/** Display name shown in UI. Empty string if not provided. */
	name: string;
	/** Description shown in tooltips/docs. Empty string if not provided. */
	description: string;
	/** Icon for the field - tagged string format 'type:value'. */
	icon: Icon | null;
};

/**
 * Options for field factory functions.
 * All metadata fields are optional; factories provide defaults.
 */
export type FieldOptions = {
	/** Display name shown in UI. Defaults to empty string. */
	name?: string;
	/** Description shown in tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for the field - tagged string format 'type:value'. Defaults to null. */
	icon?: Icon | null;
};

// ============================================================================
// Field Types (with id included)
// ============================================================================

/**
 * ID field - auto-generated primary key.
 * Always NOT NULL (implicit, no nullable field needed).
 */
export type IdField = FieldMetadata & {
	type: 'id';
};

/**
 * Text field - single-line string input.
 */
export type TextField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'text';
	nullable?: TNullable;
	default?: string;
};

/**
 * Integer field - whole numbers.
 */
export type IntegerField<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'integer';
		nullable?: TNullable;
		default?: number;
	};

/**
 * Real/float field - decimal numbers.
 */
export type RealField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'real';
	nullable?: TNullable;
	default?: number;
};

/**
 * Boolean field - true/false values.
 */
export type BooleanField<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'boolean';
		nullable?: TNullable;
		default?: boolean;
	};

/**
 * Date field - timezone-aware dates.
 * Stored as DateTimeString format: `{iso}|{timezone}`.
 */
export type DateField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'date';
	nullable?: TNullable;
	default?: DateTimeString;
};

/**
 * Select field - single choice from predefined options.
 *
 * @example
 * ```typescript
 * {
 *   id: 'status',
 *   type: 'select',
 *   options: ['draft', 'published', 'archived'],
 *   default: 'draft'
 * }
 * ```
 */
export type SelectField<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'select';
	options: TOptions;
	nullable?: TNullable;
	default?: TOptions[number];
};

/**
 * Tags field - array of strings with optional validation.
 * Stored as plain arrays (JSON-serializable).
 *
 * Two modes:
 * - With `options`: Only values from options are allowed
 * - Without `options`: Any string array is allowed
 *
 * @example
 * ```typescript
 * // Validated tags
 * { id: 'priority', type: 'tags', options: ['urgent', 'normal', 'low'] }
 *
 * // Unconstrained tags
 * { id: 'labels', type: 'tags' }
 * ```
 */
export type TagsField<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'tags';
	options?: TOptions;
	nullable?: TNullable;
	default?: TOptions[number][];
};

/**
 * JSON field - arbitrary JSON validated by a TypeBox schema.
 *
 * The `schema` property holds a TypeBox schema (TSchema), which IS JSON Schema.
 * TypeBox schemas are plain JSON objects that can be:
 * - Stored directly in Y.Doc (no conversion needed)
 * - Compiled to JIT validators using `Compile()` from `typebox/compile`
 * - Used for TypeScript type inference via `Static<typeof schema>`
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * {
 *   id: 'settings',
 *   type: 'json',
 *   schema: Type.Object({ theme: Type.String(), darkMode: Type.Boolean() }),
 *   default: { theme: 'dark', darkMode: true }
 * }
 * ```
 */
export type JsonField<
	T extends TSchema = TSchema,
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'json';
	schema: T;
	nullable?: TNullable;
	default?: Static<T>;
};

// ============================================================================
// Discriminated Unions and Utility Types
// ============================================================================

/**
 * Discriminated union of all field types.
 * Use `type` to narrow to a specific type.
 *
 * All fields include the `id` property - it's part of the field definition itself.
 */
export type Field =
	| IdField
	| TextField
	| IntegerField
	| RealField
	| BooleanField
	| DateField
	| SelectField
	| TagsField
	| JsonField;

/**
 * Extract the type name from a field definition.
 * One of: 'id', 'text', 'integer', 'real', 'boolean', 'date', 'select', 'tags', 'json'
 */
export type FieldType = Field['type'];

// ============================================================================
// Type Utilities for Field Arrays
// ============================================================================

/**
 * Get specific field by id from array.
 */
export type FieldById<
	TFields extends readonly Field[],
	K extends string,
> = Extract<TFields[number], { id: K }>;

/**
 * Get union of all field ids from array.
 */
export type FieldIds<TFields extends readonly Field[]> = TFields[number]['id'];

// ============================================================================
// Type Utilities for Table Arrays
// ============================================================================

/**
 * Get specific table by id from array.
 *
 * @example
 * ```typescript
 * type PostsTable = TableById<typeof workspace.tables, 'posts'>;
 * ```
 */
export type TableById<
	TTables extends readonly TableDefinition[],
	K extends string,
> = Extract<TTables[number], { id: K }>;

/**
 * Get union of all table ids from array.
 *
 * @example
 * ```typescript
 * type AllTableIds = TableIds<typeof workspace.tables>; // 'posts' | 'users' | ...
 * ```
 */
export type TableIds<TTables extends readonly TableDefinition[]> =
	TTables[number]['id'];

// ============================================================================
// Type Utilities for KV Field Arrays
// ============================================================================

/**
 * Get specific KV field by id from array.
 *
 * @example
 * ```typescript
 * type ThemeField = KvFieldById<typeof workspace.kv, 'theme'>;
 * ```
 */
export type KvFieldById<
	TKv extends readonly KvField[],
	K extends string,
> = Extract<TKv[number], { id: K }>;

/**
 * Get union of all KV field ids from array.
 *
 * @example
 * ```typescript
 * type KvKeys = KvFieldIds<typeof workspace.kv>; // 'theme' | 'fontSize' | ...
 * ```
 */
export type KvFieldIds<TKv extends readonly KvField[]> = TKv[number]['id'];

// ============================================================================
// Value Types
// ============================================================================

/**
 * Maps a field definition to its runtime value type.
 *
 * - TagsField → string[] (plain array)
 * - DateField → DateTimeString
 * - Other fields → primitive types
 *
 * Nullability is derived from the definition's `nullable` field.
 */
export type CellValue<C extends Field = Field> = C extends IdField
	? Id
	: C extends TextField<infer TTextNullable>
		? true extends TTextNullable
			? string | null
			: string
		: C extends IntegerField<infer TIntegerNullable>
			? true extends TIntegerNullable
				? number | null
				: number
			: C extends RealField<infer TRealNullable>
				? true extends TRealNullable
					? number | null
					: number
				: C extends BooleanField<infer TBooleanNullable>
					? true extends TBooleanNullable
						? boolean | null
						: boolean
					: C extends DateField<infer TDateNullable>
						? true extends TDateNullable
							? DateTimeString | null
							: DateTimeString
						: C extends SelectField<infer TOptions, infer TSelectNullable>
							? true extends TSelectNullable
								? TOptions[number] | null
								: TOptions[number]
							: C extends TagsField<infer TOptions, infer TTagsNullable>
								? true extends TTagsNullable
									? TOptions[number][] | null
									: TOptions[number][]
								: C extends JsonField<
											infer T extends TSchema,
											infer TJsonNullable
										>
									? true extends TJsonNullable
										? Static<T> | null
										: Static<T>
									: never;

// ============================================================================
// Table Schema Types
// ============================================================================

/**
 * Table definition with metadata for UI display.
 * This is the **normalized** output type created by the `table()` factory function.
 *
 * Fields are stored as an array where array position determines display order.
 * Each field has an `id` property.
 *
 * @example
 * ```typescript
 * const postsTable = table({ id: 'posts', name: 'Posts', description: 'Blog posts and articles', icon: 'emoji:📝', fields: [
 *   id(),
 *   text({ id: 'title' }),
 *   select({ id: 'status', options: ['draft', 'published'] }),
 * ] });
 * // Result:
 * // {
 * //   id: 'posts',
 * //   name: 'Posts',
 * //   description: 'Blog posts and articles',
 * //   icon: 'emoji:📝',
 * //   fields: [...]
 * // }
 * ```
 */
export type TableDefinition<
	TId extends string = string,
	TFields extends readonly Field[] = readonly Field[],
> = {
	/** Unique identifier for this table */
	id: TId;
	/** Required display name shown in UI (e.g., "Blog Posts") */
	name: string;
	/** Required description shown in tooltips/docs */
	description: string;
	/** Icon for the table - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Field definitions as array (position = display order) */
	fields: TFields;
};

// ============================================================================
// Row Types
// ============================================================================

/**
 * Plain object representing a complete table row.
 *
 * Row is the unified type for both reads and writes. All values are plain
 * JSON-serializable primitives (no Y.js types, no methods, no proxy behavior).
 *
 * @example
 * ```typescript
 * // Write: pass a Row to upsert
 * tables.get('posts').upsert({
 *   id: generateId(),
 *   title: 'Hello World',
 *   published: false,
 * });
 *
 * // Read: get returns a Row (wrapped in RowResult for validation)
 * const result = tables.get('posts').get({ id: '1' });
 * if (result.status === 'valid') {
 *   const row: Row = result.row;
 *   console.log(row.title);
 * }
 *
 * // Rows are JSON-serializable
 * const json = JSON.stringify(row);
 * ```
 */
export type Row<TFields extends readonly Field[] = readonly Field[]> = {
	[K in FieldIds<TFields>]: CellValue<FieldById<TFields, K>>;
};

/**
 * Partial row for updates. ID is required, all other fields are optional.
 *
 * Use PartialRow with `update()` when you only want to change specific fields
 * without providing the entire row. Fields not included are left unchanged.
 *
 * @example
 * ```typescript
 * // Update only the title, leave other fields unchanged
 * tables.get('posts').update({ id: '1', title: 'New Title' });
 *
 * // Update multiple fields
 * tables.get('posts').update({
 *   id: '1',
 *   title: 'Updated',
 *   published: true,
 * });
 * ```
 */
export type PartialRow<TFields extends readonly Field[] = readonly Field[]> = {
	id: Id;
} & Partial<Omit<Row<TFields>, 'id'>>;

// ============================================================================
// Key-Value Schema Types
// ============================================================================

/**
 * Field definition for KV stores (excludes IdField).
 * KV entries don't have row IDs; they're keyed by string.
 * The field's `id` property is used as the key in the KV store.
 */
export type KvField = Exclude<Field, IdField>;

/**
 * Runtime value type for a KV entry.
 */
export type KvValue<C extends KvField = KvField> = CellValue<C>;

// ============================================================================
// Array ↔ Record Conversion Utilities
// ============================================================================
