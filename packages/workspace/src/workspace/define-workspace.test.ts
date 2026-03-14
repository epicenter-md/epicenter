/**
 * defineWorkspace Tests
 *
 * Validates that workspace definitions and created clients expose the expected typed APIs.
 * The suite also covers extension chaining, lifecycle ordering, and action binding semantics.
 *
 * Key behaviors:
 * - Workspace creation preserves typed access to tables, kv, and extensions.
 * - Extension readiness and teardown order stay deterministic.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { defineQuery } from '../shared/actions.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

describe('defineWorkspace', () => {
	test('creates workspace with tables and kv', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		expect(workspace.id).toBe('test-app');
		expect(workspace.tables).toHaveProperty('posts');
		expect(workspace.kv).toHaveProperty('theme');
	});

	test('createWorkspace() returns client with tables and kv', () => {
		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		expect(client.id).toBe('test-app');
		expect(client.ydoc).toBeInstanceOf(Y.Doc);
		expect(client.tables.posts).toBeDefined();
		expect(client.kv.get).toBeDefined();
	});

	test('client.tables and client.kv support read and write operations', () => {
		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		// Use tables
		client.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
		const postResult = client.tables.posts.get('1');
		expect(postResult.status).toBe('valid');

		// Use KV
		client.kv.set('theme', { mode: 'dark' });
		const themeResult = client.kv.get('theme');
		expect(themeResult).toEqual({ mode: 'dark' });
	});

	test('createWorkspace().withExtension() adds extensions', () => {
		// Mock extension with custom exports
		const mockExtension = (_context: {
			ydoc: Y.Doc;
			tables: unknown;
			kv: unknown;
		}) => ({
			customMethod: () => 'hello',
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		}).withExtension('mock', mockExtension);

		expect(client.extensions.mock).toBeDefined();
		expect(client.extensions.mock.customMethod()).toBe('hello');
	});

	test('extension exports are fully typed', () => {
		// Extension with rich exports
		const persistenceExtension = () => ({
			db: {
				query: (sql: string) => sql.toUpperCase(),
				execute: (sql: string) => ({ rows: [sql] }),
			},
			stats: { writes: 0, reads: 0 },
		});

		// Another extension with different exports
		const syncExtension = () => ({
			connect: (url: string) => `connected to ${url}`,
			disconnect: () => 'disconnected',
			status: 'idle' as 'idle' | 'syncing' | 'synced',
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('persistence', persistenceExtension)
			.withExtension('sync', syncExtension);

		// Test persistence extension exports are typed
		const queryResult = client.extensions.persistence.db.query('SELECT');
		expect(queryResult).toBe('SELECT');

		const execResult = client.extensions.persistence.db.execute('INSERT');
		expect(execResult.rows).toEqual(['INSERT']);

		expect(client.extensions.persistence.stats.writes).toBe(0);

		// Test sync extension exports are typed
		const connectResult = client.extensions.sync.connect('ws://localhost');
		expect(connectResult).toBe('connected to ws://localhost');

		expect(client.extensions.sync.disconnect()).toBe('disconnected');
		expect(client.extensions.sync.status).toBe('idle');

		// Type assertions (these would fail to compile if types were wrong)
		const _queryType: string = queryResult;
		const _connectType: string = connectResult;
		const _statusType: 'idle' | 'syncing' | 'synced' =
			client.extensions.sync.status;
		void _queryType;
		void _connectType;
		void _statusType;
	});

	test('client.destroy() cleans up', async () => {
		let destroyed = false;
		const mockExtension = () => ({
			destroy: async () => {
				destroyed = true;
			},
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		}).withExtension('mock', mockExtension);

		await client.destroy();
		expect(destroyed).toBe(true);
	});

	test('workspace with empty tables and kv initializes base client APIs', () => {
		const workspace = defineWorkspace({
			id: 'empty-app',
		});

		const client = createWorkspace(workspace);

		expect(client.id).toBe('empty-app');
		expect(Object.keys(client.definitions.tables)).toHaveLength(0);
		// KV always has methods (get, set, delete, observe), but no keys are defined
		expect(client.kv.get).toBeDefined();
	});

	test('createWorkspace with direct config (without defineWorkspace)', () => {
		const client = createWorkspace({
			id: 'direct-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		expect(client.id).toBe('direct-app');
		expect(client.tables.posts).toBeDefined();

		client.tables.posts.set({ id: '1', title: 'Direct', _v: 1 });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
	});

	test('createWorkspace client is usable before withExtension', () => {
		const client = createWorkspace({
			id: 'builder-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		client.tables.posts.set({ id: '1', title: 'Before Extensions', _v: 1 });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		expect(typeof client.withExtension).toBe('function');
	});

	test('withExtension chain keeps the same ydoc instance', () => {
		const baseClient = createWorkspace({
			id: 'shared-doc-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		baseClient.tables.posts.set({ id: '1', title: 'Original', _v: 1 });
		const clientWithExt = baseClient;

		expect(clientWithExt.ydoc).toBe(baseClient.ydoc);

		const result = clientWithExt.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Original');
		}
	});

	test('extension N+1 can access extension N exports via context (progressive type safety)', () => {
		const client = createWorkspace({
			id: 'chain-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('first', () => ({
				value: 42,
				helper: () => 'from-first',
			}))
			.withExtension('second', ({ extensions }) => {
				// extensions.first is fully typed here — no casts needed
				const doubled = extensions.first.value * 2;
				const msg = extensions.first.helper();
				return { doubled, msg };
			})
			.withExtension('third', ({ extensions }) => {
				// extensions.first AND extensions.second are both fully typed
				const tripled = extensions.first.value * 3;
				const fromSecond = extensions.second.doubled;
				return { tripled, fromSecond };
			});

		// All extensions accessible and typed on the final client
		expect(client.extensions.first.value).toBe(42);
		expect(client.extensions.first.helper()).toBe('from-first');
		expect(client.extensions.second.doubled).toBe(84);
		expect(client.extensions.second.msg).toBe('from-first');
		expect(client.extensions.third.tripled).toBe(126);
		expect(client.extensions.third.fromSecond).toBe(84);

		// Type-level assertions: these assignments would fail to compile if types were wrong
		const _num: number = client.extensions.first.value;
		const _str: string = client.extensions.first.helper();
		const _doubled: number = client.extensions.second.doubled;
		const _msg: string = client.extensions.second.msg;
		const _tripled: number = client.extensions.third.tripled;
		const _fromSecond: number = client.extensions.third.fromSecond;
		void [_num, _str, _doubled, _msg, _tripled, _fromSecond];
	});

	test('.withActions() works after .withExtension() chain', () => {
		const client = createWorkspace({
			id: 'actions-after-ext',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('analytics', () => ({
				getCount: () => 5,
			}))
			.withActions((c) => ({
				getAnalyticsCount: defineQuery({
					handler: () => c.extensions.analytics.getCount(),
				}),
				addPost: defineQuery({
					input: Type.Object({ title: Type.String() }),
					handler: ({ title }) => {
						c.tables.posts.set({ id: '1', title, _v: 1 });
					},
				}),
			}));

		// Actions are callable directly
		expect(client.actions.getAnalyticsCount()).toBe(5);
		client.actions.addPost({ title: 'Hello' });

		// Extensions still accessible
		expect(client.extensions.analytics.getCount()).toBe(5);

		// Tables still accessible
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
	});

	test('context.whenReady resolves after prior extensions', async () => {
		const order: string[] = [];

		const client = createWorkspace({
			id: 'when-ready-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('slow', () => ({
				tag: 'slow',
				whenReady: new Promise<void>((resolve) =>
					setTimeout(() => {
						order.push('slow-ready');
						resolve();
					}, 50),
				),
			}))
			.withExtension('dependent', ({ whenReady }) => {
				// whenReady should be a promise representing all prior extensions
				expect(whenReady).toBeInstanceOf(Promise);

				const whenReadyPromise = (async () => {
					await whenReady;
					order.push('dependent-ready');
				})();

				return {
					tag: 'dependent',
					whenReady: whenReadyPromise,
				};
			});

		await client.whenReady;
		// 'slow' must resolve before 'dependent' starts
		expect(order).toEqual(['slow-ready', 'dependent-ready']);
	});

	test('first extension gets immediately-resolving context.whenReady', async () => {
		let contextWhenReady: Promise<void> | undefined;

		createWorkspace({
			id: 'first-ext-test',
		}).withExtension('first', ({ whenReady }) => {
			contextWhenReady = whenReady;
			return { tag: 'first' };
		});

		// First extension's whenReady = Promise.all([]) which resolves immediately
		expect(contextWhenReady).toBeInstanceOf(Promise);
		await contextWhenReady; // should not hang
	});

	test('context includes client, whenReady, and extensions', () => {
		const tableDef = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);

		createWorkspace({
			id: 'full-context-test',
			tables: { posts: tableDef },
		}).withExtension(
			'inspector',
			({ id, ydoc, tables, kv, extensions, whenReady }) => {
				// All ExtensionContext fields should be present
				expect(id).toBe('full-context-test');
				expect(ydoc).toBeDefined();
				expect(tables).toBeDefined();
				expect(kv).toBeDefined();
				expect(extensions).toBeDefined();
				expect(whenReady).toBeInstanceOf(Promise);
				return {};
			},
		);
	});

	test('destroy runs in reverse order (LIFO)', async () => {
		const order: string[] = [];

		const client = createWorkspace({
			id: 'destroy-order',
		})
			.withExtension('a', () => ({
				destroy: () => {
					order.push('a');
				},
			}))
			.withExtension('b', () => ({
				destroy: () => {
					order.push('b');
				},
			}))
			.withExtension('c', () => ({
				destroy: () => {
					order.push('c');
				},
			}));

		await client.destroy();
		expect(order).toEqual(['c', 'b', 'a']);
	});
});
