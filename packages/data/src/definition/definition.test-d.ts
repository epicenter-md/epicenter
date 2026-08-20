import type { Static } from 'typebox';
import type { CalendarDateString } from '@epicenter/field';
import type { DateTimeString } from '@epicenter/field';
import type { InstantString } from '@epicenter/field';
import { defineData, field, type RowOf } from './index.js';

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
			status: field.select(['draft', 'published']),
		},
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
