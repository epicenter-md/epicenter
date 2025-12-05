import { type ArkErrors, type Type, type } from 'arktype';
import type {
	ColumnBuilderBase,
	ColumnBuilderBaseConfig,
	ColumnDataType,
	HasDefault,
	HasRuntimeDefault,
	NotNull,
} from 'drizzle-orm';
import {
	customType,
	integer as drizzleInteger,
	real as drizzleReal,
	text as drizzleText,
} from 'drizzle-orm/sqlite-core';
import type {
	DateWithTimezoneString,
	DateWithTimezone as DateWithTimezoneType,
} from '../../../core/schema';
import { DateWithTimezone, generateId } from '../../../core/schema';

/**
 * Type helper that composes Drizzle column modifiers based on options
 * Builds the type step by step for cleaner composition
 */
type ApplyColumnModifiers<
	TBase extends ColumnBuilderBase<
		ColumnBuilderBaseConfig<ColumnDataType, string>,
		object
	>,
	TNullable extends boolean,
	TDefault,
> = TDefault extends (...args: any[]) => any
	? TNullable extends false
		? HasRuntimeDefault<HasDefault<NotNull<TBase>>>
		: HasRuntimeDefault<HasDefault<TBase>>
	: TDefault extends undefined
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
 * Creates a text column (NOT NULL by default)
 * Note: Only id() columns can be primary keys
 * @example
 * text() // NOT NULL text
 * text({ nullable: true }) // Nullable text
 * text({ default: 'unnamed' }) // NOT NULL with default
 */
export function text<
	TNullable extends boolean = false,
	TDefault extends string | (() => string) | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleText();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates an integer column (NOT NULL by default)
 * Note: Only id() columns can be primary keys
 * @example
 * integer() // NOT NULL integer
 * integer({ nullable: true }) // Nullable integer
 * integer({ default: 0 }) // NOT NULL with default
 */
export function integer<
	TNullable extends boolean = false,
	TDefault extends number | (() => number) | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleInteger();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a real/float column (NOT NULL by default)
 * @example
 * real() // NOT NULL real
 * real({ nullable: true }) // Nullable real
 * real({ default: 0.0 }) // NOT NULL with default
 */
export function real<
	TNullable extends boolean = false,
	TDefault extends number | (() => number) | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleReal();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a boolean column (stored as integer 0/1, NOT NULL by default)
 * @example
 * boolean() // NOT NULL boolean
 * boolean({ nullable: true }) // Nullable boolean
 * boolean({ default: false }) // NOT NULL with default false
 */
export function boolean<
	TNullable extends boolean = false,
	TDefault extends boolean | (() => boolean) | undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	let column = drizzleInteger({ mode: 'boolean' });

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a date column with timezone support (stored as text, NOT NULL by default)
 *
 * Stores dates as DateWithTimezoneString in format "ISO_UTC|TIMEZONE"
 * (e.g., "2024-01-01T20:00:00.000Z|America/New_York")
 *
 * YJS stores dates as strings, so this column works directly with the serialized format.
 * SQLite stores the same string format for maximum compatibility.
 *
 * Note: Only id() columns can be primary keys
 * @example
 * date() // NOT NULL date with timezone
 * date({ nullable: true }) // Nullable date with timezone
 * date({ default: new Date() }) // NOT NULL with system timezone
 * date({ default: () => new Date() }) // NOT NULL with dynamic current date
 */
export function date<
	TNullable extends boolean = false,
	TDefault extends
		| Date
		| DateWithTimezone
		| (() => Date | DateWithTimezone)
		| undefined = undefined,
