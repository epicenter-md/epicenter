import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createWorkspaceClient, type WorkspaceServicePort } from './client.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';

test('async client sends one write-only transaction and filters table deltas', async () => {
	const requests: unknown[] = [];
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			requests.push(request);
			if (request.kind === 'mutate') {
				return { kind: 'mutation', results: request.mutations.map(() => null) };
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
		tables: { notes },
		kv: { theme: defineKv(field.string(), () => 'light') },
	});
	const client = createWorkspaceClient(definition, port);
	const deltas: unknown[] = [];
	client.tables.notes.observe((delta) => deltas.push(delta));

	await client.transact((batch) => {
		batch.tables.notes.put({ id: 'one', title: 'One' });
		batch.tables.notes.patch('one', { title: 'Updated' });
		batch.kv.set('theme', 'dark');
	});
	expect(requests).toEqual([
		{
			kind: 'mutate',
			mutations: [
				{ kind: 'put', table: 'notes', row: { id: 'one', title: 'One' } },
				{
					kind: 'patch',
					table: 'notes',
					rowId: 'one',
					cells: { title: 'Updated' },
				},
				{ kind: 'setKv', key: 'theme', value: 'dark' },
			],
		},
	]);

	for (const observer of observers) {
		observer({
			tables: {
				notes: { upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
			},
			kv: { theme: 'dark' },
		});
	}
	expect(deltas).toEqual([
		{ upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
	]);
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
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
		kv: {},
	});
	const client = createWorkspaceClient(definition, port);

	await client.transact(() => undefined);
	await expect(
		client.transact(async (batch) => {
			batch.tables.notes.put({ id: 'not-sent', title: 'Not sent' });
		}),
	).rejects.toThrow('must be synchronous');

	expect(requests).toEqual([]);
});

test('typed client rejects malformed rows, KV values, deltas, and mutation results', async () => {
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			switch (request.kind) {
				case 'get':
					return { kind: 'row', row: { id: request.rowId, title: 42 } };
				case 'getKv':
					return { kind: 'value', value: 42 };
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
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
		kv: { theme: defineKv(field.string(), () => 'light') },
	});
	const client = createWorkspaceClient(definition, port);

	await expect(client.tables.notes.get('one')).rejects.toThrow(
		"invalid 'notes' row",
	);
	await expect(client.kv.get('theme')).rejects.toThrow('invalid KV value');
	await expect(
		client.tables.notes.put({ id: 'one', title: 'One' }),
	).rejects.toThrow('wrong mutation result count');

	client.tables.notes.observe(() => undefined);
	client.kv.observe(() => undefined);
	const [tableObserver, kvObserver] = observers;
	expect(() =>
		tableObserver?.({
			tables: {
				notes: { upserted: [{ id: 'one', title: 42 }], removed: [] },
			},
			kv: {},
		}),
	).toThrow("invalid 'notes' row");
	expect(() => kvObserver?.({ tables: {}, kv: { theme: 42 } })).toThrow(
		'invalid KV value',
	);
});
