/**
 * Field factory functions for creating minimal field schemas.
 *
 * Each function returns a minimal schema object with `type` as the discriminant.
 * No redundant JSON Schema fields; derive JSON Schema on-demand for export.
 *
 * All factories follow the **single options object pattern**: every property
 * (including `id`) is passed in one destructured object. This provides:
 * - Self-documenting call sites: `{ id: 'title', nullable: true }`
 * - Consistent shape across all field helpers
 * - Easy to add new properties without breaking signatures
 * - `name` defaults to `id` if not provided
 */

import type { Temporal } from 'temporal-polyfill';
import type { Static, TSchema } from 'typebox';
import { DateTimeString } from './datetime';
import type {
	BooleanField,
	DateField,
	Field,
	FieldMetadata,
	Icon,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	SelectField,
	TableDefinition,
	TagsField,
	TextField,
} from './types';
import { normalizeIcon } from './types';

// ============================================================================
// Shared Options Types (with JSDoc for IDE hover)
// ============================================================================

/**
 * Input options for field metadata in factory functions.
 *
 * These options describe the **input** to field helpers like `text()`, `select()`, etc.
 * All properties are optional and will be normalized to required values in the
 * resulting {@link FieldMetadata} output.
 *
 * **Normalization behavior:**
 * - `name` → defaults to the field's `id` if omitted
 * - `description` → defaults to empty string `''` if omitted
 * - `icon` → plain emoji strings (e.g., `'📝'`) are normalized to tagged format (`'emoji:📝'`)
 *
 * @see {@link FieldMetadata} for the normalized output type after factory processing
 *
 * @example
 * ```typescript
 * // Input (FieldMetadataOptions)
 * text({ id: 'title', icon: '📝' })
 *
 * // Output (FieldMetadata)
 * // {
 * //   id: 'title',
 * //   name: 'title',        // normalized: defaults to id
 * //   description: '',      // normalized: defaults to empty string
 * //   icon: 'emoji:📝',     // normalized: plain emoji → tagged format
 * //   type: 'text'
 * // }
 * ```
 */
type FieldMetadataOptions = {
	/**
	 * Display name shown in UI.
	 *
	 * Optional in options; normalized to the field's `id` if omitted.
	 *
	 * @see {@link FieldMetadata.name} for the normalized output (always `string`)
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'firstName' })              // name = 'firstName'
	 * text({ id: 'firstName', name: 'First Name' }) // name = 'First Name'
	 * ```
	 */
	name?: string;

	/**
	 * Description shown in tooltips and documentation.
	 *
	 * Optional in options; normalized to empty string `''` if omitted.
	 *
	 * @see {@link FieldMetadata.description} for the normalized output (always `string`)
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'email', description: 'Primary contact email address' })
	 * ```
	 */
	description?: string;

	/**
	 * Icon for the field in UI.
	 *
	 * Accepts:
	 * - Tagged format: `'emoji:📝'`, `'lucide:file-text'`, `'url:https://...'`
	 * - Plain emoji shorthand: `'📝'` (normalized to `'emoji:📝'`)
	 * - `null` or omitted (defaults to `null`)
	 *
	 * @see {@link FieldMetadata.icon} for the normalized output (always `Icon | null`)
	 * @see {@link Icon} for the tagged string format
	 *
	 * @example
	 * ```typescript
	 * text({ id: 'title', icon: '📝' })           // → 'emoji:📝'
	 * text({ id: 'title', icon: 'lucide:type' })  // → 'lucide:type'
	 * text({ id: 'title' })                       // → null
	 * ```
	 */
	icon?: Icon | string | null;
};

// ============================================================================
// Table Factory
// ============================================================================

/**
 * Creates a table definition.
 *
 * Unlike field helpers, `name` is required for tables because table names
 * are always user-facing and should be human-readable (e.g., "Blog Posts" not "blogPosts").
 *
 * @example
 * ```typescript
 * // Minimal - id, name, and fields required
 * table({
 *   id: 'posts',
 *   name: 'Posts',
 *   fields: [id(), text({ id: 'title' }), boolean({ id: 'published' })],
 * });
 *
 * // With icon (tagged format)
 * table({
 *   id: 'posts',
 *   name: 'Posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text({ id: 'title' })],
 * });
 *
 * // With icon shorthand (plain emoji)
 * table({
 *   id: 'posts',
 *   name: 'Posts',
 *   icon: '📝',  // Converted to 'emoji:📝'
 *   fields: [id(), text({ id: 'title' })],
 * });
 *
 * // Full - all metadata explicit
 * table({
 *   id: 'posts',
 *   name: 'Blog Posts',
 *   description: 'Articles and blog posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text({ id: 'title' }), boolean({ id: 'published' })],
 * });
 *
 * // In defineWorkspace with arrays
 * defineWorkspace({
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }),
 *     table({ id: 'comments', name: 'Comments', fields: [id(), text({ id: 'body' })] }),
 *   ],
 *   kv: [],
 * });
 * ```
 */
export function table<
	const TId extends string,
	const TFields extends readonly Field[],
