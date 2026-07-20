/**
 * Compile-time tests for the public typed Data API.
 *
 * These assertions prove row inference, create/update inputs, and document
 * capability gating directly from inert definitions.
 */
import { field } from '@epicenter/field';
import { defineTable, type Epicenter, optional, type RowFor } from './index.js';

type Equal<TLeft, TRight> =
	(<TValue>() => TValue extends TLeft ? 1 : 2) extends <
		TValue,
	>() => TValue extends TRight ? 1 : 2
		? true
		: false;
type Expect<TValue extends true> = TValue;

const ordinary = defineTable({
	key: 'so.epicenter.types.ordinary',
	fields: {
		title: field.string(),
		note: optional(field.string()),
	},
});

const documented = defineTable({
	key: 'so.epicenter.types.documented',
	fields: { title: field.string() },
	document: true,
});

export type _RowDerivesRequiredAndOptionalFields = Expect<
	Equal<
		RowFor<typeof ordinary>,
		{ id: string } & { title: string } & { note?: string }
	>
>;

declare const epicenter: Epicenter;
const bound = epicenter.bind({
	tables: { ordinary, documented },
	values: {},
});

await bound.tables.documented.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');

// @ts-expect-error Tables without document: true do not expose openDocument.
await bound.tables.ordinary.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');

await bound.tables.ordinary.create({ title: 'valid' });
await bound.tables.ordinary.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
	note: undefined,
});

// @ts-expect-error Row ids are minted by the runtime.
await bound.tables.ordinary.create({ id: 'caller-id', title: 'invalid' });

await bound.tables.ordinary.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
	// @ts-expect-error Required fields cannot be removed with undefined.
	title: undefined,
});
