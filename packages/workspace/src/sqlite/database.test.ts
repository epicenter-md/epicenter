/**
 * Typed SQLite Application Database Tests
 *
 * Verifies that workspace rows are stored as typed SQLite columns behind one
 * post-commit invalidation boundary. The record database is table-only:
 * declared KV lives on the eager root document (ADR-0124) and never appears
 * here.
 *
 * Key behaviors:
 * - CRUD uses typed columns, declared indexes, codecs, and physical deletion
 * - mutations record three-verb logical operations (create/update/delete row)
 * - successful transactions invalidate once after commit; rollback is silent
 * - representation migrations advance one persisted storage revision
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { Operation, RecordSyncSqlite } from '@epicenter/record-sync';
import { Type } from 'typebox';
import { nullable } from '../document/nullable.js';
import {
	type ApplicationMutationCoordinator,
	createApplicationDatabase,
	ReplicaInvariantViolationError,
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
	// Declared KV rides along on the definition but is invisible to the
	// record database: it belongs to the root-document preference plane.
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
	test('create, patch, list, and remove operate on typed SQLite columns', () => {
		const { database, workspace } = setup();
		workspace.tables.notes.create({
			id: 'note-1',
			title: 'First',
			pinned: false,
			rating: null,
			tags: ['one', 'two'],
			metadata: { source: 'local', rank: 2 },
		});
		workspace.tables.notes.create({
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
		expect(workspace.tables.notes.patch('missing', { title: 'No' })).toBeNull();
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

		// A live id may not be created again: row ids have one lifetime.
		expect(() =>
			workspace.tables.notes.create({
				id: 'note-2',
				title: 'Duplicate',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 0 },
			}),
		).toThrow('row ids have one lifetime');

		workspace.tables.notes.remove('note-1');
		expect(workspace.tables.notes.get('note-1')).toBeNull();
		// Deletion is physical absence. One-lifetime ids are a caller contract
		// backstopped by the authority, not a local tombstone guard, so a
		// removed id can be created again locally.
		workspace.tables.notes.create({
			id: 'note-1',
			title: 'Recreated',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'local', rank: 0 },
		});
		expect(workspace.tables.notes.get('note-1')).toMatchObject({
			id: 'note-1',
			title: 'Recreated',
		});
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
			workspace.tables.notes.create({
				id: 'nan',
				title: 'NaN',
				pinned: false,
				rating: Number.NaN,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			}),
		).toThrow('schema validation');
	});

	test('create supports id-only tables and removing an absent id is a silent no-op', () => {
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

		workspace.tables.markers.create({ id: 'present' });
		expect(() => workspace.tables.markers.create({ id: 'present' })).toThrow(
			'row ids have one lifetime',
		);
		expect(workspace.tables.markers.count()).toBe(1);

		// Removing an id that never existed changes nothing and notifies no one.
		workspace.tables.markers.remove('never-existed');
		expect(changed).toEqual([['present']]);
		workspace.tables.markers.create({ id: 'never-existed' });
		expect(changed).toEqual([['present'], ['never-existed']]);
		expect(workspace.tables.markers.count()).toBe(2);
	});
});

describe('transaction and invalidation', () => {
	test('table observers fire once after a successful outer commit', () => {
		const { database, workspace } = setup();
		const tableEvents: string[][] = [];
		const commitEvents: {
			tables: [string, string[]][];
		}[] = [];
		let observerSawCommittedRows = false;
		workspace.tables.notes.observe((ids) => {
			tableEvents.push([...ids]);
			observerSawCommittedRows = database.inTransaction === false;
		});
		workspace.observe((changes) => {
			commitEvents.push({
				tables: [...changes.tables].map(([table, ids]) => [table, [...ids]]),
			});
		});

		workspace.transact((tx) => {
			tx.tables.notes.create({
				id: 'one',
				title: 'One',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			});
			tx.tables.notes.create({
				id: 'two',
				title: 'Two',
				pinned: true,
				rating: 2,
				tags: [],
				metadata: { source: 'local', rank: 2 },
			});
		});

		expect(tableEvents).toEqual([['one', 'two']]);
		expect(commitEvents).toEqual([
			{
				tables: [['notes', ['one', 'two']]],
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
				tx.tables.notes.create({
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

	test('replica coordinator journals logical intent atomically before invalidation', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const notes = defineTable({ id: field.string(), title: field.string() });
		const definition = defineWorkspace({
			id: 'coordinator-test',
			name: 'Coordinator test',
			epoch: 'coordinator-1',
			tables: { notes },
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
			workspace.tables.notes.create({ id: 'rolled-back', title: 'No' }),
		).toThrow('journal rejected');
		expect(workspace.tables.notes.get('rolled-back')).toBeNull();
		expect(database.query('SELECT * FROM journal').all()).toEqual([]);
		expect(observations).toEqual([]);

		rejectCommit = false;
		workspace.tables.notes.create({ id: 'committed', title: 'Yes' });
		expect(observations).toEqual([['committed']]);
		const operations = database
			.query<{ operations: string }, []>('SELECT operations FROM journal')
			.all()
			.map(({ operations }) => JSON.parse(operations));
		expect(operations).toEqual([
			[
				{
					kind: 'createRow',
					table: 'notes',
					rowId: 'committed',
					cells: { title: 'Yes' },
				},
			],
		]);
	});

	test('recorded operations use the three verbs, omit id and null cells, and skip absent removals', () => {
		const database = new Database(':memory:');
		const sqlite = createSqlite(database);
		const definition = defineWorkspace({
			id: 'operations-test',
			name: 'Operations test',
			epoch: 'operations-1',
			tables: {
				notes: defineTable({
					id: field.string(),
					title: field.string(),
					rating: nullable(field.number()),
				}),
			},
		});
		const committedOperations: unknown[] = [];
		const coordinator: ApplicationMutationCoordinator = {
			commit(context, apply) {
				return sqlite.transaction(() => {
					const result = apply();
					committedOperations.push(structuredClone([...context.operations]));
					return result;
				});
			},
		};
		const workspace = createApplicationDatabase(definition, sqlite, {
			kind: 'standalone',
			coordinator,
			onObserverError() {},
		});

		workspace.tables.notes.create({ id: 'n1', title: 'One', rating: null });
		workspace.tables.notes.patch('n1', { rating: 3 });
		workspace.tables.notes.remove('n1');
		// The row is already gone: nothing existed, so nothing is recorded.
		workspace.tables.notes.remove('n1');

		expect(committedOperations).toEqual([
			[{ kind: 'createRow', table: 'notes', rowId: 'n1', cells: { title: 'One' } }],
			[{ kind: 'updateRow', table: 'notes', rowId: 'n1', cells: { rating: 3 } }],
			[{ kind: 'deleteRow', table: 'notes', rowId: 'n1' }],
			[],
		]);
	});

	test('caught nested transaction refusal never runs or commits the inner body', () => {
		const { workspace } = setup();
		workspace.transact((tx) => {
			tx.tables.notes.create({
				id: 'outer',
				title: 'Outer',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			});
			try {
				workspace.transact((inner) => {
					inner.tables.notes.create({
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
			workspace.tables.notes.create({
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

	test('logical snapshots carry live rows only: deletion is absence, not a record', () => {
		const { database, workspace } = setup();
		workspace.tables.notes.create({
			id: 'live',
			title: 'Live',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'local', rank: 1 },
		});
		workspace.tables.notes.create({
			id: 'gone',
			title: 'Gone',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'local', rank: 2 },
		});
		workspace.tables.notes.remove('gone');
		workspace.tables.notes.remove('never-existed');

		expect(workspace.readLogicalSnapshot()).toEqual({
			rows: [
				{
					table: 'notes',
					rowId: 'live',
					cells: {
						title: 'Live',
						pinned: false,
						tags: [],
						metadata: { source: 'local', rank: 1 },
					},
				},
			],
		});
		// There is no tombstone table: absence is the only deleted state.
		expect(
			database
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__epicenter_tombstones'",
				)
				.all(),
		).toEqual([]);
	});

	test('replica projection quarantines incomplete rows and promotes completed rows', () => {
		const { database, workspace } = setup();
		const observations: string[][] = [];
		workspace.tables.notes.observe((ids) => observations.push([...ids]));

		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'createRow',
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
			workspace.tables.notes.create({
				id: 'remote',
				title: 'Typed overwrite',
				pinned: false,
				rating: null,
				tags: [],
				metadata: { source: 'local', rank: 1 },
			}),
		).toThrow('row ids have one lifetime');

		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'updateRow',
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

	test('typed removal physically deletes a quarantined identity', () => {
		const { database, workspace } = setup();
		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'createRow',
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
		expect(workspace.readLogicalSnapshot().rows).toEqual([]);
	});

	test('updateRow and deleteRow on absent rows are silent no-ops that never resurrect', () => {
		const { workspace } = setup();
		const observations: string[][] = [];
		workspace.tables.notes.observe((ids) => observations.push([...ids]));

		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{ kind: 'deleteRow', table: 'notes', rowId: 'missing' },
					{
						kind: 'updateRow',
						table: 'notes',
						rowId: 'missing',
						cells: { title: 'Too late' },
					},
				],
				2,
			);
		});

		expect(workspace.tables.notes.get('missing')).toBeNull();
		expect(workspace.readLogicalSnapshot().rows).toEqual([]);
		expect(observations).toEqual([]);
	});

	test('an accepted createRow onto a live row is a replica invariant violation', () => {
		const { workspace } = setup();
		const createDup: Operation = {
			kind: 'createRow',
			table: 'notes',
			rowId: 'dup',
			cells: {
				title: 'Dup',
				pinned: false,
				tags: [],
				metadata: { source: 'remote', rank: 1 },
			},
		};
		workspace.applyReplicaTransaction((projection) => {
			projection.apply([createDup], 1);
		});
		expect(workspace.tables.notes.has('dup')).toBe(true);

		expect(() =>
			workspace.applyReplicaTransaction((projection) => {
				projection.apply([createDup], 2);
			}),
		).toThrow(ReplicaInvariantViolationError);
		expect(workspace.tables.notes.get('dup')).toMatchObject({
			id: 'dup',
			title: 'Dup',
		});
	});

	test('retract removes optimistic typed and quarantined rows before a page folds', () => {
		const { database, workspace } = setup();
		workspace.applyReplicaTransaction((projection) => {
			projection.apply(
				[
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'typed',
						cells: {
							title: 'Typed',
							pinned: false,
							tags: [],
							metadata: { source: 'local', rank: 1 },
						},
					},
					{
						kind: 'createRow',
						table: 'notes',
						rowId: 'quarantined',
						cells: { title: 'Partial' },
					},
				],
				1,
			);
		});
		expect(workspace.tables.notes.has('typed')).toBe(true);
		expect(
			database.query('SELECT * FROM __epicenter_quarantine').all(),
		).toHaveLength(1);

		workspace.applyReplicaTransaction((projection) => {
			projection.retract([
				{ table: 'notes', rowId: 'typed' },
				{ table: 'notes', rowId: 'quarantined' },
			]);
		});

		expect(workspace.tables.notes.has('typed')).toBe(false);
		expect(
			database.query('SELECT * FROM __epicenter_quarantine').all(),
		).toEqual([]);
		expect(workspace.readLogicalSnapshot().rows).toEqual([]);
	});

	test('replica projection replaces snapshots atomically', () => {
		const { workspace } = setup();
		workspace.tables.notes.create({
			id: 'existing',
			title: 'Existing',
			pinned: false,
			rating: null,
			tags: [],
			metadata: { source: 'local', rank: 1 },
		});

		expect(() =>
			workspace.applyReplicaTransaction((projection) => {
				projection.replace(
					[
						{
							table: 'notes',
							rowId: 'snapshot',
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
		expect(workspace.tables.notes.get('existing')).toMatchObject({
			id: 'existing',
			title: 'Existing',
		});
		expect(workspace.tables.notes.has('snapshot')).toBe(false);

		workspace.applyReplicaTransaction((projection) => {
			projection.replace(
				[
					{
						table: 'notes',
						rowId: 'snapshot',
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
		expect(workspace.tables.notes.has('existing')).toBe(false);
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
		old.tables.notes.create({ id: 'one', title: 'Before' });

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
		original.tables.notes.create({ id: 'kept', title: 'Kept' });
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