>({
	nullable = false as TNullable,
	default: defaultValue,
}: {
	nullable?: TNullable;
	default?: TDefault;
} = {}) {
	/**
	 * Use plain text column since YJS stores DateWithTimezoneString (already serialized)
	 * No conversion needed - SQLite stores the same string format that YJS uses
	 */
	let column = drizzleText();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	/**
	 * Normalizes Date or DateWithTimezone to DateWithTimezoneString
	 * This is only used for default values, since YJS already stores strings
	 */
	const normalizeToDateWithTimezoneString = (
		value: Date | DateWithTimezoneType,
	): DateWithTimezoneString => {
		if (value instanceof Date) {
			const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			return DateWithTimezone({ date: value, timezone }).toJSON();
		}
		return value.toJSON();
	};

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(() =>
						normalizeToDateWithTimezoneString(defaultValue()),
					)
				: column.default(normalizeToDateWithTimezoneString(defaultValue));
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Infers the array type for a tags column based on whether options are provided.
 *
 * - When `TOptions` is a string array: returns a narrowed array type like `('a' | 'b')[]`
 * - When `TOptions` is undefined: returns the generic `string[]` type
 *
 * @example
 * TagsArray<['a', 'b']> // ('a' | 'b')[]
 * TagsArray<undefined>  // string[]
 */
type TagsArray<TOptions extends readonly string[] | undefined> =
	TOptions extends readonly string[] ? TOptions[number][] : string[];

/**
 * Creates a tags column for storing arrays of strings (stored as JSON text, NOT NULL by default)
 *
 * Two modes:
 * 1. With options: Types are narrowed to the provided options, validated at read time
 * 2. Without options: Any string array is allowed
 *
 * When options are provided, invalid values in the database will cause reads to throw an error.
 * This ensures data integrity and surfaces corruption immediately.
 *
 * @example
 * // With options (validated against allowed values)
 * tags({ options: ['urgent', 'normal', 'low'] })
 * tags({ options: ['admin', 'user', 'guest'], nullable: true })
 * tags({ options: ['tag1', 'tag2'], default: [] })
 * tags({ options: ['a', 'b'], default: ['a'] })
 *
 * // Without options (any string array)
 * tags() // Any string array
 * tags({ nullable: true })
 * tags({ default: ['initial', 'tags'] })
 */
export function tags<
	const TOptions extends readonly string[] | undefined = undefined,
	TNullable extends boolean = false,
	TDefault extends
		| TagsArray<TOptions>
		| (() => TagsArray<TOptions>)
		| undefined = undefined,
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
			// Let JSON.parse throw on invalid JSON (like Drizzle's built-in JSON column)
			const parsed = JSON.parse(value);

			if (!Array.isArray(parsed)) {
				throw new Error(`Expected array, got ${typeof parsed}`);
			}

			// Validate all items are strings
			const nonStringItems = parsed.filter((item) => typeof item !== 'string');
			if (nonStringItems.length > 0) {
				throw new Error(
					`Tags must be strings, found: ${nonStringItems.map((item) => typeof item).join(', ')}`,
				);
			}

			const stringValues = parsed as string[];

			// If options are provided, validate that all values are allowed
			if (optionsSet) {
				const invalidValues = stringValues.filter(
					(item) => !optionsSet.has(item),
				);
				if (invalidValues.length > 0) {
					throw new Error(
						`Invalid tag values: ${invalidValues.join(', ')}. Allowed values: ${options?.join(', ')}`,
					);
				}
			}

			return stringValues as TagsArray<TOptions>;
		},
	});

	let column = tagsType();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue as any);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}

/**
 * Creates a JSON column for storing arbitrary JSON-serializable values validated against a Type schema
 * (stored as JSON text, NOT NULL by default)
 *
 * Values are validated on read using the provided Type schema. Invalid values in the database
 * will cause reads to throw an error, ensuring data integrity and surfacing corruption immediately.
 *
 * @example
 * // With validation schema
 * json({ schema: type({ name: 'string', age: 'number' }) })
 * json({ schema: userSchema, nullable: true })
 * json({ schema: configSchema, default: { theme: 'dark' } })
 */
export function json<
	const TSchema extends Type,
	TNullable extends boolean = false,
	TDefault extends
		| TSchema['infer']
		| (() => TSchema['infer'])
		| undefined = undefined,
>({
	schema,
	nullable = false as TNullable,
	default: defaultValue,
}: {
	schema: TSchema;
	nullable?: TNullable;
	default?: TDefault;
}) {
	const jsonType = customType<{
		data: TSchema['infer'];
		driverData: string;
	}>({
		dataType: () => 'text',
		toDriver: (value: TSchema['infer']): string => JSON.stringify(value),
		fromDriver: (value: string): TSchema['infer'] => {
			// Let JSON.parse throw on invalid JSON
			const parsed = JSON.parse(value);

			// Validate with Arktype
			const result = schema(parsed) as TSchema['infer'] | ArkErrors;
			if (result instanceof type.errors) {
				throw new Error(`JSON validation failed: ${result.summary}`);
			}

			return result;
		},
	});

	let column = jsonType();

	// NOT NULL by default
	if (!nullable) column = column.notNull();

	if (defaultValue !== undefined) {
		column =
			typeof defaultValue === 'function'
				? column.$defaultFn(defaultValue)
				: column.default(defaultValue as any);
	}

	return column as ApplyColumnModifiers<typeof column, TNullable, TDefault>;
}
