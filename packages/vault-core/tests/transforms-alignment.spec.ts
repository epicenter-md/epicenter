import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Adapter } from '../src/core/adapter';
import { defineAdapter } from '../src/core/adapter';
import {
	defineTransformRegistry,
	defineVersions,
} from '../src/core/migrations';
import { testSchema, testVersions } from './fixtures/testAdapter';

test('defineAdapter throws when transforms include extra tags not declared in versions', () => {
	const transformsWithExtra = defineTransformRegistry({
		'0001': (value) => value,
	});

	const createBadAdapter = defineAdapter(
		// @ts-expect-error missing versions, this should fail the type check
		(() =>
			({
				id: 'test',
				schema: testSchema,
				versions: testVersions,
				transforms: transformsWithExtra,
			}) as unknown as Adapter) as () => Adapter,
	);

	assert.throws(() => createBadAdapter(), /transforms do not match versions/i);
});

test('defineAdapter throws when transforms are missing required tags from versions', () => {
	const versions = defineVersions(
		{
			tag: '0000',
			sql: [
				`CREATE TABLE IF NOT EXISTS test_items (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);`,
			],
		},
		{
			tag: '0001',
			sql: [],
		},
	);

	const emptyTransforms = defineTransformRegistry({});

	const createBadAdapter = defineAdapter(
		// @ts-expect-error invalid validator, this should fail the type check
		(() =>
			({
				id: 'test',
				schema: testSchema,
				versions,
				transforms: emptyTransforms,
			}) as unknown as Adapter) as () => Adapter,
	);

	assert.throws(() => createBadAdapter(), /transforms do not match versions/i);
});
