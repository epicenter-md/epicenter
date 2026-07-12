import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createWorkspaceClient, type WorkspaceServicePort } from './client.js';
import { defineTable, defineWorkspace } from './definition.js';

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
	});
	const client = createWorkspaceClient(definition, port);
	const deltas: unknown[] = [];
	client.tables.notes.observe((delta) => deltas.push(delta));

	await client.transact((batch) => {
		batch.tables.notes.put({ id: 'one', title: 'One' });
		batch.tables.notes.patch('one', { title: 'Updated' });
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
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await expect(client.tables.notes.get('one')).rejects.toThrow(
		"invalid 'notes' row",
	);
	await expect(
		client.tables.notes.put({ id: 'one', title: 'One' }),
	).rejects.toThrow('wrong mutation result count');

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
