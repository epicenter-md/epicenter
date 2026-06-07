/**
 * Compile-time type tests for the `field.*` builders. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * Pattern: each assertion is exported so `noUnusedLocals` does not flag it. If an
 * assertion fails, the type error appears at the offending line during typecheck.
 *
 * The bet these prove: branding rides on `Type.Unsafe`, so the at-rest wire-form
 * (what `recognize` reads) and the authored `Static<>` are decoupled. The
 * load-bearing one is `_SelectStatic` (OQ2): native `enum` must still carry the
 * literal union, not widen to `string`.
 */

import type { Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { field, jsonValue } from './builders';
import type { DateTimeString } from './datetime-string';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
type Expect<T extends true> = T;

type NoteId = string & Brand<'NoteId'>;

// field.string(): Static = string
export type _StringStatic = Expect<
	Equal<Static<ReturnType<typeof field.string>>, string>
>;

// field.string<NoteId>(): Static = NoteId (brand preserved)
export type _StringBrandStatic = Expect<
	Equal<Static<ReturnType<typeof field.string<NoteId>>>, NoteId>
>;

// field.string<'draft'>(): never (literal subtypes rejected; use field.select)
export type _StringLiteralRejected = Expect<
	Equal<ReturnType<typeof field.string<'draft'>>, never>
>;

// field.url(): Static = string
export type _UrlStatic = Expect<
	Equal<Static<ReturnType<typeof field.url>>, string>
>;

// field.datetime(): Static = DateTimeString (brand preserved)
export type _DatetimeStatic = Expect<
	Equal<Static<ReturnType<typeof field.datetime>>, DateTimeString>
>;

// field.select([...]): Static = literal union of members  (OQ2)
const statusIds = ['draft', 'published'] as Array<'draft' | 'published'>;
export type _SelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.select<typeof statusIds>>>,
		'draft' | 'published'
	>
>;

// field.select is string-only: a numeric member list is a compile error.
// @ts-expect-error select holds strings; a numeric range is integer + min/max
field.select([1, 2, 3]);

// field.multiSelect([...]): Static = array of the literal union
export type _MultiSelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.multiSelect<typeof statusIds>>>,
		('draft' | 'published')[]
	>
>;

// field.tags(): Static = string[]
export type _TagsStatic = Expect<
	Equal<Static<ReturnType<typeof field.tags>>, string[]>
>;

// field.number / field.integer: Static = number; field.boolean: Static = boolean
export type _NumberStatic = Expect<
	Equal<Static<ReturnType<typeof field.number>>, number>
>;
export type _IntegerStatic = Expect<
	Equal<Static<ReturnType<typeof field.integer>>, number>
>;
export type _BooleanStatic = Expect<
	Equal<Static<ReturnType<typeof field.boolean>>, boolean>
>;

// field.json(inner): Static = Static<inner>. The authoring type tracks the payload schema;
// the at-rest wire-form carries the x-json-schema marker, decoupled from Static<> via Unsafe.
export type _JsonTypedStatic = Expect<
	Equal<
		Static<
			ReturnType<
				typeof field.json<
					ReturnType<typeof Type.Object<{ author: ReturnType<typeof Type.String> }>>
				>
			>
		>,
		{ author: string }
	>
>;

// jsonValue: the canonical any-JSON inner, Static = JsonValue (pinned via Type.Unsafe).
export type _JsonValueStatic = Expect<Equal<Static<typeof jsonValue>, JsonValue>>;

// field.json(Type.Array(jsonValue)): Static = JsonValue[]. The list-of-arbitrary-JSON
// pattern the apps share; the inner static flows through Array and field.json unchanged.
export type _JsonArrayStatic = Expect<
	Equal<
		Static<
			ReturnType<typeof field.json<ReturnType<typeof Type.Array<typeof jsonValue>>>>
		>,
		JsonValue[]
	>
>;
