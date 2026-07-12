/**
 * Typed SQLite Application Database Tests
 *
 * Verifies that workspace rows are stored as typed SQLite columns and that
 * table/KV writes share one post-commit invalidation boundary.
 *
 * Key behaviors:
 * - CRUD uses typed columns, declared indexes, codecs, and terminal tombstones
 * - successful transactions invalidate once after commit; rollback is silent
 * - representation migrations advance one persisted storage revision
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { RecordSyncSqlite } from '@epicenter/record-sync';
import { Type } from 'typebox';
import { nullable } from '../document/nullable.js';
import {
	type ApplicationMutationCoordinator,
	createApplicationDatabase,
} from './database.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';

function createSqlite(database: Database): RecordSyncSqlite {
	return {
		run(sql, parameters = []) {
			database.run(sql, parameters as SQLQueryBindings[]);
		},
		all<TRow extends Record<string, string | number | null>>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		): TRow[] {
			return database
				.query<TRow, SQLQueryBindings[]>(sql)
				.all(...(parameters as SQLQueryBindings[]));
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
	};
}

function setup() {
	const database = new Database(':memory:');
	const sqlite = createSqlite(database);
	const notes = defineTable(
		{
			id: field.string(),
			title: field.string(),
			pinned: field.boolean(),
			rating: nullable(field.number()),
			tags: field.tags(),
			metadata: field.json(
				Type.Object({ source: Type.String(), rank: Type.Number() }),
			),
		},
		{ indexes: [['pinned'], ['rating', 'title']] },
	);
	const definition = defineWorkspace({
		id: 'sqlite-database-test',
		name: 'SQLite database test',
		epoch: 'notes-1',
		tables: { notes },
		kv: {
			theme: defineKv(
				field.select(['light', 'dark']),
				(): 'light' | 'dark' => 'light',
			),
			layout: defineKv(
				field.json(Type.Object({ width: Type.Number() })),
				() => ({ width: 320 }),
			),
		},
	});
	const observerErrors: unknown[] = [];
	const workspace = createApplicationDatabase(definition, sqlite, {
		kind: 'standalone',
		onObserverError: (error) => observerErrors.push(error),
	});
	return { database, definition, observerErrors, sqlite, workspace };
}

describe('typed rows at rest', () => {
	test('put, patch, list, and remove operate on typed SQLite columns', () => {
		const { database, workspace } = setup();
		workspace.tables.notes.put({
			id: 'note-1',
			title: 'First',
			pinned: false,
			rating: null,
			tags: ['one', 'two'],
			metadata: { source: 'local', rank: 2 },
		});
		workspace.tables.notes.put({
			id: 'note-2',
			title: 'Second',
			pinned: true,
			rating: 4.5,
			tags: [],
			metadata: { source: 'remote', rank: 1 },
		});

		expect(workspace.tables.notes.get('note-1')).toEqual({
			id: 'note-1',
			title: 'First',
			pinned: false,
			rating: null,
			tags: ['one', 'two'],
			metadata: { source: 'local', rank: 2 },
		});
		expect(
			workspace.tables.notes.patch('note-1', {
				pinned: true,
				rating: 3,
			}),
		).toMatchObject({ id: 'note-1', pinned: true, rating: 3 });
		expect(
			workspace.tables.notes.list({
				where: { pinned: true },
				orderBy: 'rating',
				desc: true,
				limit: 1,
			}),
		).toEqual([expect.objectContaining({ id: 'note-2' })]);
		expect(workspace.tables.notes.count()).toBe(2);
		expect(workspace.tables.notes.has('note-2')).toBe(true);

		const stored = database
			.query<
				{
					pinned: number;
					tags: string;
					metadata: string;
				},
				[]
			>('SELECT pinned, tags, metadata FROM notes WHERE id = "note-1"')
			.get();
		expect(stored).toEqual({
			pinned: 1,
			tags: '["one","two"]',
			metadata: '{"source":"local","rank":2}',
		});

		workspace.tables.notes.remove('note-1');
		expect(workspace.tables.notes.get('note-1')).toBeNull();
		expect(() =>
			workspace.tables.notes.put({
				id: 'note-1',
				title: 'Reused',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 0 },
			}),
		).toThrow('terminally deleted');
	});

	test('DDL contains one typed column per field, declared indexes, and no row blob or _v', () => {
		const { database } = setup();
		const columns = database
			.query<{ name: string; type: string; notnull: number; pk: number }, []>(
				'PRAGMA table_info("notes")',
			)
			.all();
		expect(
			columns.map(({ name, type, notnull, pk }) => ({
				name,
				type,
				notnull,
				pk,
			})),
		).toEqual([
			{ name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
			{ name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
			{ name: 'pinned', type: 'INTEGER', notnull: 1, pk: 0 },
			{ name: 'rating', type: 'REAL', notnull: 0, pk: 0 },
			{ name: 'tags', type: 'TEXT', notnull: 1, pk: 0 },
			{ name: 'metadata', type: 'TEXT', notnull: 1, pk: 0 },
		]);
		expect(columns.some(({ name }) => name === '_v' || name === 'row')).toBe(
			false,
		);
		const indexes = database
			.query<{ name: string }, []>('PRAGMA index_list("notes")')
			.all()
			.map(({ name }) => name);
		expect(indexes).toContain('__epicenter_idx_notes_0');
		expect(indexes).toContain('__epicenter_idx_notes_1');
	});

	test('writes reject non-finite numbers and non-plain JSON', () => {
		const { workspace } = setup();
		expect(() =>
			workspace.tables.notes.put({
				id: 'nan',
				title: 'NaN',
				pinned: false,
				rating: Number.NaN,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			}),
		).toThrow('schema validation');
		expect(() =>
			workspace.kv.set('layout', { width: Number.POSITIVE_INFINITY }),
		).toThrow('schema validation');
	});

	test('put supports id-only tables and deleting an unknown id records terminal intent', () => {
		const database = new Database(':memory:');
		const workspace = createApplicationDatabase(
			defineWorkspace({
				id: 'id-only-test',
				name: 'ID-only test',
				epoch: 'id-only-1',
				tables: { markers: defineTable({ id: field.string() }) },
			}),
			createSqlite(database),
			{ kind: 'standalone', onObserverError() {} },
		);
		const changed: string[][] = [];
		workspace.tables.markers.observe((ids) => changed.push([...ids]));

		workspace.tables.markers.put({ id: 'present' });
		workspace.tables.markers.put({ id: 'present' });
		expect(workspace.tables.markers.count()).toBe(1);

		workspace.tables.markers.remove('never-existed');
		expect(changed).toEqual([['present'], ['present'], ['never-existed']]);
		expect(() => workspace.tables.markers.put({ id: 'never-existed' })).toThrow(
			'terminally deleted',
		);
	});
});

describe('transaction and invalidation', () => {
	test('table and KV observers fire once after a successful outer commit', () => {
		const { database, workspace } = setup();
		const tableEvents: string[][] = [];
		const kvEvents: string[][] = [];
		const commitEvents: {
			tables: [string, string[]][];
			kv: string[];
		}[] = [];
		let observerSawCommittedRows = false;
		workspace.tables.notes.observe((ids) => {
			tableEvents.push([...ids]);
			observerSawCommittedRows = database.inTransaction === false;
		});
		workspace.kv.observe((keys) => kvEvents.push([...keys]));
		workspace.observe((changes) => {
			commitEvents.push({
				tables: [...changes.tables].map(([table, ids]) => [table, [...ids]]),
				kv: [...changes.kv],
			});
		});

		workspace.transact((tx) => {
			tx.tables.notes.put({
				id: 'one',
				title: 'One',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			});
			tx.tables.notes.put({
				id: 'two',
				title: 'Two',
				pinned: true,
				rating: 2,
				tags: [],
				metadata: { source: 'local', rank: 2 },
			});
			tx.kv.set('theme', 'dark');
			tx.kv.set('layout', { width: 480 });
		});

		expect(tableEvents).toEqual([['one', 'two']]);
		expect(kvEvents).toEqual([['theme', 'layout']]);
		expect(commitEvents).toEqual([
			{
				tables: [['notes', ['one', 'two']]],
				kv: ['theme', 'layout'],
			},
		]);
		expect(observerSawCommittedRows).toBe(true);
	});

	test('a thrown transaction rolls back rows and emits no invalidation', () => {
		const { workspace } = setup();
		let invalidations = 0;
		let commitInvalidations = 0;
		workspace.tables.notes.observe(() => invalidations++);
		workspace.observe(() => commitInvalidations++);

		expect(() =>
			workspace.transact((tx) => {
				tx.tables.notes.put({
					id: 'rolled-back',
					title: 'Nope',
					pinned: false,
					rating: null,
					tags: [],
					metadata: { source: 'local', rank: 0 },
				});
				throw new Error('abort');
			}),
		).toThrow('abort');
		expect(workspace.tables.notes.get('rolled-back')).toBeNull();
		expect(invalidations).toBe(0);
		expect(commitInvalidations).toBe(0);
	});

	test('KV clear restores a fresh declared default and invalidates only changes', () => {
		const { workspace } = setup();
		const events: string[][] = [];
		workspace.kv.observe((keys) => events.push([...keys]));
		workspace.kv.set('layout', { width: 640 });
		expect(workspace.kv.get('layout')).toEqual({ width: 640 });
		workspace.kv.clear('layout');
		expect(workspace.kv.get('layout')).toEqual({ width: 320 });
		workspace.kv.clear('layout');
		expect(events).toEqual([['layout'], ['layout'], ['layout']]);
	});

	test('replica coordinator journals logical intent atomically before invalidation', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const notes = defineTable({ id: field.string(), title: field.string() });
		const definition = defineWorkspace({
			id: 'coordinator-test',
			name: 'Coordinator test',
			epoch: 'coordinator-1',
			tables: { notes },
			kv: {
				theme: defineKv(
					field.select(['light', 'dark']),
					() => 'light' as const,
				),
			},
		});
		let rejectCommit = true;
		const coordinator: ApplicationMutationCoordinator = {
			commit(context, apply) {
				return sqlite.transaction(() => {
					const result = apply();
					sqlite.run('INSERT INTO journal (operations) VALUES (?)', [
						JSON.stringify(context.operations),
					]);
					if (rejectCommit) throw new Error('journal rejected');
					return result;
				});
			},
		};
		const workspace = createApplicationDatabase(definition, sqlite, {
			kind: 'standalone',
			coordinator,
			onObserverError() {},
		});
		database.run(
			'CREATE TABLE journal (sequence INTEGER PRIMARY KEY, operations TEXT NOT NULL)',
		);
		const observations: string[][] = [];
		workspace.tables.notes.observe((ids) => {
			expect(database.inTransaction).toBe(false);
			observations.push([...ids]);
		});

		expect(() =>
			workspace.tables.notes.put({ id: 'rolled-back', title: 'No' }),
		).toThrow('journal rejected');
		expect(workspace.tables.notes.get('rolled-back')).toBeNull();
		expect(database.query('SELECT * FROM journal').all()).toEqual([]);
		expect(observations).toEqual([]);

		rejectCommit = false;
		workspace.tables.notes.put({ id: 'committed', title: 'Yes' });
		workspace.kv.set('theme', 'dark');
		workspace.kv.clear('theme');
		expect(observations).toEqual([['committed']]);
		const operations = database
			.query<{ operations: string }, []>('SELECT operations FROM journal')
			.all()
			.map(({ operations }) => JSON.parse(operations));
		expect(operations).toEqual([
			[
				{
					kind: 'patchRow',
					table: 'notes',
					rowId: 'committed',
					cells: { title: 'Yes' },
				},
			],
			[
				{
					kind: 'patchRow',
					table: '__epicenter_kv',
					rowId: 'theme',
					cells: { value: 'dark' },
				},
			],
			[
				{
					kind: 'patchRow',
					table: '__epicenter_kv',
					rowId: 'theme',
					cells: { value: null },
				},
			],
		]);
	});

	test('caught nested transaction refusal never runs or commits the inner body', () => {
		const { workspace } = setup();
		workspace.transact((tx) => {
			tx.tables.notes.put({
				id: 'outer',
				title: 'Outer',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			});
			try {
				workspace.transact((inner) => {
					inner.tables.notes.put({
						id: 'inner',
						title: 'Inner',
						pinned: false,
						rating: null,
						tags: [],
						metadata: { source: 'local', rank: 2 },
					});
				});
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
			}
		});
		expect(workspace.tables.notes.has('outer')).toBe(true);
		expect(workspace.tables.notes.has('inner')).toBe(false);
	});

	test('observer failures reach the sink without skipping peers or throwing writes', () => {
		const { observerErrors, workspace } = setup();
		let secondObserverCalls = 0;
		workspace.tables.notes.observe(() => {
			throw new Error('observer failed');
		});
		workspace.tables.notes.observe(() => secondObserverCalls++);

		expect(() =>
			workspace.tables.notes.put({
				id: 'observed',
				title: 'Observed',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			}),
		).not.toThrow();
		expect(workspace.tables.notes.has('observed')).toBe(true);
		expect(secondObserverCalls).toBe(1);
		expect(observerErrors).toHaveLength(1);
		expect(observerErrors[0]).toBeInstanceOf(Error);
	});

	test('logical snapshots include live rows, stored KV, and terminal tombstones', () => {
		const { workspace } = setup();
		workspace.tables.notes.put({
			id: 'live',
			title: 'Live',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'local', rank: 1 },
		});
		workspace.tables.notes.remove('gone');
		workspace.kv.set('theme', 'dark');

		expect(workspace.readLogicalSnapshot()).toEqual({
			rows: [
				{
					table: '__epicenter_kv',
					rowId: 'theme',
					deleted: false,
					cells: { value: 'dark' },
				},
				{
					table: 'notes',
					rowId: 'gone',
					deleted: true,
					cells: {},
				},
				{
					table: 'notes',
					rowId: 'live',
					deleted: false,
					cells: {
						title: 'Live',
						pinned: false,
						tags: [],
						metadata: { source: 'local', rank: 1 },
					},
				},
			],
		});
	});

	test('replica projection quarantines incomplete rows and promotes completed rows', () => {
		const { database, workspace } = setup();
		const observations: string[][] = [];
		workspace.tables.notes.observe((ids) => observations.push([...ids]));

		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'remote',
						cells: { title: 'Incomplete' },
					},
				],
				4,
			);
		});
		expect(workspace.tables.notes.get('remote')).toBeNull();
		expect(workspace.readLogicalSnapshot()).toEqual({
			rows: [
				{
					table: 'notes',
					rowId: 'remote',
					deleted: false,
					cells: { title: 'Incomplete' },
				},
			],
		});
		expect(
			database
				.query<{ firstSeenSequence: number }, []>(
					'SELECT first_seen_sequence AS firstSeenSequence FROM __epicenter_quarantine',
				)
				.get(),
		).toEqual({ firstSeenSequence: 4 });
		expect(() =>
			workspace.tables.notes.put({
				id: 'remote',
				title: 'Typed overwrite',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			}),
		).toThrow('quarantined row');

		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'remote',
						cells: {
							pinned: false,
							tags: [],
							metadata: { source: 'remote', rank: 1 },
						},
					},
				],
				5,
			);
		});
		expect(workspace.tables.notes.get('remote')).toEqual({
			id: 'remote',
			title: 'Incomplete',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'remote', rank: 1 },
		});
		expect(
			database.query('SELECT * FROM __epicenter_quarantine').all(),
		).toEqual([]);
		expect(observations).toEqual([['remote'], ['remote']]);
	});

	test('typed removal terminally retires a quarantined identity', () => {
		const { database, workspace } = setup();
		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'hidden',
						cells: { unknown: true },
					},
				],
				1,
			);
		});

		workspace.tables.notes.remove('hidden');

		expect(
			database.query('SELECT * FROM __epicenter_quarantine').all(),
		).toEqual([]);
		expect(workspace.readLogicalSnapshot().rows).toEqual([
			{ table: 'notes', rowId: 'hidden', deleted: true, cells: {} },
		]);
	});

	test('replica projection preserves terminal deletion and replaces snapshots atomically', () => {
		const { workspace } = setup();
		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{ kind: 'deleteRow', table: 'notes', rowId: 'gone' },
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'gone',
						cells: { title: 'Too late' },
					},
				],
				2,
			);
		});
		expect(workspace.tables.notes.get('gone')).toBeNull();
		expect(workspace.readLogicalSnapshot().rows).toEqual([
			{ table: 'notes', rowId: 'gone', deleted: true, cells: {} },
		]);

		expect(() =>
			workspace.applyReplicaTransaction((projection) => {
				projection.replace(
					[
						{
							table: 'notes',
							rowId: 'snapshot',
							deleted: false,
							cells: {
								title: 'Snapshot',
								pinned: true,
								tags: [],
								metadata: { source: 'remote', rank: 2 },
							},
						},
					],
					10,
				);
				throw new Error('crash before commit');
			}),
		).toThrow('crash before commit');
		expect(workspace.readLogicalSnapshot().rows).toEqual([
			{ table: 'notes', rowId: 'gone', deleted: true, cells: {} },
		]);

		workspace.applyReplicaTransaction((projection) => {
			projection.replace(
				[
					{
						table: 'notes',
						rowId: 'snapshot',
						deleted: false,
						cells: {
							title: 'Snapshot',
							pinned: true,
							tags: [],
							metadata: { source: 'remote', rank: 2 },
						},
					},
				],
				10,
			);
		});
		expect(workspace.tables.notes.get('snapshot')).toEqual({
			id: 'snapshot',
			title: 'Snapshot',
			pinned: true,
			rating: null,
			tags: [],
			metadata: { source: 'remote', rank: 2 },
		});
	});
});

describe('representation migrations', () => {
	test('identity inspection and fresh stamping share one immediate transaction', () => {
		const database = new Database(':memory:');
		const base = createSqlite(database);
		let inspectionWasTransactional = false;
		const sqlite: RecordSyncSqlite = {
			...base,
			all(sql, parameters) {
				if (sql.includes('sqlite_master')) {
					inspectionWasTransactional = database.inTransaction;
				}
				return base.all(sql, parameters);
			},
		};
		createApplicationDatabase(
			defineWorkspace({
				id: 'atomic-identity-test',
				name: 'Atomic identity test',
				epoch: 'atomic-identity-v1',
				tables: { rows: defineTable({ id: field.string() }) },
			}),
			sqlite,
			{ kind: 'standalone', onObserverError() {} },
		);

		expect(inspectionWasTransactional).toBe(true);
	});

	test('existing databases run missing apply steps and persist the new revision', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const v1Table = defineTable({
			id: field.string(),
			title: field.string(),
		});
		const v1 = defineWorkspace({
			id: 'migration-test',
			name: 'Migration test',
			epoch: 'migration-1',
			tables: { notes: v1Table },
		});
		const old = createApplicationDatabase(v1, sqlite, {
			kind: 'standalone',
			onObserverError() {},
		});
		old.tables.notes.put({ id: 'one', title: 'Before' });

		let applyCalls = 0;
		const v2 = defineWorkspace({
			id: 'migration-test',
			name: 'Migration test',
			epoch: 'migration-1',
			tables: { notes: v1Table },
			migrations: [
				{
					apply(tx) {
						applyCalls++;
						tx.sql('CREATE INDEX notes_title_physical ON notes(title)');
					},
				},
			],
		});
		const current = createApplicationDatabase(v2, sqlite, {
			kind: 'standalone',
			onObserverError() {},
		});
		expect(applyCalls).toBe(1);
		expect(current.tables.notes.get('one')).toEqual({
			id: 'one',
			title: 'Before',
		});
		expect(
			database
				.query<{ value: string }, []>(
					"SELECT value FROM __epicenter_meta WHERE key = 'storage_revision'",
				)
				.get()?.value,
		).toBe('2');
	});

	test('fresh databases start at the current revision without replaying migrations', () => {
		const database = new Database(':memory:');
		let applyCalls = 0;
		const definition = defineWorkspace({
			id: 'fresh-current',
			name: 'Fresh current',
			epoch: 'fresh-1',
			tables: {
				notes: defineTable({ id: field.string(), title: field.string() }),
			},
			migrations: [
				{
					apply() {
						applyCalls++;
					},
				},
			],
		});
		createApplicationDatabase(definition, createSqlite(database), {
			kind: 'standalone',
			onObserverError() {},
		});
		expect(applyCalls).toBe(0);
	});

	test('opening with an older definition refuses a stored newer revision', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const table = defineTable({ id: field.string(), title: field.string() });
		const current = defineWorkspace({
			id: 'downgrade-test',
			name: 'Downgrade test',
			epoch: 'downgrade-1',
			tables: { notes: table },
			migrations: [{ apply() {} }],
		});
		createApplicationDatabase(current, sqlite, {
			kind: 'standalone',
			onObserverError() {},
		});

		const old = defineWorkspace({
			id: 'downgrade-test',
			name: 'Downgrade test',
			epoch: 'downgrade-1',
			tables: { notes: table },
		});
		expect(() =>
			createApplicationDatabase(old, sqlite, {
				kind: 'standalone',
				onObserverError() {},
			}),
		).toThrow('database revision 2 is newer');
	});

	test('same-revision workspace and schema mismatches refuse typed access', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const notes = defineTable({ id: field.string(), title: field.string() });
		const original = createApplicationDatabase(
			defineWorkspace({
				id: 'identity-test',
				name: 'Identity test',
				epoch: 'identity-1',
				tables: { notes },
			}),
			sqlite,
			{ kind: 'standalone', onObserverError() {} },
		);
		original.tables.notes.put({ id: 'kept', title: 'Kept' });
		const readPhysicalState = () => ({
			schema: database
				.query<
					{ type: string; name: string; table: string; sql: string | null },
					[]
				>(
					'SELECT type, name, tbl_name AS "table", sql FROM sqlite_master ORDER BY type, name',
				)
				.all(),
			notes: database.query('SELECT * FROM notes ORDER BY id').all(),
			meta: database.query('SELECT * FROM __epicenter_meta ORDER BY key').all(),
		});
		const beforeRefusals = readPhysicalState();

		expect(() =>
			createApplicationDatabase(
				defineWorkspace({
					id: 'other-workspace',
					name: 'Other workspace',
					epoch: 'identity-1',
					tables: { notes },
				}),
				sqlite,
				{ kind: 'standalone', onObserverError() {} },
			),
		).toThrow("belongs to 'identity-test'");

		const nullableColumnAdded = defineTable({
			id: field.string(),
			title: field.string(),
			summary: nullable(field.string()),
		});
		expect(() =>
			createApplicationDatabase(
				defineWorkspace({
					id: 'identity-test',
					name: 'Identity test',
					epoch: 'identity-1',
					tables: { notes: nullableColumnAdded },
				}),
				sqlite,
				{ kind: 'standalone', onObserverError() {} },
			),
		).toThrow('schema identity does not match');
		expect(readPhysicalState()).toEqual(beforeRefusals);
	});

	test('database kind permanently fences standalone and replica lifecycle doors', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const definition = defineWorkspace({
			id: 'kind-test',
			name: 'Kind test',
			epoch: 'kind-v1',
			tables: { rows: defineTable({ id: field.string() }) },
		});
		createApplicationDatabase(definition, sqlite, {
			kind: 'standalone',
			onObserverError() {},
		});

		expect(() =>
			createApplicationDatabase(definition, sqlite, {
				kind: 'replica',
				onObserverError() {},
			}),
		).toThrow("database is 'standalone', not 'replica'");
	});

	test('missing epoch migrations require the explicit epoch-upgrade flow', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const notes = defineTable({ id: field.string(), title: field.string() });
		const v1 = defineWorkspace({
			id: 'epoch-test',
			name: 'Epoch test',
			epoch: 'epoch-1',
			tables: { notes },
		});
		createApplicationDatabase(v1, sqlite, {
			kind: 'standalone',
			onObserverError() {},
		});

		const v2 = defineWorkspace({
			id: 'epoch-test',
			name: 'Epoch test',
			epoch: 'epoch-1',
			tables: { notes },
			migrations: [{ epoch: { id: 'epoch-2' } }],
		});
		expect(() =>
			createApplicationDatabase(v2, sqlite, {
				kind: 'standalone',
				onObserverError() {},
			}),
		).toThrow('changes schema epoch');
	});
});
