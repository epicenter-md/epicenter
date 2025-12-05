/**
 * @fileoverview Column factory functions for schema definitions
 *
 * Provides factory functions for creating column schemas with type-safe options.
 * Each function returns a column schema object that describes the structure and
 * constraints of a database column.
 */

import type { Type } from 'arktype';
import type { DateWithTimezone } from './date-with-timezone';
import type {
	BooleanColumnSchema,
	DateColumnSchema,
	IdColumnSchema,
	IntegerColumnSchema,
	JsonColumnSchema,
	RealColumnSchema,
	SelectColumnSchema,
	TagsColumnSchema,
	TextColumnSchema,
	YtextColumnSchema,
} from './types';

/**
 * Creates an ID column schema - always primary key with auto-generation
 * IDs are always NOT NULL (cannot be nullable)
 * @example
 * id() // → { type: 'id', nullable: false }
 */
export function id(): IdColumnSchema {
	return { type: 'id', nullable: false };
}

/**
 * Creates a text column schema (NOT NULL by default)
 * @example
 * text() // → { type: 'text', nullable: false }
 * text({ nullable: true }) // → { type: 'text', nullable: true }
 * text({ default: 'unnamed' })
 */
export function text(opts: {
	nullable: true;
	default?: string | (() => string);
}): TextColumnSchema<true>;
export function text(opts?: {
	nullable?: false;
	default?: string | (() => string);
}): TextColumnSchema<false>;
export function text({
	nullable = false,
	default: defaultValue,
}: {
	nullable?: boolean;
	default?: string | (() => string);
} = {}): TextColumnSchema<boolean> {
	return {
		type: 'text',
		nullable,
		default: defaultValue,
	};
}

/**
 * Collaborative text editor column - stored as Y.Text (YJS shared type)
 *
 * Y.Text is a flat/linear text structure that supports inline formatting.
 * **Primary use case: Code editors** (Monaco, CodeMirror) with syntax highlighting.
 * Also works for: simple rich text (Quill), formatted comments, chat messages.
 *
 * **What Y.Text supports:**
 * - Inline formatting: bold, italic, underline, links, colors
 * - No block-level structure (no paragraphs, lists, or tables)
 *
 * **Most common editor bindings:**
 * - CodeMirror (code editing) - PRIMARY USE CASE
 * - Monaco Editor (code editing) - PRIMARY USE CASE
 * - Quill (simple WYSIWYG with inline formatting)
 *
 * **Common use cases:**
 * - SQL/JavaScript/Python code editors with syntax highlighting
 * - Code snippets in documentation
 * - Formatted comments or chat messages
 *
 * @example
 * query: ytext() // → Y.Text binded to CodeMirror/Monaco for storing SQL queries
 * snippet: ytext() // → Y.Text binded to CodeMirror for code examples
 * comment: ytext({ nullable: true }) // → Y.Text binded to Quill editor for comments
 */
export function ytext(opts: { nullable: true }): YtextColumnSchema<true>;
export function ytext(opts?: { nullable?: false }): YtextColumnSchema<false>;
export function ytext({
	nullable = false,
}: {
	nullable?: boolean;
} = {}): YtextColumnSchema<boolean> {
	return {
		type: 'ytext',
		nullable,
	};
}

/**
 * Creates an integer column schema (NOT NULL by default)
 * @example
 * integer() // → { type: 'integer', nullable: false }
 * integer({ default: 0 })
 */
export function integer(opts: {
	nullable: true;
	default?: number | (() => number);
}): IntegerColumnSchema<true>;
export function integer(opts?: {
	nullable?: false;
	default?: number | (() => number);
}): IntegerColumnSchema<false>;
export function integer({
	nullable = false,
	default: defaultValue,
}: {
	nullable?: boolean;
	default?: number | (() => number);
} = {}): IntegerColumnSchema<boolean> {
	return {
		type: 'integer',
		nullable,
		default: defaultValue,
	};
}

/**
 * Creates a real/float column schema (NOT NULL by default)
 * @example
 * real() // → { type: 'real', nullable: false }
 * real({ default: 0.0 })
 */
export function real(opts: {
	nullable: true;
	default?: number | (() => number);
}): RealColumnSchema<true>;
export function real(opts?: {
	nullable?: false;
	default?: number | (() => number);
}): RealColumnSchema<false>;
export function real({
	nullable = false,
	default: defaultValue,
}: {
	nullable?: boolean;
	default?: number | (() => number);
} = {}): RealColumnSchema<boolean> {
	return {
		type: 'real',
		nullable,
		default: defaultValue,
	};
}

/**
 * Creates a boolean column schema (NOT NULL by default)
 * @example
 * boolean() // → { type: 'boolean', nullable: false }
 * boolean({ default: false })
 */
export function boolean(opts: {
	nullable: true;
	default?: boolean | (() => boolean);
}): BooleanColumnSchema<true>;
export function boolean(opts?: {
	nullable?: false;
	default?: boolean | (() => boolean);
}): BooleanColumnSchema<false>;
export function boolean({
	nullable = false,
	default: defaultValue,
}: {
	nullable?: boolean;
	default?: boolean | (() => boolean);
} = {}): BooleanColumnSchema<boolean> {
	return {
		type: 'boolean',
		nullable,
		default: defaultValue,
	};
}

