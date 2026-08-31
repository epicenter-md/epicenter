/**
 * `describeExpected` tests: a loaded field projects to its serializable expected value. The two
 * enum-carrying kinds (`select` / `multiSelect`) must lift their members; every other kind reduces
 * to its name. Fields are built through `validateContract`, the same recognition the live contract uses.
 */

import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { Field } from '../field/index.js';
import { validateContract } from './contract';
import { describeExpected } from './expected';

/** Recognize one at-rest field schema into a loaded {@link Field}. */
function fieldFrom(schema: unknown): Field {
	const data = expectOk(validateContract({ fields: { f: schema } }));
	const [field] = data.fields;
	if (!field) throw new Error('schema was not recognized as a field');
	return field;
}

describe('describeExpected', () => {
	test('a scalar kind reduces to its name', () => {
		expect(describeExpected(fieldFrom({ type: 'string' }))).toEqual({
			kind: 'string',
		});
		expect(describeExpected(fieldFrom({ type: 'integer' }))).toEqual({
			kind: 'integer',
		});
		expect(describeExpected(fieldFrom({ type: 'boolean' }))).toEqual({
			kind: 'boolean',
		});
	});

	test('a reference reduces to its name (no target table leaks in)', () => {
		expect(
			describeExpected(fieldFrom({ type: 'string', 'x-ref': 'pages' })),
		).toEqual({ kind: 'reference' });
	});

	test('select carries its enum members', () => {
		expect(
			describeExpected(fieldFrom({ type: 'string', enum: ['draft', 'live'] })),
		).toEqual({ kind: 'select', values: ['draft', 'live'] });
	});

	test('multiSelect carries its enum members', () => {
		expect(
			describeExpected(
				fieldFrom({
					type: 'array',
					items: { type: 'string', enum: ['a', 'b'] },
				}),
			),
		).toEqual({ kind: 'multiSelect', values: ['a', 'b'] });
	});
});
