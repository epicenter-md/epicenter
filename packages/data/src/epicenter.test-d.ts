/**
 * Compile-time tests for the public typed Data API.
 *
 * These assertions prove row inference, create/patch inputs, and the
 * universal row-document capability directly from inert definitions.
 */
import { field } from '@epicenter/field';
import {
	defineLens,
	defineTable,
	type Epicenter,
	optional,
	type RowFor,
} from './index.js';

type Equal<TLeft, TRight> =
	(<TValue>() => TValue extends TLeft ? 1 : 2) extends <
		TValue,
	>() => TValue extends TRight ? 1 : 2
		? true
		: false;
type Expect<TValue extends true> = TValue;

const ordinary = defineTable({
	fields: {
		title: field.string(),
		note: optional(field.string()),
	},
});

export type _RowDerivesRequiredAndOptionalFields = Expect<
	Equal<
		RowFor<typeof ordinary>,
		{ id: string } & { title: string } & { note?: string }
	>
>;

declare const epicenter: Epicenter;
const bound = epicenter.bind(
	defineLens({
		namespace: 'so.epicenter.types',
		tables: { ordinary },
	}),
);

// A bound Lens is its tables. There is no `tables` level to reach through,
// because a Lens declares nothing that would sit beside them (ADR-0206).
await bound.ordinary.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');

await bound.ordinary.create({ title: 'valid' });
await bound.ordinary.patch('aaaaaaaaaaaaaaaaaaaaaaaa', { note: undefined });

// The second door: an id the application already knows, which is how a
// singleton reaches the same address on every device.
await bound.ordinary.create('app', { title: 'valid' });

// @ts-expect-error An id is a coordinate, never a field.
await bound.ordinary.create({ id: 'caller-id', title: 'invalid' });

// @ts-expect-error Supplying an id does not make the row's fields optional.
await bound.ordinary.create('app', {});

await bound.ordinary.patch('aaaaaaaaaaaaaaaaaaaaaaaa', {
	// @ts-expect-error Required fields cannot be removed with undefined.
	title: undefined,
});
