/**
 * SQLite Mirror Factory Tests
 *
 * Tests the full createSqliteMirror lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and lifecycle hooks. Uses real
 * Yjs documents with defineTable schemas so the mirror exercises the actual
 * workspace observation path.
 *
 * Key behaviors:
 * - Mirror waits for workspace whenReady before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all mirrored data
 * - onReady fires after initial load completes
 * - onSync fires after each sync cycle with change details
 * - dispose() stops observers and clears timeouts
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { createWorkspace, defineTable } from '../../../workspace/index.js';
import { createSqliteMirror } from './create-sqlite-mirror.js';
import type { MirrorDatabase, MirrorStatement, SyncChange } from './types.js';

const postsTable = defineTable(
	type({ id: 'string', _v: '1', title: 'string', 'published?': 'boolean' }),
);

const notesTable = defineTable(type({ id: 'string', _v: '1', body: 'string' }));

const hasFts5 = canUseFts5();

type TestDb = MirrorDatabase & {
	raw: Database;
	sqlCalls: string[];
	close(): void;
};

type SetupOptions = {
	tables?: 'all' | string[];
	fts?: Record<string, string[]>;
	onReady?: (db: MirrorDatabase) => void | Promise<void>;
	onSync?: (db: MirrorDatabase, changes: SyncChange[]) => void | Promise<void>;
	debounceMs?: number;
};

function createTestDb(): TestDb {
	const raw = new Database(':memory:');
	const sqlCalls: string[] = [];

	return {
		raw,
		sqlCalls,
		close() {
			raw.close();
		},
		async exec(sql: string) {
			sqlCalls.push(sql);
			raw.run(sql);
		},
		prepare(sql: string) {
			sqlCalls.push(sql);
			const statement = raw.prepare(sql);

			return {
				async run(...params: unknown[]) {
					statement.run(...params);
				},
				async all(...params: unknown[]) {
					return statement.all(...params) as Record<string, unknown>[];
				},
				async get(...params: unknown[]) {
					return (
						(statement.get(...params) as Record<string, unknown> | null) ??
						undefined
					);
				},
			} satisfies MirrorStatement;
		},
	};
}

function setup(options: SetupOptions = {}) {
	const db = createTestDb();
	const workspace = createWorkspace({
		id: 'test',
		tables: { posts: postsTable, notes: notesTable },
	}).withWorkspaceExtension(
		'sqlite',
		createSqliteMirror({
			db,
			tables: options.tables,
			fts: options.fts,
			onReady: options.onReady,
			onSync: options.onSync,
			debounceMs: options.debounceMs,
		}),
	);

	return { db, workspace };
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}

function canUseFts5() {
	const raw = new Database(':memory:');

	try {
		raw.run('CREATE VIRTUAL TABLE test_fts USING fts5(title)');
		return true;
	} catch {
		return false;
	} finally {
		raw.close();
	}
}

async function waitForSyncCycle() {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

async function getRows(db: TestDb, tableName: string) {
	const rows = await db
		.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`)
		.all();

	return rows;
}

async function hasTable(db: TestDb, tableName: string) {
	const row = await db
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);

	return row !== undefined;
}

async function cleanup(setupResult: ReturnType<typeof setup>) {
	await setupResult.workspace.dispose();
	setupResult.db.close();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('createSqliteMirror', () => {
	describe('readiness', () => {
		test('waits for workspace whenReady before touching SQLite', async () => {
			const db = createTestDb();
			const gate = createDeferred();
			const workspace = createWorkspace({
				id: 'ready-gated',
				tables: { posts: postsTable, notes: notesTable },
			})
				.withWorkspaceExtension('gate', () => ({ whenReady: gate.promise }))
				.withWorkspaceExtension('sqlite', createSqliteMirror({ db }));

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(db.sqlCalls).toHaveLength(0);

				gate.resolve();
				await workspace.extensions.sqlite.whenReady;

				expect(db.sqlCalls.length).toBeGreaterThan(0);
				expect(await hasTable(db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				await workspace.dispose();
				db.close();
			}
		});
	});

	// ============================================================================
	// FULL LOAD Tests
	// ============================================================================

	describe('full load', () => {
		test('mirrors existing rows on initialization', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Hello mirror',
					published: true,
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Hello mirror' },
					{ id: 'post-2', _v: 1, published: null, title: 'Second row' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is an array', async () => {
			const testSetup = setup({ tables: ['posts'] });

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(await hasTable(testSetup.db, 'posts')).toBe(true);
				expect(await hasTable(testSetup.db, 'notes')).toBe(false);
				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Mirrored post' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// INCREMENTAL SYNC Tests
	// ============================================================================

	describe('incremental sync', () => {
		test('upserts rows added after initialization', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
					_v: 1,
				});

				await waitForSyncCycle();

				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Added later' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(await getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.workspace.tables.posts.update('post-1', {
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 0, title: 'After update' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// REBUILD Tests
	// ============================================================================

	describe('rebuild', () => {
		test('rebuild repopulates SQLite from Yjs', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Persisted in Yjs',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				await testSetup.db.exec('DELETE FROM "posts"');

				expect(await getRows(testSetup.db, 'posts')).toEqual([]);

				await testSetup.workspace.extensions.sqlite.rebuild();

				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	describe('rebuildTable', () => {
		test('rebuildTable repopulates a single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				await testSetup.db.exec('DELETE FROM "posts"');

				expect(await getRows(testSetup.db, 'posts')).toEqual([]);
				expect(await getRows(testSetup.db, 'notes')).toHaveLength(1);

				await testSetup.workspace.extensions.sqlite.rebuildTable('posts');

				expect(await getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Post row' },
				]);
				expect(await getRows(testSetup.db, 'notes')).toHaveLength(1);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuildTable throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(
					testSetup.workspace.extensions.sqlite.rebuildTable('nonexistent'),
				).rejects.toThrow('not in the mirrored table set');
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	describe('count', () => {
		test('count returns row count for a mirrored table', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'First',
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(await testSetup.workspace.extensions.sqlite.count('posts')).toBe(
					2,
				);
				expect(await testSetup.workspace.extensions.sqlite.count('notes')).toBe(
					0,
				);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('count returns 0 for non-existent table', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(
					await testSetup.workspace.extensions.sqlite.count('nonexistent'),
				).toBe(0);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// LIFECYCLE Tests
	// ============================================================================

	describe('lifecycle hooks', () => {
		test('onReady fires after initial load', async () => {
			const readySnapshots: number[] = [];
			const testSetup = setup({
				onReady: async (db) => {
					const row = await db
						.prepare('SELECT COUNT(*) AS count FROM posts')
						.get();
					readySnapshots.push(Number(row?.count ?? 0));
				},
			});

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Ready row',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(readySnapshots).toEqual([1]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('onSync fires after incremental sync with change details', async () => {
			const syncCalls: SyncChange[][] = [];
			const testSetup = setup({
				onSync: (_db, changes) => {
					syncCalls.push(changes);
				},
			});

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Synced row',
					_v: 1,
				});

				await waitForSyncCycle();

				expect(syncCalls).toEqual([
					[
						{
							table: 'posts',
							upserted: ['post-1'],
							deleted: [],
						},
					],
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose cancels queued sync and ignores later writes', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Queued row',
					_v: 1,
				});
				testSetup.workspace.extensions.sqlite.dispose();

				await waitForSyncCycle();

				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Ignored row',
					_v: 1,
				});

				await waitForSyncCycle();

				expect(await getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('search returns empty array when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(
					await testSetup.workspace.extensions.sqlite.search('posts', 'hello'),
				).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({ fts: { posts: ['title'] } });

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						_v: 1,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						_v: 1,
					});

					await testSetup.workspace.extensions.sqlite.whenReady;

					const results = await testSetup.workspace.extensions.sqlite.search(
						'posts',
						'mirror',
						{ snippetColumn: 'title', limit: 10 },
					);

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});
});
