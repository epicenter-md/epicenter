import type {
	ColumnBuilderBase,
	ColumnBuilderBaseConfig,
	ColumnDataType,
	HasDefault,
	NotNull,
} from 'drizzle-orm';
import {
	customType,
	integer as drizzleInteger,
	real as drizzleReal,
	text as drizzleText,
} from 'drizzle-orm/sqlite-core';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { DateTimeString } from '../../dynamic/schema';
import { generateId } from '../../dynamic/schema';

/**
 * Type helper that composes Drizzle column modifiers based on options.
 * Static defaults only - no runtime/lazy defaults.
 */
type ApplyColumnModifiers<
	TBase extends ColumnBuilderBase<
		ColumnBuilderBaseConfig<ColumnDataType, string>,
		object
	>,
	TNullable extends boolean,
	TDefault,
> = TDefault extends undefined
	? TNullable extends false
		? NotNull<TBase>
		: TBase
	: TNullable extends false
		? HasDefault<NotNull<TBase>>
		: HasDefault<TBase>;

/**
 * Creates an ID column - always primary key with nano ID generation
 * This is the only column type that can be a primary key.
 * @example
 * id() // Primary key ID column with nano ID generation
 */
export function id() {
	return (
		drizzleText()
			.notNull()
			.primaryKey()
			// .$type<Id>()
			.$defaultFn(() => generateId())
	);
}

/**
 * Creates a text column for storing string values.
 *
 * Columns are NOT NULL by default. Use `nullable: true` for optional fields.
 * Note: Only `id()` columns can be primary keys.
 *
 * @example
 * ```typescript
 * const schema = {
 *   title: text(),                      // Required string
 *   bio: text({ nullable: true }),      // Optional string
 *   role: text({ default: 'user' }),    // Required with default
 * };
 * ```
 */
export function text<
	TNullable extends boolean = false,
	TDefault extends string | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleText();
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates an integer column for storing whole numbers.
 *
 * Columns are NOT NULL by default. Use `nullable: true` for optional fields.
 * Note: Only `id()` columns can be primary keys.
 *
 * @example
 * ```typescript
 * const schema = {
 *   views: integer(),                   // Required integer
 *   rating: integer({ nullable: true }),// Optional integer
 *   priority: integer({ default: 0 }),  // Required with default
 * };
 * ```
 */
export function integer<
	TNullable extends boolean = false,
	TDefault extends number | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleInteger();
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a real/float column for storing decimal numbers.
 *
 * Columns are NOT NULL by default. Use `nullable: true` for optional fields.
 *
 * @example
 * ```typescript
 * const schema = {
 *   price: real(),                      // Required decimal
 *   discount: real({ nullable: true }), // Optional decimal
 *   taxRate: real({ default: 0.0 }),    // Required with default
 * };
 * ```
 */
export function real<
	TNullable extends boolean = false,
	TDefault extends number | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleReal();
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a boolean column stored as integer 0/1 in SQLite.
 *
 * Columns are NOT NULL by default. Use `nullable: true` for optional fields.
 *
 * @example
 * ```typescript
 * const schema = {
 *   published: boolean(),                    // Required boolean
 *   featured: boolean({ nullable: true }),   // Optional boolean
 *   active: boolean({ default: true }),      // Required with default
 * };
 * ```
 */
export function boolean<
	TNullable extends boolean = false,
	TDefault extends boolean | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleInteger({ mode: 'boolean' });
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a date column stored as DateTimeString.
 *
 * Stored as TEXT in format "ISO_UTC|TIMEZONE" (e.g., "2024-01-01T20:00:00.000Z|America/New_York").
 * Returns DateTimeString on read - convert to Temporal.ZonedDateTime lazily when needed
 * using `DateTimeString.parse()`.
 *
 * **Why no automatic conversion?**
 * Drizzle's `fromDriver` runs synchronously on every row. For queries returning many rows,
 * eager Temporal parsing adds unnecessary overhead. Keeping data as strings until the UI
 * layer (where you actually need date math) is more efficient and consistent with how
 * YJS stores dates.
 */
export function date<
	TNullable extends boolean = false,
	TDefault extends DateTimeString | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleText().$type<DateTimeString>();

	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue);

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Infers the array type for a tags column based on options.
 *
 * - With options: `('a' | 'b')[]` (narrowed union)
 * - Without options: `string[]` (any strings allowed)
 */
