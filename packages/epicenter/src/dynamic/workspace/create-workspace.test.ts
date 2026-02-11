import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { defineExports } from '../../shared/lifecycle';
import { boolean, Id, id, integer, select, table, text } from '../schema';
import { defineWorkspace } from '../schema/workspace-definition';
import { createWorkspace } from './create-workspace';

// ════════════════════════════════════════════════════════════════════════════
// TEST FIXTURES
// ════════════════════════════════════════════════════════════════════════════

const postsTable = table({
	id: 'posts',
	name: 'Posts',
	fields: [
		id(),
		text({ id: 'title' }),
		integer({ id: 'view_count' }),
		boolean({ id: 'published' }),
	] as const,
});

const settingsKv = select({
	id: 'theme',
	name: 'Theme',
	options: ['light', 'dark'] as const,
	default: 'light',
});

const testDefinition = defineWorkspace({
	id: 'test-workspace',
	name: 'Test Workspace',
	description: 'A test workspace',
	icon: null,
	tables: [postsTable],
	kv: [settingsKv],
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('createWorkspace', () => {
	describe('direct usage (no extensions)', () => {
		test('returns a usable client immediately', () => {
			const workspace = createWorkspace(testDefinition);

			// Should be usable immediately
			expect(workspace.id).toBe('test-workspace');
			expect(workspace.ydoc).toBeInstanceOf(Y.Doc);
			expect(workspace.tables).toBeDefined();
			expect(workspace.kv).toBeDefined();
			expect(workspace.extensions).toEqual({});
			expect(workspace.whenSynced).toBeInstanceOf(Promise);
			expect(typeof workspace.destroy).toBe('function');
		});

		test('Y.Doc has correct guid and gc settings', () => {
			const workspace = createWorkspace(testDefinition);

			// guid should be definition.id
			expect(workspace.ydoc.guid).toBe('test-workspace');
			// gc should be true for efficient YKeyValueLww storage
			expect(workspace.ydoc.gc).toBe(true);
		});

		test('tables are usable without extensions', () => {
			const workspace = createWorkspace(testDefinition);

			// Insert a row
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Hello World',
				view_count: 0,
				published: false,
			} as any);

			// Read back
			const result = workspace.tables.get('posts').get(Id('1'));
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect((result.row as any).title).toBe('Hello World');
				expect((result.row as any).view_count).toBe(0);
				expect((result.row as any).published).toBe(false);
			}
		});

		test('kv is usable without extensions', () => {
			const workspace = createWorkspace(testDefinition);

			// Set a KV value
			workspace.kv.set('theme', 'dark');

			// Read back
			const result = workspace.kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('dark');
			}
		});

		test('whenSynced resolves immediately without extensions', async () => {
			const workspace = createWorkspace(testDefinition);

			// Should resolve immediately since there are no extensions
			await expect(workspace.whenSynced).resolves.toBeUndefined();
		});
	});

	describe('.withExtensions()', () => {
		test('returns a new client with extensions', () => {
			const baseWorkspace = createWorkspace(testDefinition);

			// Use inline factory for better type inference
			const workspace = baseWorkspace.withExtensions({
				mock: ({ id }) =>
					defineExports({
						greeting: `Hello from ${id}`,
					}),
			});

			// Should have extension exports
			expect(workspace.extensions.mock).toBeDefined();
			expect(workspace.extensions.mock.greeting).toBe(
				'Hello from test-workspace',
			);
		});

		test('extensions receive correct context', () => {
			const baseWorkspace = createWorkspace(testDefinition);

			let receivedContext: Record<string, unknown> | undefined;
			baseWorkspace.withExtensions({
				capture: (ctx) => {
					receivedContext = {
						id: ctx.id,
						extensionId: ctx.extensionId,
						hasYdoc: ctx.ydoc instanceof Y.Doc,
						hasTables: typeof ctx.tables.get === 'function',
						hasKv: typeof ctx.kv.get === 'function',
						hasDefinition: ctx.definition !== undefined,
					};
					return defineExports();
				},
			});

			expect(receivedContext).toBeDefined();
			expect(receivedContext?.id).toBe('test-workspace');
			expect(receivedContext?.extensionId).toBe('capture');
			expect(receivedContext?.hasYdoc).toBe(true);
			expect(receivedContext?.hasTables).toBe(true);
			expect(receivedContext?.hasKv).toBe(true);
			expect(receivedContext?.hasDefinition).toBe(true);
		});

		test('whenSynced aggregates all extension promises', async () => {
			const baseWorkspace = createWorkspace(testDefinition);

			let resolved1 = false;
			let resolved2 = false;

			const workspace = baseWorkspace.withExtensions({
				ext1: () =>
					defineExports({
						whenSynced: new Promise<void>((resolve) => {
							setTimeout(() => {
								resolved1 = true;
								resolve();
							}, 10);
						}),
					}),
				ext2: () =>
					defineExports({
						whenSynced: new Promise<void>((resolve) => {
							setTimeout(() => {
								resolved2 = true;
								resolve();
							}, 20);
						}),
					}),
			});

			// Before awaiting, neither should be resolved
			expect(resolved1).toBe(false);
			expect(resolved2).toBe(false);

			// After awaiting, both should be resolved
			await workspace.whenSynced;
			expect(resolved1).toBe(true);
			expect(resolved2).toBe(true);
		});

		test('base client extensions remains empty after chaining', () => {
			const baseWorkspace = createWorkspace(testDefinition);

			const chainedWorkspace = baseWorkspace.withExtensions({
				mock: () => defineExports({ data: 'test' }),
			});

			// Base should still have empty extensions
			expect(baseWorkspace.extensions).toEqual({});
			// Chained should have the extension
			expect(chainedWorkspace.extensions.mock.data).toBe('test');
		});
	});

	describe('lifecycle', () => {
		test('destroy() cleans up Y.Doc', async () => {
			const workspace = createWorkspace(testDefinition);

			// Add some data
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Test',
				view_count: 0,
				published: false,
			} as any);

			// Destroy
			await workspace.destroy();

			// Y.Doc should be destroyed (no way to directly check, but shouldn't throw)
		});

		test('destroy() calls extension destroy functions', async () => {
			const baseWorkspace = createWorkspace(testDefinition);

			let destroyed1 = false;
			let destroyed2 = false;

			const workspace = baseWorkspace.withExtensions({
				ext1: () =>
					defineExports({
						destroy: () => {
							destroyed1 = true;
						},
					}),
				ext2: () =>
					defineExports({
						destroy: () => {
							destroyed2 = true;
						},
					}),
			});

			// Before destroy
			expect(destroyed1).toBe(false);
			expect(destroyed2).toBe(false);

			// After destroy
			await workspace.destroy();
			expect(destroyed1).toBe(true);
			expect(destroyed2).toBe(true);
		});

		test('Symbol.asyncDispose works for await using', async () => {
			let destroyed = false;

			const workspace = createWorkspace(testDefinition).withExtensions({
				tracker: () =>
					defineExports({
						destroy: () => {
							destroyed = true;
						},
					}),
			});

			// Manually call asyncDispose (simulate await using)
			await workspace[Symbol.asyncDispose]();

			expect(destroyed).toBe(true);
		});
	});

	describe('type inference', () => {
		test('table types work at runtime', () => {
			const workspace = createWorkspace(testDefinition);

			// Insert data
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Test',
				view_count: 100,
				published: true,
			} as any);

			const result = workspace.tables.get('posts').get(Id('1'));
			if (result.status === 'valid') {
				// Verify values at runtime
				expect((result.row as any).title).toBe('Test');
				expect((result.row as any).view_count).toBe(100);
				expect((result.row as any).published).toBe(true);
			}
		});

		test('extension types are inferred correctly', () => {
			const workspace = createWorkspace(testDefinition).withExtensions({
				myExt: () =>
					defineExports({
						version: 1,
						getName: () => 'my-extension',
					}),
			});

			// These should be correctly typed via inference
			expect(workspace.extensions.myExt.version).toBe(1);
			expect(workspace.extensions.myExt.getName()).toBe('my-extension');
		});
	});
});