>({
	id,
	name,
	fields,
	description = '',
	icon = null,
}: {
	/** Unique identifier for this table. Used as storage key. */
	id: TId;
	/** Display name shown in UI. Required for tables. */
	name: string;
	/** Field definitions for this table. */
	fields: TFields;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Accepts tagged or plain emoji. Defaults to null. */
	icon?: string | Icon | null;
}): TableDefinition<TId, TFields> {
	return {
		id,
		name,
		description,
		icon: normalizeIcon(icon),
		fields,
	};
}

// ============================================================================
// ID Field Factory
// ============================================================================

/**
 * Creates an ID field (primary key).
 * Can be called with no args (defaults to id='id') or with options.
 *
 * @example
 * ```typescript
 * id()                        // → { id: 'id', name: 'id', type: 'id', ... }
 * id({ id: 'postId' })        // → { id: 'postId', name: 'postId', type: 'id', ... }
 * id({ id: 'postId', name: 'Post ID' })
 * ```
 */
export function id(): IdField & { id: 'id' };
export function id<const K extends string>(opts: {
	/** Unique identifier for this field. Defaults to 'id'. */
	id: K;
	/** Display name. Defaults to id. */
	name?: string;
	/** Description for tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for UI. Defaults to null. */
	icon?: Icon | string | null;
}): IdField & { id: K };
export function id<const K extends string>(
	opts: {
		id?: K;
		name?: string;
		description?: string;
		icon?: Icon | string | null;
	} = {},
): IdField & { id: K } {
	const fieldId = (opts.id ?? 'id') as K;
	return {
		id: fieldId,
		type: 'id',
		name: opts.name ?? fieldId,
		description: opts.description ?? '',
		icon: normalizeIcon(opts.icon),
	};
}

// ============================================================================
// Text Field Factory
// ============================================================================

/**
 * Creates a text (string) field.
 *
 * @example
 * ```typescript
 * text({ id: 'title' })
 * text({ id: 'title', name: 'Post Title' })
 * text({ id: 'subtitle', nullable: true })
 * text({ id: 'status', default: 'active' })
 * ```
 */
export function text<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: string;
	} & FieldMetadataOptions,
): TextField<false> & { id: K };

export function text<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: string;
	} & FieldMetadataOptions,
): TextField<true> & { id: K };

export function text<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	nullable?: boolean;
	default?: string;
} & FieldMetadataOptions): TextField<boolean> & { id: K } {
	return {
		id,
		type: 'text',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

// ============================================================================
// Integer Field Factory
// ============================================================================

/**
 * Creates an integer field.
 *
 * @example
 * ```typescript
 * integer({ id: 'views' })                        // non-nullable
 * integer({ id: 'rating', nullable: true })       // nullable
 * integer({ id: 'count', default: 0 })            // with default
 * ```
 */
export function integer<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: number;
	} & FieldMetadataOptions,
): IntegerField<false> & { id: K };

export function integer<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: number;
	} & FieldMetadataOptions,
): IntegerField<true> & { id: K };

export function integer<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	nullable?: boolean;
	default?: number;
} & FieldMetadataOptions): IntegerField<boolean> & { id: K } {
	return {
		id,
		type: 'integer',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

// ============================================================================
// Real Field Factory
// ============================================================================

/**
 * Creates a real (float) field.
 *
 * @example
 * ```typescript
 * real({ id: 'price' })                          // non-nullable
 * real({ id: 'discount', nullable: true })       // nullable
 * real({ id: 'rate', default: 0.0 })             // with default
 * ```
 */
export function real<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: number;
	} & FieldMetadataOptions,
): RealField<false> & { id: K };

export function real<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: number;
	} & FieldMetadataOptions,
): RealField<true> & { id: K };

export function real<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	nullable?: boolean;
	default?: number;
} & FieldMetadataOptions): RealField<boolean> & { id: K } {
	return {
		id,
		type: 'real',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

// ============================================================================
// Boolean Field Factory
// ============================================================================

/**
 * Creates a boolean field.
 *
 * @example
 * ```typescript
 * boolean({ id: 'published' })                       // non-nullable
 * boolean({ id: 'verified', nullable: true })        // nullable
 * boolean({ id: 'active', default: false })          // with default
 * ```
 */
export function boolean<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: boolean;
	} & FieldMetadataOptions,
): BooleanField<false> & { id: K };

export function boolean<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: boolean;
	} & FieldMetadataOptions,
): BooleanField<true> & { id: K };

export function boolean<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	nullable?: boolean;
	default?: boolean;
} & FieldMetadataOptions): BooleanField<boolean> & { id: K } {
	return {
		id,
		type: 'boolean',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

// ============================================================================
// Date Field Factory
// ============================================================================

/**
 * Creates a date field.
 *
 * @example
 * ```typescript
 * date({ id: 'createdAt' })                        // non-nullable
 * date({ id: 'deletedAt', nullable: true })        // nullable
 * date({ id: 'startDate', default: now })          // with default (Temporal.ZonedDateTime)
 * ```
 */
export function date<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: Temporal.ZonedDateTime;
	} & FieldMetadataOptions,
): DateField<false> & { id: K };

