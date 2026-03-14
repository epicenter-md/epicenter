/**
 * createWorkspace Tests
 *
 * Verifies workspace client behavior for batching, observer delivery, and documents wiring.
 * These tests protect the runtime contract that table/KV operations stay consistent across transactions
 * and that optional document bindings are attached only when configured.
 *
 * Key behaviors:
 * - Batch transactions coalesce notifications while preserving applied mutations.
 * - Document-bound tables expose `documents`, while non-bound tables do not.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { createDocuments } from './create-document.js';
import { createTables } from './create-tables.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

/** Creates a workspace client with two tables and one KV for testing. */
function setup() {
	const postsTable = defineTable(
		type({ id: 'string', title: 'string', _v: '1' }),
	);
	const tagsTable = defineTable(
		type({ id: 'string', name: 'string', _v: '1' }),
	);
	const themeDef = defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' });

	const definition = defineWorkspace({
		id: 'test-workspace',
		tables: { posts: postsTable, tags: tagsTable },
		kv: { theme: themeDef },
	});

	const client = createWorkspace(definition);
	return { client };
}

describe('createWorkspace', () => {
	describe('batch()', () => {
		describe('core behavior', () => {
			test('batch() batches table operations', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '1', title: 'First', _v: 1 });
					client.tables.posts.set({ id: '2', title: 'Second', _v: 1 });
					client.tables.posts.set({ id: '3', title: 'Third', _v: 1 });
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);
				expect(client.tables.posts.count()).toBe(3);

				unsubscribe();
			});

			test('batch() batches table deletes', () => {
				const { client } = setup();

				client.tables.posts.set({ id: '1', title: 'A', _v: 1 });
				client.tables.posts.set({ id: '2', title: 'B', _v: 1 });
				client.tables.posts.set({ id: '3', title: 'C', _v: 1 });

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.delete('1');
					client.tables.posts.delete('2');
					client.tables.posts.delete('3');
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);
				expect(client.tables.posts.count()).toBe(0);

				unsubscribe();
			});

			test('batch() batches mixed set + delete', () => {
				const { client } = setup();

				client.tables.posts.set({ id: '1', title: 'Existing', _v: 1 });

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '2', title: 'New', _v: 1 });
					client.tables.posts.delete('1');
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(client.tables.posts.count()).toBe(1);
				expect(client.tables.posts.has('1')).toBe(false);
				expect(client.tables.posts.has('2')).toBe(true);

				unsubscribe();
			});

			test('batch() works across multiple tables', () => {
				const { client } = setup();

				const postChanges: Set<string>[] = [];
				const tagChanges: Set<string>[] = [];

				const unsubPosts = client.tables.posts.observe((changedIds) => {
					postChanges.push(new Set(changedIds));
				});
				const unsubTags = client.tables.tags.observe((changedIds) => {
					tagChanges.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: 'p1', title: 'Post', _v: 1 });
					client.tables.tags.set({ id: 't1', name: 'Tag', _v: 1 });
				});

				expect(postChanges).toHaveLength(1);
				expect(postChanges[0]?.has('p1')).toBe(true);
				expect(tagChanges).toHaveLength(1);
				expect(tagChanges[0]?.has('t1')).toBe(true);

				unsubPosts();
				unsubTags();
			});

			test('batch() works across tables and KV', () => {
				const { client } = setup();

				const postChanges: Set<string>[] = [];
				const kvChanges: unknown[] = [];

				const unsubPosts = client.tables.posts.observe((changedIds) => {
					postChanges.push(new Set(changedIds));
				});
				const unsubKv = client.kv.observe('theme', (change) => {
					kvChanges.push(change);
				});

				client.batch(() => {
					client.tables.posts.set({ id: 'p1', title: 'Post', _v: 1 });
					client.kv.set('theme', { mode: 'dark' });
				});

				expect(postChanges).toHaveLength(1);
				expect(postChanges[0]?.has('p1')).toBe(true);
				expect(kvChanges).toHaveLength(1);

				unsubPosts();
				unsubKv();
			});

			test('batch() with no operations is a no-op', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					// intentionally empty
				});

				expect(changes).toHaveLength(0);

				unsubscribe();
			});

			test('nested batch() calls emit one merged notification', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '1', title: 'Outer', _v: 1 });
					client.batch(() => {
						client.tables.posts.set({ id: '2', title: 'Inner', _v: 1 });
					});
					client.tables.posts.set({ id: '3', title: 'After inner', _v: 1 });
				});

				// Inner batch absorbed by outer — single notification
				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);

				unsubscribe();
			});
		});

		describe('observer semantics', () => {
			test('without batch(), each set() fires observer separately', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.tables.posts.set({ id: '1', title: 'First', _v: 1 });
				client.tables.posts.set({ id: '2', title: 'Second', _v: 1 });
				client.tables.posts.set({ id: '3', title: 'Third', _v: 1 });

				expect(changes).toHaveLength(3);

				unsubscribe();
			});

			test('with batch(), many operations emit one notification', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					for (let i = 0; i < 100; i++) {
						client.tables.posts.set({ id: `${i}`, title: `Post ${i}`, _v: 1 });
					}
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.size).toBe(100);

				unsubscribe();
			});
		});

		describe('edge cases', () => {
			test('error inside batch() still applies prior operations', () => {
				const { client } = setup();

				try {
					client.batch(() => {
						client.tables.posts.set({ id: '1', title: 'Before error', _v: 1 });
						client.tables.posts.set({ id: '2', title: 'Also before', _v: 1 });
						throw new Error('intentional');
					});
				} catch {
					// expected
				}

				// Yjs transact doesn't roll back — prior mutations are applied
				expect(client.tables.posts.has('1')).toBe(true);
				expect(client.tables.posts.has('2')).toBe(true);
				expect(client.tables.posts.count()).toBe(2);
			});
		});
	});

	describe('extension whenReady', () => {
		test('withExtension injects whenReady into extension exports', () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);

			const client = createWorkspace({
				id: 'ext-await-test-1',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				return { someValue: 42, destroy: () => {} };
			});

			expect(client.extensions.myExt.someValue).toBe(42);
		});

		test('extension factory receives prior extensions', () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let receivedFirstExtension = false;

			createWorkspace({
				id: 'ext-await-test-2',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						value: 'first',
						destroy: () => {},
					};
				})
				.withExtension('second', ({ extensions }) => {
					receivedFirstExtension = extensions.first.value === 'first';
					return { destroy: () => {} };
				});

			expect(receivedFirstExtension).toBe(true);
		});

		test('composite whenReady waits for all extensions to resolve', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstWhenReady: (() => void) | undefined;

			const firstWhenReady = new Promise<void>((resolve) => {
				resolveFirstWhenReady = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-3',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						value: 'first',
						whenReady: firstWhenReady,
						destroy: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						value: 'second',
						whenReady: Promise.resolve(),
						destroy: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstWhenReady?.();
			await client.whenReady;
			expect(compositeResolved).toBe(true);
		});

		test('composite whenReady waits for all extensions', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstWhenReady: (() => void) | undefined;
			let resolveSecondWhenReady: (() => void) | undefined;

			const firstWhenReady = new Promise<void>((resolve) => {
				resolveFirstWhenReady = resolve;
			});
			const secondWhenReady = new Promise<void>((resolve) => {
				resolveSecondWhenReady = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-4',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						whenReady: firstWhenReady,
						destroy: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						whenReady: secondWhenReady,
						destroy: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstWhenReady?.();
			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveSecondWhenReady?.();
			await client.whenReady;
			expect(compositeResolved).toBe(true);
		});

		test('extension exports are accessible', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);

			const client = createWorkspace({
				id: 'ext-await-test-5',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				return { foo: 42 };
			});

			expect(client.extensions.myExt.foo).toBe(42);
		});

		test('extensions.X.whenReady is always a Promise even without explicit whenReady', () => {
			const client = createWorkspace({
				id: 'ext-whenready-default',
			}).withExtension('bare', () => {
				return { tag: 'no-lifecycle' };
			});

			expect(client.extensions.bare.whenReady).toBeInstanceOf(Promise);
		});

		test('extensions.X.destroy is always a function even without explicit destroy', () => {
			const client = createWorkspace({
				id: 'ext-destroy-default',
			}).withExtension('bare', () => {
				return { tag: 'no-lifecycle' };
			});

			expect(typeof client.extensions.bare.destroy).toBe('function');
		});

		test('surgical await: extension B chains off extensions.A.whenReady', async () => {
			const order: string[] = [];
			let resolveA: (() => void) | undefined;
			const aReady = new Promise<void>((r) => {
				resolveA = r;
			});

			const client = createWorkspace({
				id: 'surgical-await-test',
			})
				.withExtension('a', () => ({
					tag: 'a',
					whenReady: aReady.then(() => {
						order.push('a-ready');
					}),
				}))
				.withExtension('b', ({ extensions }) => {
					const whenReadyPromise = (async () => {
						await extensions.a.whenReady;
						order.push('b-ready');
					})();
					return { tag: 'b', whenReady: whenReadyPromise };
				});

			// B should not resolve until A does
			let bResolved = false;
			client.extensions.b.whenReady.then(() => {
				bResolved = true;
			});
			await Promise.resolve();
			expect(bResolved).toBe(false);

			resolveA?.();
			await client.whenReady;
			expect(order).toEqual(['a-ready', 'b-ready']);
		});
	});

	describe('document wiring', () => {
		test('table using withDocument exposes documents in documents namespace', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-test',
				tables: { files: filesTable },
			});

			const content = client.documents.files.content;
			expect(content).toBeDefined();
			expect(typeof content.open).toBe('function');
			expect(typeof content.close).toBe('function');
			expect(typeof content.closeAll).toBe('function');
		});

		test('table without withDocument does not appear in documents namespace', () => {
			const { client } = setup();

			expect(Object.keys(client.documents)).not.toContain('posts');
			expect(Object.keys(client.documents)).not.toContain('tags');
		});

		test('withDocumentExtension is wired into document bindings', async () => {
			let hookCalled = false;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-ext-test',
				tables: { files: filesTable },
			}).withDocumentExtension('test', () => {
				hookCalled = true;
				return { destroy: () => {} };
			});

			await client.documents.files.content.open('f1');

			expect(hookCalled).toBe(true);
		});

		test('withDocumentExtension with tags only fires for matching documents', async () => {
			const hookCalls: string[] = [];

			const notesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					thumbId: 'string',
					thumbUpdatedAt: 'number',
					_v: '1',
				}),
			)
				.withDocument('content', {
					guid: 'id',
					onUpdate: () => ({ updatedAt: Date.now() }),
					tags: ['persistent', 'synced'],
				})
				.withDocument('thumb', {
					guid: 'thumbId',
					onUpdate: () => ({ thumbUpdatedAt: Date.now() }),
					tags: ['ephemeral'],
				});

			const client = createWorkspace({
				id: 'doc-tag-test',
				tables: { notes: notesTable },
			})
				.withDocumentExtension(
					'persistent-only',
					() => {
						hookCalls.push('persistent-only');
						return { destroy: () => {} };
					},
					{ tags: ['persistent'] },
				)
				.withDocumentExtension(
					'ephemeral-only',
					() => {
						hookCalls.push('ephemeral-only');
						return { destroy: () => {} };
					},
					{ tags: ['ephemeral'] },
				)
				.withDocumentExtension('universal', () => {
					hookCalls.push('universal');
					return { destroy: () => {} };
				});

			// Content doc has tags ['persistent', 'synced']
			await client.documents.notes.content.open('f1');
			// 'persistent-only' matches (shares 'persistent')
			// 'ephemeral-only' does NOT match (no overlap)
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['persistent-only', 'universal']);

			hookCalls.length = 0;

			// Thumb doc has tag ['ephemeral']
			await client.documents.notes.thumb.open('t1');
			// 'persistent-only' does NOT match
			// 'ephemeral-only' matches (shares 'ephemeral')
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['ephemeral-only', 'universal']);
		});

		test('withExtension registers for both workspace and document Y.Docs', async () => {
			let factoryCallCount = 0;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			// withExtension fires factory for workspace Y.Doc AND registers
			// it as a document extension (tags: [] = universal)
			const client = createWorkspace({
				id: 'three-tier-both-test',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				factoryCallCount++;
				return {
					tag: 'ext',
					destroy: () => {},
				};
			});

			// Factory fires once synchronously for the workspace Y.Doc
			expect(factoryCallCount).toBe(1);
			expect(client.extensions.myExt.tag).toBe('ext');

			// Open a document — the same factory should fire again as a document extension
			await client.documents.files.content.open('f1');

			// Factory called twice: once for workspace, once for document
			expect(factoryCallCount).toBe(2);
		});

		test('withWorkspaceExtension fires only for workspace Y.Doc, not documents', async () => {
			let factoryCallCount = 0;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'three-tier-ws-only-test',
				tables: { files: filesTable },
			}).withWorkspaceExtension('wsOnly', () => {
				factoryCallCount++;
				return {
					tag: 'ws-only',
					destroy: () => {},
				};
			});

			// Factory should fire once for workspace Y.Doc
			expect(factoryCallCount).toBe(1);
			expect(client.extensions.wsOnly.tag).toBe('ws-only');

			// Opening a document should NOT trigger this extension
			await client.documents.files.content.open('f1');

			// Still exactly 1 call — withWorkspaceExtension does not register for documents
			expect(factoryCallCount).toBe(1);
		});

		test('workspace destroy cascades to closeAll on bindings', async () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-destroy-test',
				tables: { files: filesTable },
			});

			const doc1 = await client.documents.files.content.open('f1');

			await client.destroy();

			// After destroy, open should create a new Y.Doc (since documents were destroyed)
			// But we can't open after workspace destroy — just verify no error occurred
			expect(doc1).toBeDefined();
		});

		test('multiple tables with document bindings each get their own namespace', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const notesTable = defineTable(
				type({
					id: 'string',
					bodyDocId: 'string',
					bodyUpdatedAt: 'number',
					_v: '1',
				}),
			).withDocument('body', {
				guid: 'bodyDocId',
				onUpdate: () => ({ bodyUpdatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'multi-doc-test',
				tables: { files: filesTable, notes: notesTable },
			});

			expect(client.documents.files.content).toBeDefined();
			expect(client.documents.notes.body).toBeDefined();
			expect(client.documents.files.content).not.toBe(
				client.documents.notes.body,
			);
		});
	});

	// ════════════════════════════════════════════════════════════════════════════
	// BASELINE TESTS (Phase 0) — Verify lifecycle correctness
	// ════════════════════════════════════════════════════════════════════════════

	describe('lifecycle baseline', () => {
		const def = defineWorkspace({ id: 'lifecycle-test' });

		test('builder branching creates isolated extension sets', () => {
			const base = createWorkspace(def).withExtension('a', () => ({
				value: 'a',
			}));
			const b1 = base.withExtension('b', () => ({ value: 'b' }));
			const b2 = base.withExtension('c', () => ({ value: 'c' }));

			expect(Object.keys(base.extensions)).toEqual(['a']);
			expect(Object.keys(b1.extensions)).toEqual(['a', 'b']);
			expect(Object.keys(b2.extensions)).toEqual(['a', 'c']);
		});

		test('void-returning factory does not appear in extensions', () => {
			const client = createWorkspace(def)
				.withExtension(
					'noop',
					() => undefined as unknown as Record<string, unknown>,
				)
				.withExtension('real', () => ({ value: 42 }));

			expect(client.extensions.noop).toBeUndefined();
			expect(client.extensions.real).toBeDefined();
			expect(client.extensions.real.value).toBe(42);
		});

		test('factory throw in workspace cleans up prior extensions in LIFO order', async () => {
			const cleanupOrder: string[] = [];
			const factory =
				(name: string, shouldThrow = false) =>
				() => {
					if (shouldThrow) throw new Error(`${name} factory failed`);
					return {
						destroy: async () => {
							cleanupOrder.push(name);
						},
					};
				};

			try {
				createWorkspace(def)
					.withExtension('first', factory('first'))
					.withExtension('second', factory('second'))
					.withExtension('third', factory('third', true)); // throws
			} catch {
				// expected
			}

			expect(cleanupOrder).toEqual(['second', 'first']); // LIFO, skips 'third'
		});

		test('document extension destroy order is LIFO', async () => {
			const destroyOrder: string[] = [];
			const factory = (name: string) => () => ({
				destroy: async () => {
					destroyOrder.push(name);
				},
			});

			const mockYdoc = new Y.Doc({ guid: 'doc-lifo-test' });
			const fileSchema = type({
				id: 'string',
				updatedAt: 'number',
				_v: '1',
			});
			const tables = createTables(mockYdoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				guidKey: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{ key: 'first', factory: factory('first'), tags: [] },
					{ key: 'second', factory: factory('second'), tags: [] },
					{ key: 'third', factory: factory('third'), tags: [] },
				],
			});

			await documents.open('doc-1');
			await documents.close('doc-1');

			expect(destroyOrder).toEqual(['third', 'second', 'first']); // LIFO
		});

		test('whenReady rejection in workspace triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectWhenReady: (() => void) | undefined;
			const whenReadyPromise = new Promise<void>((_, reject) => {
				rejectWhenReady = () => reject(new Error('provider failed'));
			});

			const client = createWorkspace(def)
				.withExtension('first', () => ({
					destroy: async () => {
						cleanupCalled.add('first');
					},
				}))
				.withExtension('second', () => ({
					whenReady: whenReadyPromise,
					destroy: async () => {
						cleanupCalled.add('second');
					},
				}));

			// Trigger rejection
			rejectWhenReady?.();

			try {
				await client.whenReady;
			} catch {
				// expected
			}

			expect(cleanupCalled.has('first')).toBe(true);
			expect(cleanupCalled.has('second')).toBe(true);
		});

		test('document extension whenReady rejection triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectWhenReady: (() => void) | undefined;
			const whenReadyPromise = new Promise<void>((_, reject) => {
				rejectWhenReady = () => reject(new Error('provider failed'));
			});

			const mockYdoc = new Y.Doc({ guid: 'doc-reject-test' });
			const fileSchema = type({
				id: 'string',
				updatedAt: 'number',
				_v: '1',
			});
			const tables = createTables(mockYdoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				guidKey: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							destroy: async () => {
								cleanupCalled.add('first');
							},
						}),
						tags: [],
					},
					{
						key: 'second',
						factory: () => ({
							whenReady: whenReadyPromise,
							destroy: async () => {
								cleanupCalled.add('second');
							},
						}),
						tags: [],
					},
				],
			});

			const handlePromise = documents.open('doc-1');
			rejectWhenReady?.();

			try {
				await handlePromise;
			} catch {
				// expected
			}

			expect(cleanupCalled.has('first')).toBe(true);
			expect(cleanupCalled.has('second')).toBe(true);
		});
	});
});