type TagsArray<TOptions extends readonly string[] | undefined> =
	TOptions extends readonly string[] ? TOptions[number][] : string[];

/**
 * Creates a tags column for storing string arrays (stored as JSON text).
 *
 * Supports two modes:
 * 1. **With options**: Types narrowed to allowed values, validated on read
 * 2. **Without options**: Any string array allowed
 *
 * Invalid values in the database will throw on read, ensuring data integrity.
 * Columns are NOT NULL by default.
 *
 * @example
 * ```typescript
 * const schema = {
 *   // Constrained tags (validated against options)
 *   priority: tags({ options: ['urgent', 'normal', 'low'] }),
 *   roles: tags({ options: ['admin', 'user'], default: ['user'] }),
 *
 *   // Unconstrained tags (any string array)
 *   labels: tags(),
 *   keywords: tags({ nullable: true }),
 * };
 * ```
 */
export function tags<
	const TOptions extends readonly string[] | undefined = undefined,
	TNullable extends boolean = false,
	TDefault extends TagsArray<TOptions> | undefined = undefined,
>({
	options,
	nullable = false as TNullable,
	default: defaultValue,
}: {
	options?: TOptions;
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	const optionsSet = options ? new Set(options) : null;

	const tagsType = customType<{
		data: TagsArray<TOptions>;
		driverData: string;
	}>({
		dataType: () => 'text',
		toDriver: (value: TagsArray<TOptions>): string => JSON.stringify(value),
		fromDriver: (value: string): TagsArray<TOptions> => {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed)) {
				throw new Error(`Expected array, got ${typeof parsed}`);
			}
			const nonStringItems = parsed.filter((item) => typeof item !== 'string');
			if (nonStringItems.length > 0) {
				throw new Error(
					`Tags must be strings, found: ${nonStringItems.map((item) => typeof item).join(', ')}`,
				);
			}
			const stringValues = parsed as string[];
			if (optionsSet) {
				const invalidValues = stringValues.filter(
					(item) => !optionsSet.has(item),
				);
				if (invalidValues.length > 0) {
					throw new Error(
						`Invalid tag values: ${invalidValues.join(', ')}. Allowed: ${options?.join(', ')}`,
					);
				}
			}
			return stringValues as TagsArray<TOptions>;
		},
	});

	let column = tagsType();
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined) column = column.default(defaultValue as any);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a JSON column for storing values validated against a Standard Schema.
 *
 * Values are validated on read using `~standard.validate()`. Invalid values
 * throw immediately, surfacing data corruption. Compatible with any
 * Standard Schema library: ArkType, Zod (v4.2+), Valibot.
 *
 * Columns are NOT NULL by default.
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * const schema = {
 *   metadata: json({ schema: Type.Object({ key: Type.String(), value: Type.String() }) }),
 *   config: json({
 *     schema: Type.Object({ theme: Type.Union([Type.Literal('dark'), Type.Literal('light')]) }),
 *     default: { theme: 'dark' },
 *   }),
 *   settings: json({
 *     schema: Type.Object({ notifications: Type.Boolean() }),
 *     nullable: true,
 *   }),
 * };
 * ```
 */
export function json<
	const T extends TSchema,
	TNullable extends boolean = false,
	TDefault extends Static<T> | undefined = undefined,
>({
	schema,
	nullable = false as TNullable,
	default: defaultValue,
}: {
	schema: T;
	nullable?: TNullable;
	default?: TDefault;
}) {
	type TOutput = Static<T>;

	// Compile the TypeBox schema for JIT-optimized validation
	const validator = Compile(schema);

	const jsonType = customType<{
		data: TOutput;
		driverData: string;
	}>({
		dataType: () => 'text',
		toDriver: (value: TOutput): string => JSON.stringify(value),
		fromDriver: (value: string): TOutput => {
			const parsed = JSON.parse(value);
			// Use compiled TypeBox validator
			if (!validator.Check(parsed)) {
				const errors = [...validator.Errors(parsed)];
				const messages = errors
					.map((e) => `${e.instancePath || '/'}: ${e.message}`)
					.join(', ');
				throw new Error(`JSON validation failed: ${messages}`);
			}
			return parsed as TOutput;
		},
	});

	let column = jsonType();
	if (!nullable) column = column.notNull();
	if (defaultValue !== undefined)
		column = column.default(defaultValue as TOutput);
	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}
