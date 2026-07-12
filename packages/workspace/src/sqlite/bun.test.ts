import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { field } from '@epicenter/field';
import { openLocalWorkspace } from './bun.js';
import { defineTable, defineWorkspace } from './definition.js';

test('Bun local workspace persists typed rows across service lifecycles', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-'));
	const path = join(directory, 'workspace.db');
	const definition = defineWorkspace({
		id: 'bun-local-test',
		name: 'Bun local test',
		epoch: 'bun-local-v1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const errors: unknown[] = [];

	try {
		const first = await openLocalWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		await first.tables.notes.put({ id: 'one', title: 'Persisted' });
		await expect(
			openLocalWorkspace(definition, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('already has an owner');
		await first[Symbol.asyncDispose]();

		const mismatched = defineWorkspace({
			id: 'bun-local-test',
			name: 'Bun local test',
			epoch: 'bun-local-v1',
			tables: {
				notes: defineTable({
					id: field.string(),
					title: field.string(),
					body: field.string(),
				}),
			},
		});
		await expect(
			openLocalWorkspace(mismatched, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('schema identity does not match');

		const reopened = await openLocalWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		expect(await reopened.tables.notes.get('one')).toEqual({
			id: 'one',
			title: 'Persisted',
		});
		await reopened[Symbol.asyncDispose]();
		expect(errors).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
