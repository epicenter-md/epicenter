/**
 * SQLite Workspace Client Tests
 *
 * Verifies fresh-id allocation, serialized mutation batches, response
 * validation, commit deltas, and child-document identity at the async port.
 *
 * Key behaviors:
 * - create allocates UUID identities and returns committed rows
 * - transaction builders allocate ids synchronously and send one batch
 * - malformed service rows and results are rejected
 */

import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import { createWorkspaceClient, type WorkspaceServicePort } from './client.js';
import { defineTable, defineWorkspace } from './definition.js';

test('async client sends one write-only transaction and filters table deltas', async () => {
	const requests: unknown[] = [];
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			requests.push(request);
			if (request.kind === 'mutate') {
				return {
					kind: 'mutation',
					results: request.mutations.map((mutation) =>
						mutation.kind === 'create' ? mutation.row : null,
					),
				};
			}
			return { kind: 'row', row: null };
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
	};
	const notes = defineTable({ id: field.string(), title: field.string() });
	const definition = defineWorkspace({
		id: 'client-test',
		name: 'Client test',
		epoch: 'client-1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: { notes },
	});
	const client = createWorkspaceClient(definition, port);
	const deltas: unknown[] = [];
	client.tables.notes.observe((delta) => deltas.push(delta));

	let createdId = '';
	await client.transact((batch) => {
		createdId = batch.tables.notes.create({ title: 'One' });
		batch.tables.notes.patch(createdId, { title: 'Updated' });
	});
	expect(createdId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(requests).toEqual([
		{
			kind: 'mutate',
			mutations: [
				{
					kind: 'create',
					table: 'notes',
					row: { id: createdId, title: 'One' },
				},
				{
					kind: 'patch',
					table: 'notes',
					rowId: createdId,
					cells: { title: 'Updated' },
				},
			],
		},
	]);

	for (const observer of observers) {
		observer({
			tables: {
				notes: { upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
			},
		});
	}
	expect(deltas).toEqual([
		{ upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
	]);
});

test('create returns committed rows with distinct UUID identities', async () => {
	const port: WorkspaceServicePort = {
		async request(request) {
			if (request.kind !== 'mutate') throw new Error('unexpected read');
			return {
				kind: 'mutation',
				results: request.mutations.map((mutation) =>
					mutation.kind === 'create' ? mutation.row : null,
				),
			};
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		id: 'client-create-test',
		name: 'Client create test',
		epoch: 'client-create-1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const client = createWorkspaceClient(definition, port);

	const first = await client.tables.notes.create({ title: 'Draft' });
	const second = await client.tables.notes.create({ title: 'Draft' });

	expect(first).toEqual({ id: first.id, title: 'Draft' });
	expect(second).toEqual({ id: second.id, title: 'Draft' });
	expect(first.id).not.toBe(second.id);
	expect(first.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
});

test('empty and async transaction builders never send a partial mutation', async () => {
	const requests: unknown[] = [];
	const port: WorkspaceServicePort = {
		async request(request) {
			requests.push(request);
			return { kind: 'mutation', results: [] };
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		id: 'client-builder-test',
		name: 'Client builder test',
		epoch: 'client-builder-1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await client.transact(() => undefined);
	await expect(
		client.transact(async (batch) => {
			batch.tables.notes.create({ title: 'Not sent' });
		}),
	).rejects.toThrow('must be synchronous');

	expect(requests).toEqual([]);
});

test('typed client rejects malformed rows, deltas, and mutation results', async () => {
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			switch (request.kind) {
				case 'get':
					return { kind: 'row', row: { id: request.rowId, title: 42 } };
				case 'mutate':
					return { kind: 'mutation', results: [] };
				default:
					return { kind: 'count', value: 0 };
			}
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
	};
	const definition = defineWorkspace({
		id: 'client-validation-test',
		name: 'Client validation test',
		epoch: 'client-validation-v1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await expect(client.tables.notes.get('one')).rejects.toThrow(
		"invalid 'notes' row",
	);
	await expect(client.tables.notes.create({ title: 'One' })).rejects.toThrow(
		'wrong mutation result count',
	);

	client.tables.notes.observe(() => undefined);
	const [tableObserver] = observers;
	expect(() =>
		tableObserver?.({
			tables: {
				notes: { upserted: [{ id: 'one', title: 42 }], removed: [] },
			},
		}),
	).toThrow("invalid 'notes' row");
});

test('sql validates every result row against the caller schema', async () => {
	const port: WorkspaceServicePort = {
		async request(request) {
			if (request.kind !== 'sql') throw new Error('unexpected request');
			return { kind: 'sql', rows: [{ title: 'Valid' }, { title: 42 }] };
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		id: 'client-sql-validation-test',
		name: 'Client SQL validation test',
		epoch: 'client-sql-validation-1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await expect(
		client.sql(
			'SELECT title FROM notes',
			[],
			Type.Object({ title: Type.String() }),
		),
	).rejects.toThrow('invalid row at index 1');
});

test('tables expose guid-only child-doc identity derived from the definition', () => {
	const port: WorkspaceServicePort = {
		async request() {
			throw new Error('guid derivation must not round-trip to the service');
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		id: 'client-docs-test',
		name: 'Client docs test',
		epoch: 'client-docs-1',
		rootDocumentIncarnation: 'sqlite-kv-1',
		tables: {
			notes: defineTable(
				{ id: field.string(), title: field.string() },
				{ docs: { body: 'richText', summary: 'plainText' } },
			),
		},
	});
	const client = createWorkspaceClient(definition, port);

	const bodyGuid: string = client.tables.notes.docs.body.guid('row-1');
	const summaryGuid: string = client.tables.notes.docs.summary.guid('row-1');
	expect(bodyGuid).toBe('client-docs-test.notes.row-1.body');
	expect(summaryGuid).toBe('client-docs-test.notes.row-1.summary');
	// The canonical 4-part grammar stays injective: every segment is dot-free.
	expect(() => client.tables.notes.docs.body.guid('bad.row')).toThrow(
		'Invalid rowId',
	);
});
