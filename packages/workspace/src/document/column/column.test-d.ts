/**
 * Compile-time type tests for `FlatJsonTSchema` and the `column.*` sugar
 * layer. Compiled by `tsc --noEmit` alongside the rest of the workspace
 * package; the file does not run anything at test time.
 *
 * Pattern: each assertion is exported so that `noUnusedLocals` does not
 * flag them. If an assertion fails, the type error appears at the
 * offending line during typecheck.
 */

import type { Static, TUnsafe, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { ColumnError, column, FlatJsonTSchema } from './index';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;
type EmptyProperties = Record<string, never>;

// --------------------------------------------------------------------------
// ColumnError pattern
// --------------------------------------------------------------------------

export type _ColumnErrorIsString = Expect<
	Equal<ColumnError<'x'> extends string ? true : false, true>
>;

// --------------------------------------------------------------------------
// FlatJsonTSchema: accepts
// --------------------------------------------------------------------------

export type _AcceptString = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.String>>,
		ReturnType<typeof Type.String>
	>
>;
export type _AcceptNumber = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.Number>>,
		ReturnType<typeof Type.Number>
	>
>;
export type _AcceptInteger = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.Integer>>,
		ReturnType<typeof Type.Integer>
	>
>;
export type _AcceptBoolean = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.Boolean>>,
		ReturnType<typeof Type.Boolean>
	>
>;
export type _AcceptLiteral = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.Literal<1>>>,
		ReturnType<typeof Type.Literal<1>>
	>
>;

// Nullable composition (Union of [String, Null]) is accepted.
type NullableString = ReturnType<
	typeof column.nullable<ReturnType<typeof Type.String>>
>;
export type _AcceptNullable = Expect<
	Equal<FlatJsonTSchema<NullableString>, NullableString>
>;

// --------------------------------------------------------------------------
// FlatJsonTSchema: rejects (return type is a ColumnError string)
// --------------------------------------------------------------------------

type IsError<S> = S extends string ? true : false;

export type _RejectObject = Expect<
	Equal<
		IsError<FlatJsonTSchema<ReturnType<typeof Type.Object<EmptyProperties>>>>,
		true
	>
>;
export type _RejectArray = Expect<
	Equal<
		IsError<
			FlatJsonTSchema<
				ReturnType<typeof Type.Array<ReturnType<typeof Type.Number>>>
			>
		>,
		true
	>
>;
export type _RejectBigInt = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.BigInt>>>, true>
>;
export type _RejectAny = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.Any>>>, true>
>;
export type _RejectNever = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.Never>>>, true>
>;
export type _RejectUndefined = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.Undefined>>>, true>
>;
export type _RejectSymbol = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.Symbol>>>, true>
>;
export type _RejectRecord = Expect<
	Equal<
		IsError<
			FlatJsonTSchema<
				ReturnType<
					typeof Type.Record<
						ReturnType<typeof Type.String>,
						ReturnType<typeof Type.String>
					>
				>
			>
		>,
		true
	>
>;
export type _RejectFunction = Expect<
	Equal<
		IsError<
			FlatJsonTSchema<
				ReturnType<typeof Type.Function<[], ReturnType<typeof Type.Number>>>
			>
		>,
		true
	>
>;
export type _RejectPromise = Expect<
	Equal<
		IsError<
			FlatJsonTSchema<
				ReturnType<typeof Type.Promise<ReturnType<typeof Type.Number>>>
			>
		>,
		true
	>
>;

// --------------------------------------------------------------------------
// column.string brand sugar
// --------------------------------------------------------------------------

type NoteId = string & Brand<'NoteId'>;

// column.string<'draft'>() returns never (literal subtypes not allowed).
export type _StringLiteralRejected = Expect<
	Equal<ReturnType<typeof column.string<'draft'>>, never>
>;

// column.string<NoteId>() returns a branded Unsafe schema.
export type _StringBrandedReturnsUnsafe = ReturnType<
	typeof column.string<NoteId>
>;

// --------------------------------------------------------------------------
// column.enum static inference
// --------------------------------------------------------------------------

const statusIds = ['draft', 'published'] as Array<'draft' | 'published'>;
type StatusSchema = ReturnType<typeof column.enum<typeof statusIds>>;
export type _EnumArrayPreservesElementUnion = Expect<
	Equal<Static<StatusSchema>, 'draft' | 'published'>
>;

// --------------------------------------------------------------------------
// column.json gate (Static<S> derived from schema; JsonValue-checked)
// --------------------------------------------------------------------------

// Schema with a JSON-safe Static passes through untouched.
export type _JsonAcceptsObject = Expect<
	Equal<
		ReturnType<
			typeof column.json<
				ReturnType<
					typeof Type.Object<{
						tags: ReturnType<typeof Type.Array<ReturnType<typeof Type.String>>>;
					}>
				>
			>
		>,
		TUnsafe<{ tags: string[] }>
	>
>;

// Schema whose Static contains Date (via Unsafe<Date>) collapses the return
// type to a ColumnError template-literal, surfaced in the IDE tooltip.
type _JsonDate = ReturnType<
	typeof column.json<ReturnType<typeof Type.Unsafe<Date>>>
>;
export type _JsonRejectsDate = Expect<
	Equal<Static<_JsonDate> extends string ? true : false, true>
>;

// Same for bigint.
type _JsonBigInt = ReturnType<
	typeof column.json<ReturnType<typeof Type.Unsafe<bigint>>>
>;
export type _JsonRejectsBigInt = Expect<
	Equal<Static<_JsonBigInt> extends string ? true : false, true>
>;

// --------------------------------------------------------------------------
// Static<> JsonValue secondary check
// --------------------------------------------------------------------------

// Type.Unsafe<Date>(Type.String()) bypasses structural ~kind check (kind:Unsafe)
// but should be rejected by the Static<S> extends JsonValue secondary check.
export type _UnsafeDateRejected = Expect<
	Equal<IsError<FlatJsonTSchema<ReturnType<typeof Type.Unsafe<Date>>>>, true>
>;

// Type.Unsafe<NoteId>(Type.String()) passes both checks.
type UnsafeNoteId = ReturnType<typeof Type.Unsafe<NoteId>>;
export type _UnsafeBrandAccepted = Expect<
	Equal<FlatJsonTSchema<UnsafeNoteId>, UnsafeNoteId>
>;

// Sanity: JsonValue itself accepts a string.
export type _JsonValueAcceptsString = Expect<
	Equal<'x' extends JsonValue ? true : false, true>
>;
