/**
 * Compile-time tests for `FlatJsonTSchema`, the `defineTable` column constraint. Compiled
 * by `tsc --noEmit` alongside the rest of the workspace package; nothing runs at test time.
 *
 * Scope: the CONSTRAINT only (which schemas it accepts and rejects). The `field.*` builder
 * typing (Static<>, brand preservation, select inference, field.json authoring) is proven in
 * `@epicenter/field`'s `field.test-d.ts`; this file does not duplicate it.
 *
 * Pattern: each assertion is exported so that `noUnusedLocals` does not flag it. If an
 * assertion fails, the type error appears at the offending line during typecheck.
 */

import type { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { field } from '@epicenter/field';
import type { ColumnError, FlatJsonTSchema } from './constraint';
import type { nullable } from '../nullable';

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
	typeof nullable<ReturnType<typeof Type.String>>
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
// A list of scalars is a flat JSON-TEXT column (field.tags / field.multiSelect), so
// Type.Array(scalar) is ACCEPTED. Only a list of non-JSON elements is rejected, by the
// final Static<S> extends JsonValue clause.
export type _AcceptArrayOfScalar = Expect<
	Equal<
		FlatJsonTSchema<ReturnType<typeof Type.Array<ReturnType<typeof Type.Number>>>>,
		ReturnType<typeof Type.Array<ReturnType<typeof Type.Number>>>
	>
>;
export type _RejectArrayOfNonJson = Expect<
	Equal<
		IsError<
			FlatJsonTSchema<
				ReturnType<typeof Type.Array<ReturnType<typeof Type.Unsafe<Date>>>>
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
// field.json inners are gated by the constraint, not by field.json itself
// --------------------------------------------------------------------------
//
// The field.* builder TYPING (Static<>, brand preservation, select inference, field.json
// authoring shape) is proven in @epicenter/field's field.test-d.ts. Here we assert only
// the workspace's concern: FlatJsonTSchema GATES a field.json whose inner Static is not
// JSON-safe. field.json itself carries no gate (that would pull ColumnError into the leaf),
// so a non-JSON inner flows through as TUnsafe<Date> and is rejected at the defineTable
// boundary.

type NoteId = string & Brand<'NoteId'>;

type _JsonDate = ReturnType<
	typeof field.json<ReturnType<typeof Type.Unsafe<Date>>>
>;
export type _JsonDateRejectedByConstraint = Expect<
	Equal<IsError<FlatJsonTSchema<_JsonDate>>, true>
>;

// Same for bigint.
type _JsonBigInt = ReturnType<
	typeof field.json<ReturnType<typeof Type.Unsafe<bigint>>>
>;
export type _JsonBigIntRejectedByConstraint = Expect<
	Equal<IsError<FlatJsonTSchema<_JsonBigInt>>, true>
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
