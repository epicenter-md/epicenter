import type {
	CalendarDateString,
	DateTimeString,
	InstantString,
} from '@epicenter/field';
import type { Static } from 'typebox';
import { defineData, defineTable, field, type RowOf } from './index.js';

/**
 * A failed assertion carries both sides, so the error names what moved.
 *
 * `Expect` requires `true`, so an unequal pair reports the object below rather
 * than `Type 'false' does not satisfy the constraint 'true'`, which names
 * neither type:
 *
 *     Type '{ expected: "draft" | "published"; got: string; }'
 *     does not satisfy the constraint 'true'.
 *
 * Copied rather than shared. It is four lines of the canonical spelling with no
 * semantics of its own, and the two other copies live in `@epicenter/field` and
 * `apps/whispering`, which do not otherwise reach into each other for test
 * utilities. `wellcrafted/testing` exports this pair as of the release after
 * 0.44.0; import it from there once the catalog moves and these go.
 */
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
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
		items: defineTable({
			scalars: {
				status: field.select(['draft', 'published']),
			},
		}),
	},
});

type Item = RowOf<typeof definition.tables.items>;
type Values = typeof definition.kv;

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
