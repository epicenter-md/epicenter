/**
 * Async Workspace Service Tests
 *
 * Verifies the serialized client/service boundary over a synchronous SQLite
 * application database.
 *
 * Key behaviors:
 * - one write batch commits in one SQLite transaction
 * - committed materialized deltas arrive before command promises resolve
 * - failed batches roll back and emit no delta
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { RecordSyncSqlite, SqliteRow } from '@epicenter/record-sync';
import { createWorkspaceClient } from './client.js';
import { createApplicationDatabase } from './database.js';
import { defineTable, defineWorkspace } from './definition.js';
import { createWorkspaceService } from './service.js';

function setup() {
	const native = new Database(':memory:');
	let transactions = 0;
	const sqlite: RecordSyncSqlite = {
		run(sql, parameters = []) {
			native.run(sql, parameters as SQLQueryBindings[]);
		},
		all<TRow extends SqliteRow>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		): TRow[] {
			return native
				.query<TRow, SQLQueryBindings[]>(sql)
				.all(...(parameters as SQLQueryBindings[]));
		},
		transaction<TResult>(run: () => TResult): TResult {
			transactions++;
			return native.transaction(run).immediate();
		},
	};
	const notes = defineTable({
		id: field.string(),
		title: field.string(),
		pinned: field.boolean(),
	});
	const definition = defineWorkspace({
		id: 'service-test',
		name: 'Service test',
		epoch: 'service-1',
		tables: { notes },
	});
	const databaseObserverErrors: unknown[] = [];
	const database = createApplicationDatabase(definition, sqlite, {
		kind: 'standalone',
		onObserverError: (error) => databaseObserverErrors.push(error),
	});
	const serviceObserverErrors: unknown[] = [];
	const service = createWorkspaceService(database, {
		onObserverError: (error) => serviceObserverErrors.push(error),
	});
	const client = createWorkspaceClient(definition, service);
	return {
		client,
		database,
		databaseObserverErrors,
		get transactionCount() {
			return transactions;
		},
		native,
		service,
		serviceObserverErrors,
	};
}

describe('workspace service', () => {
	test('one client batch emits final rows and removals before resolving', async () => {
		const setupResult = setup();
		const { client, service } = setupResult;
		const transactionsBefore = setupResult.transactionCount;
		const timeline: string[] = [];
		const deltas: unknown[] = [];
		service.observe((delta) => {
			timeline.push('committed');
			deltas.push(delta);
		});

		await client
			.transact((batch) => {
				const keptId = batch.tables.notes.create({
					title: 'One',
					pinned: false,
				});
				batch.tables.notes.patch(keptId, {
					title: 'Updated',
					pinned: true,
				});
				const removedId = batch.tables.notes.create({
					title: 'Gone',
					pinned: false,
				});
				batch.tables.notes.remove(removedId);
			})
			.then(() => timeline.push('resolved'));

		expect(setupResult.transactionCount - transactionsBefore).toBe(1);
		expect(timeline).toEqual(['committed', 'resolved']);
		expect(deltas).toEqual([
			{
				tables: {
					notes: {
						upserted: [
							expect.objectContaining({ title: 'Updated', pinned: true }),
						],
						removed: [expect.any(String)],
					},
				},
			},
		]);
	});

	test('serializable reads and patch results round-trip through the client', async () => {
		const { client } = setup();
		const one = await client.tables.notes.create({
			title: 'One',
			pinned: false,
		});
		const two = await client.tables.notes.create({
			title: 'Two',
			pinned: true,
		});

		expect(await client.tables.notes.get(one.id)).toEqual({
			id: one.id,
			title: 'One',
			pinned: false,
		});
		expect(
			await client.tables.notes.list({
				where: { pinned: true },
				orderBy: 'title',
			}),
		).toEqual([two]);
		expect(await client.tables.notes.has(one.id)).toBe(true);
		expect(await client.tables.notes.count()).toBe(2);
		expect(
			await client.tables.notes.patch(one.id, { title: 'Patched' }),
		).toEqual({ id: one.id, title: 'Patched', pinned: false });
	});

	test('invalid later writes roll back the whole batch and emit nothing', async () => {
		const { client, service } = setup();
		const deltas: unknown[] = [];
		service.observe((delta) => deltas.push(delta));

		await expect(
			client.transact((batch) => {
				const rowId = batch.tables.notes.create({
					title: 'Valid',
					pinned: false,
				});
				// Runtime service validation still protects an untyped transport peer.
				batch.tables.notes.patch(rowId, {
					title: 42 as unknown as string,
				});
			}),
		).rejects.toThrow('schema validation');
		expect(await client.tables.notes.count()).toBe(0);
		expect(deltas).toEqual([]);
	});

	test('one failing service observer does not skip peers or reject committed writes', async () => {
		const { client, service, serviceObserverErrors } = setup();
		let peerCalls = 0;
		service.observe(() => {
			throw new Error('consumer failed');
		});
		service.observe(() => peerCalls++);

		const kept = await client.tables.notes.create({
			title: 'Kept',
			pinned: false,
		});
		expect(peerCalls).toBe(1);
		expect(serviceObserverErrors).toHaveLength(1);
		expect(await client.tables.notes.has(kept.id)).toBe(true);
	});

	test('an observer-triggered write cannot overtake the commit being published', async () => {
		const { client, service } = setup();
		let nestedWrite: ReturnType<typeof client.tables.notes.create> | undefined;
		const observedTitles: string[] = [];
		service.observe((delta) => {
			if (delta.tables.notes?.upserted[0]?.title === 'First') {
				nestedWrite = client.tables.notes.create({
					title: 'Second',
					pinned: false,
				});
			}
		});
		service.observe((delta) => {
			const title = delta.tables.notes?.upserted[0]?.title;
			if (typeof title === 'string') observedTitles.push(title);
		});

		await client.tables.notes.create({
			title: 'First',
			pinned: false,
		});
		await nestedWrite;

		expect(observedTitles).toEqual(['First', 'Second']);
	});

	test('requests capture caller values before entering the serialized queue', async () => {
		const { client } = setup();
		const row = { title: 'Before', pinned: false };
		const write = client.tables.notes.create(row);
		row.title = 'After';

		const created = await write;
		expect(await client.tables.notes.get(created.id)).toEqual({
			id: created.id,
			title: 'Before',
			pinned: false,
		});
	});

	test('disposal rejects queued and future work and refuses new observers', async () => {
		const { client, service } = setup();
		const queued = client.tables.notes.create({
			title: 'Zombie',
			pinned: false,
		});
		service[Symbol.dispose]();

		await expect(queued).rejects.toThrow('disposed');
		await expect(client.tables.notes.count()).rejects.toThrow('disposed');
		expect(() => service.observe(() => undefined)).toThrow('disposed');
	});

	test('external invalidation re-reads effective database state without rebroadcasting it as a commit', async () => {
		const { client, native, service } = setup();
		const row = await client.tables.notes.create({
			title: 'Before',
			pinned: false,
		});
		const changes: unknown[] = [];
		service.observeChanges((delta, source) => changes.push({ delta, source }));
		native.run('UPDATE notes SET title = ? WHERE id = ?', ['After', row.id]);

		await service.refresh({ tables: { notes: [row.id] } });

		expect(changes).toEqual([
			{
				delta: {
					tables: {
						notes: {
							upserted: [{ id: row.id, title: 'After', pinned: false }],
							removed: [],
						},
					},
				},
				source: 'refresh',
			},
		]);
	});
});
