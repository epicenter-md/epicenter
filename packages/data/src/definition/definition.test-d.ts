import type {
	CalendarDateString,
	DateTimeString,
	InstantString,
} from '@epicenter/field';
import type { Static } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { defineData, defineTable, field, type RowOf } from './index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
type Expect<T extends true> = T;

const definition = defineData({
	id: 'so.epicenter.definition-types',
	kv: {
		status: field.select(['draft', 'published']),
		labels: field.multiSelect(['a', 'b']),
		date: field.date(),
		instant: field.instant(),
		datetime: field.datetime(),
		payload: field.json(field.select(['small', 'large'])),
		optional: field.nullable(field.string()),
	},
	tables: {
		items: {
			scalars: {
				status: field.select(['draft', 'published']),
			},
		},
	},
});

type Item = RowOf<typeof definition.tables.items>;
type Values = typeof definition.kv;

/**
 * A name is a scalar or a type field, never both.
 *
 * `RowOf` intersects the two buckets, so a collision reads as a `Static<>`
 * intersected with a `Y.Type`: an impossible field rather than a reported
 * mistake. `parseData` refuses it too; this pins the half that fires while the
 * declaration is being written.
 *
 * The expected type at the offending element IS the explanation, which is what
 * makes the error land on `'title'` instead of on the object around it.
 */
defineTable({
	scalars: { title: field.string() },
	// @ts-expect-error 'title' is already a scalar of this table
	types: ['title'],
	file: {
		serialize: () => ({ data: {}, content: '' }),
		deserialize: () => Ok({}) as never,
	},
});

/**
 * A declared default is refused where it is authored, not at first open.
 *
 * `parseData` refuses one at runtime too (`DeclarationDefault`), and this is
 * the compile-time half of that rule, for both buckets a definition has.
 *
 * Pinned because the rule is carried by a conditional type keyed on the
 * literal string `scalars`. Rename the key and the check does not fail, it
 * stops applying, silently: that is exactly what happened to the table half
 * when the declaration went from one `fields` bag to two buckets.
 *
 * The default has to be spread in rather than passed to the builder. Every
 * builder returns a fixed schema type (`field.string(opts)` is `TString`
 * whatever `opts` says), so an annotation handed to one is erased before this
 * check can see it. Only a schema whose OWN type carries `default` is caught
 * here; the rest is `parseData`'s to refuse.
 */
/**
 * The same refusal on the other authoring path.
 *
 * A table written as a literal inside `defineData` skips `defineTable`, so it
 * is `ValidateTable` rather than `RejectScalarCollision` that has to catch the
 * collision. Only `definition.test.ts` and this file write tables that way;
 * every table in the repository goes through `defineTable`.
 *
 * The message does not survive this path. `defineData` takes
 * `TData & ValidateDefinition<TData>`, and the intersection collapses the
 * offending element to `never`, taking the sentence with it. The error still
 * lands on the name, and says only that a string is not assignable to `never`.
 */
defineData({
	id: 'so.epicenter.collision-inline',
	kv: {},
	tables: {
		// @ts-expect-error 'title' is already a scalar of this table
		notes: { scalars: { title: field.string() }, types: ['title'] },
	},
});

defineData({
	id: 'so.epicenter.declaration-default',
	kv: {
		// @ts-expect-error a default belongs to the application, not the schema
		theme: { ...field.string(), default: 'light' },
	},
	tables: {
		// @ts-expect-error a default belongs to the application, not the schema
		items: { scalars: { title: { ...field.string(), default: 'untitled' } } },
	},
});

export type _SelectStatic = Expect<
	Equal<Static<Values['status']>, 'draft' | 'published'>
>;
export type _MultiSelectStatic = Expect<
	Equal<Static<Values['labels']>, ('a' | 'b')[]>
>;
export type _DateStatic = Expect<
	Equal<Static<Values['date']>, CalendarDateString>
>;
export type _InstantStatic = Expect<
	Equal<Static<Values['instant']>, InstantString>
>;
export type _DatetimeStatic = Expect<
	Equal<Static<Values['datetime']>, DateTimeString>
>;
export type _JsonStatic = Expect<
	Equal<Static<Values['payload']>, 'small' | 'large'>
>;
export type _NullableStatic = Expect<
	Equal<Static<Values['optional']>, string | null>
>;
export type _RowStatusStatic = Expect<
	Equal<Item['status'], 'draft' | 'published'>
>;