export function date<const K extends string>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: Temporal.ZonedDateTime;
	} & FieldMetadataOptions,
): DateField<true> & { id: K };

export function date<const K extends string>({
	id,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	nullable?: boolean;
	default?: Temporal.ZonedDateTime;
} & FieldMetadataOptions): DateField<boolean> & { id: K } {
	return {
		id,
		type: 'date',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && {
			default: DateTimeString.stringify(defaultValue),
		}),
	};
}

// ============================================================================
// Select Field Factory
// ============================================================================

/**
 * Creates a select field (single choice from predefined options).
 *
 * @example
 * ```typescript
 * select({ id: 'status', options: ['draft', 'published'] })
 * select({ id: 'status', options: ['draft', 'published'], default: 'draft' })
 * select({ id: 'priority', options: ['low', 'medium', 'high'], name: 'Priority Level' })
 * select({ id: 'category', options: ['a', 'b', 'c'], nullable: true })
 * ```
 */
export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Allowed values for this field. Must have at least one option. */
		options: TOptions;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. Must be one of the options. */
		default?: TOptions[number];
	} & FieldMetadataOptions,
): SelectField<TOptions, true> & { id: K };

export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Allowed values for this field. Must have at least one option. */
		options: TOptions;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. Must be one of the options. */
		default?: TOptions[number];
	} & FieldMetadataOptions,
): SelectField<TOptions, false> & { id: K };

export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>({
	id,
	options,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	options: TOptions;
	nullable?: boolean;
	default?: TOptions[number];
} & FieldMetadataOptions): SelectField<TOptions, boolean> & { id: K } {
	return {
		id,
		type: 'select',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		options,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

// ============================================================================
// Tags Field Factory
// ============================================================================

/**
 * Creates a tags field (array of strings).
 *
 * Two modes:
 * - With `options`: Only values from options are allowed
 * - Without `options`: Any string array is allowed
 *
 * @example
 * ```typescript
 * tags({ id: 'labels' })                                              // unconstrained
 * tags({ id: 'categories', options: ['tech', 'news', 'sports'] })     // constrained
 * tags({ id: 'tags', nullable: true })                                // nullable
 * ```
 */
export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Allowed values for this field. If omitted, any strings are allowed. */
		options: TOptions;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. */
		default?: TOptions[number][];
	} & FieldMetadataOptions,
): TagsField<TOptions, true> & { id: K };

export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Allowed values for this field. If omitted, any strings are allowed. */
		options: TOptions;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. */
		default?: TOptions[number][];
	} & FieldMetadataOptions,
): TagsField<TOptions, false> & { id: K };

export function tags<const K extends string, TNullable extends boolean = false>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** Whether null values are allowed. */
		nullable?: TNullable;
		/** Default value for new rows. */
		default?: string[];
	} & FieldMetadataOptions,
): TagsField<readonly [string, ...string[]], TNullable> & { id: K };

export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>({
	id,
	options,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	options?: TOptions;
	nullable?: boolean;
	default?: TOptions[number][] | string[];
} & FieldMetadataOptions): TagsField<TOptions, boolean> & { id: K } {
	return {
		id,
		type: 'tags',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		...(options && { options }),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && {
			default: defaultValue as TOptions[number][],
		}),
	};
}

// ============================================================================
// JSON Field Factory
// ============================================================================

/**
 * Creates a JSON field with TypeBox schema validation.
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * json({ id: 'settings', schema: Type.Object({ theme: Type.String() }) })
 * json({ id: 'metadata', schema: MySchema, nullable: true })
 * json({
 *   id: 'config',
 *   schema: Type.Object({ darkMode: Type.Boolean() }),
 *   default: { darkMode: false }
 * })
 * ```
 */
export function json<const K extends string, const T extends TSchema>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** TypeBox schema for validation. */
		schema: T;
		/** Whether null values are allowed. */
		nullable: true;
		/** Default value for new rows. Must conform to schema. */
		default?: Static<T>;
	} & FieldMetadataOptions,
): JsonField<T, true> & { id: K };

export function json<const K extends string, const T extends TSchema>(
	opts: {
		/** Unique identifier for this field within its table. */
		id: K;
		/** TypeBox schema for validation. */
		schema: T;
		/** Whether null values are allowed. Defaults to false. */
		nullable?: false;
		/** Default value for new rows. Must conform to schema. */
		default?: Static<T>;
	} & FieldMetadataOptions,
): JsonField<T, false> & { id: K };

export function json<const K extends string, const T extends TSchema>({
	id,
	schema,
	nullable = false,
	default: defaultValue,
	name,
	description = '',
	icon = null,
}: {
	id: K;
	schema: T;
	nullable?: boolean;
	default?: Static<T>;
} & FieldMetadataOptions): JsonField<T, boolean> & { id: K } {
	return {
		id,
		type: 'json',
		name: name ?? id,
		description,
		icon: normalizeIcon(icon),
		schema,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}