/**
 * Creates a date with timezone column schema (NOT NULL by default)
 * @example
 * date() // → { type: 'date', nullable: false }
 * date({ nullable: true })
 * date({ default: () => DateWithTimezone({ date: new Date(), timezone: 'UTC' }) })
 */
export function date(opts: {
	nullable: true;
	default?: DateWithTimezone | (() => DateWithTimezone);
}): DateColumnSchema<true>;
export function date(opts?: {
	nullable?: false;
	default?: DateWithTimezone | (() => DateWithTimezone);
}): DateColumnSchema<false>;
export function date({
	nullable = false,
	default: defaultValue,
}: {
	nullable?: boolean;
	default?: DateWithTimezone | (() => DateWithTimezone);
} = {}): DateColumnSchema<boolean> {
	return {
		type: 'date',
		nullable,
		default: defaultValue,
	};
}

/**
 * Creates a select (single choice) column schema
 * @example
 * select({ options: ['draft', 'published', 'archived'] })
 * select({ options: ['tech', 'personal'], default: 'tech' })
 */
export function select<
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	options: TOptions;
	nullable: true;
	default?: TOptions[number];
}): SelectColumnSchema<TOptions, true>;
export function select<
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	options: TOptions;
	nullable?: false;
	default?: TOptions[number];
}): SelectColumnSchema<TOptions, false>;
export function select<const TOptions extends readonly [string, ...string[]]>({
	options,
	nullable = false,
	default: defaultValue,
}: {
	options: TOptions;
	nullable?: boolean;
	default?: TOptions[number];
}): SelectColumnSchema<TOptions, boolean> {
	return {
		type: 'select',
		nullable,
		options,
		default: defaultValue,
	};
}

/**
 * Creates a tags column schema for storing arrays of strings.
 *
 * Two modes:
 * 1. With options (validated): Only values from the options array are allowed
 * 2. Without options (unconstrained): Any string array is allowed
 *
 * @example
 * // Validated tags (with options)
 * tags({ options: ['urgent', 'normal', 'low'] })
 * tags({ options: ['typescript', 'javascript', 'python'], default: ['typescript'] })
 *
 * // Unconstrained tags (without options)
 * tags() // Any string array
 * tags({ nullable: true })
 * tags({ default: ['initial', 'tags'] })
 */
export function tags<
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	options: TOptions;
	nullable: true;
	default?: TOptions[number][];
}): TagsColumnSchema<TOptions, true>;
export function tags<
	const TOptions extends readonly [string, ...string[]],
>(opts: {
	options: TOptions;
	nullable?: false;
	default?: TOptions[number][];
}): TagsColumnSchema<TOptions, false>;
export function tags<
	TNullable extends boolean = false,
	TDefault extends string[] | (() => string[]) | undefined = undefined,
>(opts?: {
	nullable?: TNullable;
	default?: TDefault;
}): TagsColumnSchema<readonly [string, ...string[]], TNullable>;
export function tags<const TOptions extends readonly [string, ...string[]]>({
	options,
	nullable = false,
	default: defaultValue,
}: {
	options?: TOptions;
	nullable?: boolean;
	default?: TOptions[number][] | string[] | (() => string[]);
} = {}): TagsColumnSchema<TOptions, boolean> {
	return {
		type: 'multi-select',
		nullable,
		options,
		default: defaultValue as TOptions[number][],
	};
}

/**
 * Creates a JSON column schema with Arktype validation.
 *
 * JSON columns store arbitrary JSON-serializable values validated against an Arktype schema.
 * Unlike other column types, the `schema` property is always required.
 *
 * **JSON Schema Compatibility Warning**: When used in action inputs (mutations, queries),
 * these schemas are converted to JSON Schema for MCP/OpenAPI. Only use features that
 * can be represented in JSON Schema:
 * - ✅ Basic types, objects, arrays, enums
 * - ✅ `.matching(regex)` - Converts to JSON Schema pattern
 * - ❌ `.filter(fn)` - Cannot convert to JSON Schema (custom predicates)
 * - ❌ `.narrow()` - Cannot convert to JSON Schema
 *
 * @example
 * ```typescript
 * import { json } from 'epicenter/schema';
 * import { type } from 'arktype';
 *
 * // Simple object
 * const prefs = json({
 *   schema: type({ theme: 'string', darkMode: 'boolean' }),
 * });
 *
 * // Nullable with default
 * const metadata = json({
 *   schema: type({ key: 'string', value: 'string' }).array(),
 *   nullable: true,
 *   default: [],
 * });
 * ```
 */
export function json<const TSchema extends Type>(opts: {
	schema: TSchema;
	nullable: true;
	default?: TSchema['infer'] | (() => TSchema['infer']);
}): JsonColumnSchema<TSchema, true>;
export function json<const TSchema extends Type>(opts: {
	schema: TSchema;
	nullable?: false;
	default?: TSchema['infer'] | (() => TSchema['infer']);
}): JsonColumnSchema<TSchema, false>;
export function json<const TSchema extends Type>({
	schema,
	nullable = false,
	default: defaultValue,
}: {
	schema: TSchema;
	nullable?: boolean;
	default?: TSchema['infer'] | (() => TSchema['infer']);
}): JsonColumnSchema<TSchema, boolean> {
	return {
		type: 'json',
		nullable,
		schema,
		default: defaultValue,
	};
}
