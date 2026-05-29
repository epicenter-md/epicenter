/**
 * The `column.*` sugar layer.
 *
 * Three helpers add real behavior:
 * - `string<T>` for brand sugar (rejects literal-string subtypes at compile time)
 * - `json<T extends JsonValue>(schema)` for the `JsonValue` gate plus required runtime schema
 * - `nullable(inner)` for `Type.Union([inner, Type.Null()])` composition
 *
 * Two helpers wrap branded-string datetime patterns:
 * - `dateTime` (TypeBox's built-in `date-time` format, brand `DateTimeString`)
 * - `ianaTimeZone` (custom format validated against `Intl.DateTimeFormat`,
 *   brand `IanaTimeZone`; registered once at module load)
 *
 * The rest alias `Type.X` directly and are assembled onto the `column` object
 * below, so autocomplete on `column.` lists the entire SQLite-safe constructor
 * menu. They keep TypeBox's full JSDoc / signature / overloads intact (single
 * source of truth):
 *
 *   column.number   = Type.Number
 *   column.integer  = Type.Integer
 *   column.boolean  = Type.Boolean
 *   column.literal  = Type.Literal
 *
 * `column` is the only builder export (the `Infer` type aside): the builders
 * are module-private and reachable solely as `column.X`, so there is one
 * blessed way to construct a column.
 *
 * `column.enum` is a small function (it builds a Union from a values array)
 * so it isn't a plain alias, but it still defers all option-typing to TypeBox.
 *
 * Users may freely mix `column.X()` and raw `Type.X()`; the `FlatJsonTSchema`
 * constraint enforces safety regardless of which call site produced the
 * schema.
 */

import {
	type Static,
	type TLiteral,
	type TLiteralValue,
	type TNull,
	type TSchema,
	type TSchemaOptions,
	type TString,
	type TStringOptions,
	type TUnion,
	type TUnsafe,
	Type,
} from 'typebox';
import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { DateTimeString } from '../../shared/datetime-string';
import {
	IANA_TIME_ZONE_FORMAT,
	IanaTimeZone,
} from '../../shared/iana-time-zone';
import type { ColumnError } from './constraint';

type BrandedString = string & Brand<string>;

// Register the IANA timezone format once at module load. Skip if another
// caller already registered it (idempotent under hot-reload / repeated
// module evaluation).
if (!Format.Has(IANA_TIME_ZONE_FORMAT)) {
	Format.Set(IANA_TIME_ZONE_FORMAT, (value) => IanaTimeZone.is(value));
}

/**
 * String column with optional brand sugar.
 *
 * - `column.string()` → `TString`, `Static<>` = `string`.
 * - `column.string<NoteId>()` → `TUnsafe<NoteId>`, `Static<>` = `NoteId`.
 * - `column.string<'draft'>()` → `never` (compile-time): pretending a literal
 *   subtype is enforced at runtime is dishonest; use `column.literal('draft')`
 *   instead.
 */
function string<T extends string = string>(
	opts?: TStringOptions,
): string extends T ? TString : T extends BrandedString ? TUnsafe<T> : never {
	return Type.String(opts) as string extends T
		? TString
		: T extends BrandedString
			? TUnsafe<T>
			: never;
}

/** Pass-through to `Type.Number`, exposed as `column.number`. */
const number = Type.Number;

/** Pass-through to `Type.Integer`. */
const integer = Type.Integer;

/** Pass-through to `Type.Boolean`. */
const boolean = Type.Boolean;

/**
 * Pass-through to `Type.Literal`. Use for status enums and other
 * literal-valued column shapes. (Version discriminators are now
 * library-managed via `defineTable`'s tuple position; do not declare
 * `_v` as a column.)
 */
const literal = Type.Literal;

type EnumMembers<T extends readonly TLiteralValue[]> = [
	TLiteral<T[number] & TLiteralValue>,
	...TLiteral<T[number] & TLiteralValue>[],
];

/**
 * Enum-of-literals column. Produces `Type.Union<TLiteral[]>` (anyOf-of-const).
 * The SQLite materializer's `deriveCheck` emits this shape as
 * `col IN ('a', 'b')`.
 *
 * `Type.Enum` (`~kind: 'Enum'`) is rejected by `FlatJsonTSchema` in favor of
 * this shape so the CHECK generator has one shape to walk.
 */
