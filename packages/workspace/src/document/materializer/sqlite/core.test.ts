/**
 * SQLite Materializer Tests
 *
 * Tests the full attachSqliteMaterializerCore lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and dispose. Uses real Yjs documents
 * with defineTable schemas so the materializer exercises the actual workspace
 * observation path.
 *
 * Key behaviors:
 * - Materializer waits for `whenReady` before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all materialized data
 * - dispose() stops observers and clears timeouts
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	createDisposableCache,
	createWorkspace,
	defineTable,
	type Tables,
} from '../../../index.js';
import { isAction, isMutation, isQuery } from '../../../shared/actions.js';
import { field } from '@epicenter/field';
import { nullable } from '../../nullable.js';
import { attachSqliteMaterializerCore } from './core.js';

const postsTable = defineTable({
	id: field.string(),
	title: field.string(),
	published: nullable(field.boolean()),
});

const notesTable = defineTable({
	id: field.string(),
	body: field.string(),
});

const tableDefinitions = { posts: postsTable, notes: notesTable };

const hasFts5 = canUseFts5();

function createTestDb() {
	return new Database(':memory:');
}

type AttachedTables = Tables<typeof tableDefinitions>;

type SetupBuildResult = {
	// biome-ignore lint/suspicious/noExplicitAny: tests build heterogeneous subsets
	tables: Record<string, any>;
	fts?: Record<string, string[]>;
};

type SetupOptions = {
	build?: (t: AttachedTables) => SetupBuildResult;
	debounceMs?: number;
};

function setup({ build, debounceMs }: SetupOptions = {}) {
	const db = createTestDb();

	const cache = createDisposableCache(
		(id: string) => {
			const workspace = createWorkspace({
				id,
				tables: tableDefinitions,
				kv: {},
			});

			const built: SetupBuildResult = build?.(workspace.tables) ?? {
				tables: {
					posts: workspace.tables.posts,
					notes: workspace.tables.notes,
				},
			};

			const materializer = attachSqliteMaterializerCore(workspace.ydoc, {
				db,
				debounceMs,
				tables: built.tables,
				// biome-ignore lint/suspicious/noExplicitAny: tests erase row types through the setup helper
				fts: built.fts as any,
			});

			return {
				ydoc: workspace.ydoc,
				tables: workspace.tables,
				sqlite: materializer,
				[Symbol.dispose]() {
					workspace[Symbol.dispose]();
				},
			};
		},
		{ gcTime: 0 },
	);

	const workspace = cache.open('test');
	return { db, workspace, cache };
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

function getRows(db: Database, tableName: string) {
	return db
		.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`)
		.all() as Record<string, unknown>[];
}

function hasTable(db: Database, tableName: string) {
	const row = db
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);
	return row != null;
}

async function disposeAndYieldForClose(setupResult: ReturnType<typeof setup>) {
	setupResult.workspace[Symbol.dispose]();
	// In settled cleanup paths, disposal schedules close on the next microtask.
	await Promise.resolve();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('attachSqliteMaterializerCore', () => {
	describe('readiness', () => {
		test('waits for whenReady before touching SQLite', async () => {
			const db = createTestDb();
			const gate = createDeferred();

			const cache = createDisposableCache(
				(id: string) => {
					const workspace = createWorkspace({
						id,
						tables: tableDefinitions,
						kv: {},
					});

					const materializer = attachSqliteMaterializerCore(workspace.ydoc, {
						db,
						waitFor: gate.promise,
						tables: {
							posts: workspace.tables.posts,
							notes: workspace.tables.notes,
						},
					});

					return {
						ydoc: workspace.ydoc,
						tables: workspace.tables,
						sqlite: materializer,
						[Symbol.dispose]() {
							workspace[Symbol.dispose]();
						},
					};
				},
				{ gcTime: 0 },
			);

			const workspace = cache.open('ready-gated');

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(hasTable(db, 'posts')).toBe(false);

				gate.resolve();
				await workspace.sqlite.whenFlushed;

				expect(hasTable(db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				workspace[Symbol.dispose]();
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
					published: null,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Hello mirror' },
					{ id: 'post-2', published: 1, title: 'Second row' },
				]);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is provided', async () => {
			const testSetup = setup({
				build: (t) => ({ tables: { posts: t.posts } }),
			});

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(hasTable(testSetup.db, 'posts')).toBe(true);
				expect(hasTable(testSetup.db, 'notes')).toBe(false);
				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Mirrored post' },
				]);
			} finally {
				await disposeAndYieldForClose(testSetup);
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
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 1, title: 'Added later' },
				]);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.update('post-1', {
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 0, title: 'After update' },
				]);
			} finally {
				await disposeAndYieldForClose(testSetup);
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
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);

				await testSetup.workspace.sqlite.actions.sqlite_rebuild({});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		test('rebuild single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);

				await testSetup.workspace.sqlite.actions.sqlite_rebuild({
					table: 'posts',
				});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Post row' },
				]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		test('rebuild throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				expect(() =>
					testSetup.workspace.sqlite.actions.sqlite_rebuild({
						table: 'nonexistent',
					}),
				).toThrow('not in the materialized table set');
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose cancels queued sync and ignores later writes', async () => {
			const testSetup = setup();
			const originalClose = testSetup.db.close.bind(testSetup.db);
			testSetup.db.close = () => {};

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Queued row',
					published: null,
				});
				testSetup.workspace[Symbol.dispose]();

				await waitForSyncCycle();

				// The ydoc is destroyed, so further writes to tables are no-ops
				// as far as materialization is concerned; the observer has been
				// unsubscribed via materializer dispose.
				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				originalClose();
			}
		});

		test('closes SQLite after an in-flight incremental sync', async () => {
			const insertStarted = createDeferred();
			const allowInsert = createDeferred();
			const closed = createDeferred();
			const testSetup = setup({ debounceMs: 0 });
			const originalPrepare = testSetup.db.prepare.bind(testSetup.db);
			const originalClose = testSetup.db.close.bind(testSetup.db);
			let insertRunCompleted = false;
			let closeCalled = false;

			testSetup.db.prepare = ((sql: string, params?: SQLQueryBindings) => {
				const statement = originalPrepare(sql, params);
				if (!sql.startsWith('INSERT INTO "posts"')) return statement;

				return {
					async run(...params: SQLQueryBindings[]) {
						insertStarted.resolve();
						await allowInsert.promise;
						// biome-ignore lint/suspicious/noExplicitAny: Bun's generic statement type cannot express this wrapper
						const result = (statement.run as any)(...params);
						insertRunCompleted = true;
						return result;
					},
					all: statement.all.bind(statement),
					get: statement.get.bind(statement),
				};
			}) as typeof testSetup.db.prepare;
			testSetup.db.close = () => {
				closeCalled = true;
				closed.resolve();
				originalClose();
			};

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'In-flight row',
					published: null,
				});
				await insertStarted.promise;

				testSetup.workspace[Symbol.dispose]();
				await Promise.resolve();

				expect(closeCalled).toBe(false);
				expect(insertRunCompleted).toBe(false);

				allowInsert.resolve();
				await closed.promise;

				expect(closeCalled).toBe(true);
				expect(insertRunCompleted).toBe(true);
			} finally {
				if (!closeCalled) testSetup.db.close();
			}
		});

		test('closes SQLite after an in-flight rebuild', async () => {
			const insertStarted = createDeferred();
			const allowInsert = createDeferred();
			const closed = createDeferred();
			const testSetup = setup({ debounceMs: 0 });
			const originalPrepare = testSetup.db.prepare.bind(testSetup.db);
			const originalClose = testSetup.db.close.bind(testSetup.db);
			let insertRunCompleted = false;
			let closeCalled = false;

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Rebuilt row',
					published: null,
				});
				await waitForSyncCycle();

				testSetup.db.prepare = ((sql: string, params?: SQLQueryBindings) => {
					const statement = originalPrepare(sql, params);
					if (!sql.startsWith('INSERT INTO "posts"')) return statement;

					return {
						async run(...params: SQLQueryBindings[]) {
							insertStarted.resolve();
							await allowInsert.promise;
							// biome-ignore lint/suspicious/noExplicitAny: Bun's generic statement type cannot express this wrapper
							const result = (statement.run as any)(...params);
							insertRunCompleted = true;
							return result;
						},
						all: statement.all.bind(statement),
						get: statement.get.bind(statement),
					};
				}) as typeof testSetup.db.prepare;
				testSetup.db.close = () => {
					closeCalled = true;
					closed.resolve();
					originalClose();
				};

				const rebuild = testSetup.workspace.sqlite.actions.sqlite_rebuild({});
				await insertStarted.promise;

				testSetup.workspace[Symbol.dispose]();
				await Promise.resolve();

				expect(closeCalled).toBe(false);
				expect(insertRunCompleted).toBe(false);

				allowInsert.resolve();
				await rebuild;
				await closed.promise;

				expect(closeCalled).toBe(true);
				expect(insertRunCompleted).toBe(true);
			} finally {
				if (!closeCalled) testSetup.db.close();
			}
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('sqlite_search action is absent when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				// No FTS was passed, so the layer was never constructed and the
				// search action is never added to the registry.
				expect(
					(testSetup.workspace.sqlite.actions as Record<string, unknown>)
						.sqlite_search,
				).toBeUndefined();
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts, notes: t.notes },
						fts: { posts: ['title'] },
					}),
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						published: null,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						published: null,
					});

					await testSetup.workspace.sqlite.whenFlushed;

					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: {
							sqlite_search: (
								input: Record<string, unknown>,
							) => Promise<unknown>;
						};
					};
					const results = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						limit: 10,
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await disposeAndYieldForClose(testSetup);
				}
			});

			test('sqlite_search supports snippetColumn', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts },
						fts: { posts: ['published', 'title'] },
					}),
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						published: null,
					});

					await testSetup.workspace.sqlite.whenFlushed;

					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: {
							sqlite_search: (
								input: Record<string, unknown>,
							) => Promise<unknown>;
						};
					};
					const results = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						snippetColumn: 'title',
					})) as Array<{ id: string; snippet: string; rank: number }>;
					const fallbackResults = (await sqliteWithFts.actions.sqlite_search({
						table: 'posts',
						query: 'mirror',
						snippetColumn: 'missing',
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.snippet).toContain('<mark>mirror</mark>');
					expect(fallbackResults).toHaveLength(1);
					expect(fallbackResults[0]?.snippet).not.toContain(
						'<mark>mirror</mark>',
					);
				} finally {
					await disposeAndYieldForClose(testSetup);
				}
			});
		}
	});

	// ============================================================================
	// ACTION BRAND Tests
	// ============================================================================

	describe('action brand', () => {
		test('sqlite_rebuild is detectable via isAction()', async () => {
			const testSetup = setup();

			try {
				const { sqlite } = testSetup.workspace;
				expect(isAction(sqlite.actions.sqlite_rebuild)).toBe(true);
				expect(isMutation(sqlite.actions.sqlite_rebuild)).toBe(true);
			} finally {
				await disposeAndYieldForClose(testSetup);
			}
		});

		if (hasFts5) {
			test('sqlite_search is detectable via isAction() when configured', async () => {
				const testSetup = setup({
					build: (t) => ({
						tables: { posts: t.posts },
						fts: { posts: ['title'] },
					}),
				});

				try {
					await testSetup.workspace.sqlite.whenFlushed;
					const sqliteWithFts = testSetup.workspace.sqlite as unknown as {
						actions: { sqlite_search: unknown };
					};
					expect(isAction(sqliteWithFts.actions.sqlite_search)).toBe(true);
					expect(isQuery(sqliteWithFts.actions.sqlite_search)).toBe(true);
				} finally {
					await disposeAndYieldForClose(testSetup);
				}
			});
		}
	});
});