function enum_<const T extends readonly TLiteralValue[]>(
	values: T,
	opts?: TSchemaOptions,
): TUnion<EnumMembers<T>> {
	if (values.length === 0) {
		throw new Error('column.enum requires at least one value');
	}
	const members = values.map((v) => Type.Literal(v));
	return Type.Union(members, opts) as TUnion<EnumMembers<T>>;
}

/**
 * JSON-encoded TEXT column. The TypeScript type derives from `Static<S>`, so
 * the static and runtime sides are guaranteed to agree (no free `<T>`
 * generic that could drift from the schema you actually pass).
 *
 * The schema argument is required: no implicit `Type.Any()`. The
 * `JsonValue` gate runs on `Static<S>` and surfaces as a readable type error
 * if the schema admits non-JSON shapes (`Date`, `bigint`, `undefined`,
 * optional keys widened under loose `exactOptionalPropertyTypes`).
 *
 * @example
 * ```ts
 * column.json(Type.Array(Type.String()))          // Static = string[]
 * column.json(Type.Object({ x: Type.Number() }))  // Static = { x: number }
 * ```
 */
function json<S extends TSchema>(
	schema: S,
	opts?: TSchemaOptions,
): TUnsafe<
	Static<S> extends JsonValue
		? Static<S>
		: ColumnError<`column.json schema must produce a JSON-safe Static<> value (got a shape containing Date, bigint, undefined, or optional keys widened to ' | undefined').`>
> {
	return Type.Unsafe(opts ? { ...schema, ...opts } : schema) as TUnsafe<
		Static<S> extends JsonValue
			? Static<S>
			: ColumnError<`column.json schema must produce a JSON-safe Static<> value (got a shape containing Date, bigint, undefined, or optional keys widened to ' | undefined').`>
	>;
}

/**
 * Composition sugar: `Type.Union([schema, Type.Null()])`. Reads as "nullable
 * inner" instead of constructing the union by hand. Matches TypeBox issue #989
 * guidance on nullability.
 */
function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]> {
	return Type.Union([schema, Type.Null()]);
}

/**
 * RFC 3339 / ISO 8601 datetime string, branded as `DateTimeString`.
 *
 * Uses TypeBox v1's built-in `date-time` format validator (auto-registered;
 * no `Format.Set` required from us). Accepts both Z (`...Z`) and offset
 * (`...±HH:MM`) forms.
 *
 * **Writing convention.** Lex-sort across rows is chronological iff every
 * writer emits the Z form. `new Date().toISOString()` and
 * `Temporal.Now.instant().toString()` both do this. The convention is
 * documented on the brand, not enforced at the schema layer.
 *
 * Pair with `column.ianaTimeZone()` as a separate field when the originating
 * zone matters (calendar events, reminders); see the `<field>` + `<field>Zone`
 * naming convention in the workspace spec.
 */
function dateTime(opts?: TSchemaOptions): TUnsafe<DateTimeString> {
	return Type.Unsafe<DateTimeString>(
		Type.String({ format: 'date-time', ...opts }),
	);
}

/**
 * IANA timezone identifier, branded as `IanaTimeZone`.
 *
 * The `iana-time-zone` format is registered once at module load via
 * `Format.Set`, using `Intl.DateTimeFormat` as the source of truth (any zone
 * the runtime accepts is valid; any zone it rejects is not). No hand-tuned
 * regex.
 */
function ianaTimeZone(opts?: TSchemaOptions): TUnsafe<IanaTimeZone> {
	return Type.Unsafe<IanaTimeZone>(
		Type.String({ format: IANA_TIME_ZONE_FORMAT, ...opts }),
	);
}

/**
 * The `column.*` namespace. `column.X(opts)` returns a vanilla TypeBox
 * `TSchema` (identical to what `Type.X(opts)` returns; the helpers don't wrap
 * or annotate). Each schema *is* the JSON Schema, the validator input, and
 * the static-type carrier.
 */
export const column = {
	string,
	number,
	integer,
	boolean,
	literal,
	enum: enum_,
	json,
	nullable,
	dateTime,
	ianaTimeZone,
};

/**
 * `Static<>` shorthand that mirrors TypeBox's `Static<S>` for ergonomics.
 * Exported alongside the `column` namespace so consumers can read row types
 * out of column maps without a separate TypeBox import.
 */
export type Infer<S extends TSchema> = Static<S>;
