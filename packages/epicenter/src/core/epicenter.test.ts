import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineQuery, defineWorkspace, id, sqliteIndex, text } from '../index';
import { createEpicenterClient, defineEpicenter } from './epicenter/index';

/**
 * Trimmed test suite for Epicenter focusing on:
 * - Error handling and validation
 * - Action exposure and dependency resolution
 *
 * Note: Happy-path integration tests are covered by the Content Hub example
 * in examples/content-hub, which serves as a comprehensive real-world test.
 */

describe('Epicenter Error Handling', () => {
	test('should throw on duplicate workspace IDs', () => {
		const workspace1 = defineWorkspace({
			id: 'duplicate',
			schema: { items: { id: id(), value: text() } },
			indexes: { sqlite: (db) => sqliteIndex(db, { inMemory: true }) },
			exports: () => ({}),
		});

		const workspace2 = defineWorkspace({
			id: 'duplicate',
			schema: { items: { id: id(), value: text() } },
			indexes: { sqlite: (db) => sqliteIndex(db, { inMemory: true }) },
			exports: () => ({}),
		});

		expect(() =>
			defineEpicenter({
				id: 'test',
				workspaces: [workspace1, workspace2],
			}),
		).toThrow('Duplicate workspace IDs detected');
	});
});

describe('Action Exposure and Dependency Resolution', () => {
	/**
	 * Helper to create a simple workspace with actions for testing action exposure
	 */
	const createTestWorkspace = (workspaceId: string, deps: any[] = []) => {
		return defineWorkspace({
			id: workspaceId,
			dependencies: deps,
			schema: {
				items: {
					id: id(),
					value: text(),
				},
			},
			indexes: {
				sqlite: (db) => sqliteIndex(db, { inMemory: true }),
			},
			exports: ({ workspaces }) => ({
				getValue: defineQuery({
					handler: () => Ok(`value-from-${workspaceId}`),
				}),
				...(deps.length > 0
					? {
							getValueFromDependency: defineQuery({
								handler: async () => {
									// Access the first dependency's action
									const depId = deps[0].id;
									const result = await (workspaces as any)[depId].getValue();
									return result;
								},
							}),
						}
					: {}),
			}),
		});
	};

	test('exposes all workspaces in the workspaces array by id', async () => {
		const workspaceA = createTestWorkspace('a');
		const workspaceB = createTestWorkspace('b', [workspaceA]);

		const epicenter = defineEpicenter({
			id: 'test',
			workspaces: [workspaceA, workspaceB],
		});

		await using client = await createEpicenterClient(epicenter);

		// BOTH workspaces are exposed by their ids
		expect(client.a).toBeDefined();
		expect(client.b).toBeDefined();

		// Both have their actions
		expect(client.a?.getValue).toBeDefined();
		expect(client.b?.getValue).toBeDefined();
		expect(client.b?.getValueFromDependency).toBeDefined();

		// Can call actions on both
		const resultA = await client.a?.getValue();
		expect(resultA.data).toBe('value-from-a');

		const resultB = await client.b?.getValue();
		expect(resultB.data).toBe('value-from-b');
	});

	test('requires all transitive dependencies in workspaces array (flat/hoisted)', () => {
		const workspaceA = createTestWorkspace('a');
		const workspaceB = createTestWorkspace('b', [workspaceA]);
		const workspaceC = createTestWorkspace('c', [workspaceA, workspaceB]);

		// Only include B and C in epicenter, not A (missing dependency)
		const epicenter = defineEpicenter({
			id: 'test',
			workspaces: [workspaceB, workspaceC],
		});

		// Should throw because A is a dependency but not listed
		expect(() => createEpicenterClient(epicenter)).toThrow(
			/Missing dependency.*"a"/,
		);
	});

	test('flat/hoisted model: all dependencies must be explicitly listed', async () => {
		const workspaceA = createTestWorkspace('a');
		const workspaceB = createTestWorkspace('b', [workspaceA]);
		const workspaceC = createTestWorkspace('c', [workspaceA, workspaceB]);

		// Correctly include ALL workspaces (flat/hoisted)
		const epicenter = defineEpicenter({
			id: 'test',
			workspaces: [workspaceA, workspaceB, workspaceC],
		});

		await using client = await createEpicenterClient(epicenter);

		// All workspaces are exposed
		expect(client.a).toBeDefined();
		expect(client.b).toBeDefined();
		expect(client.c).toBeDefined();

		// Can call actions on all workspaces
		const resultA = await client.a?.getValue();
		expect(resultA.data).toBe('value-from-a');

		const resultB = await client.b?.getValueFromDependency?.();
		expect(resultB.data).toBe('value-from-a');
	});

	test('multiple workspaces with no dependencies - all exposed', async () => {
		const workspaceA = createTestWorkspace('a');
		const workspaceB = createTestWorkspace('b');
		const workspaceC = createTestWorkspace('c');

		const epicenter = defineEpicenter({
			id: 'test',
			workspaces: [workspaceA, workspaceB, workspaceC],
		});

		await using client = await createEpicenterClient(epicenter);

		// All three workspaces exposed
		expect(client.a).toBeDefined();
		expect(client.b).toBeDefined();
		expect(client.c).toBeDefined();

		// All have their actions
		const resultA = await client.a?.getValue();
		expect(resultA.data).toBe('value-from-a');

		const resultB = await client.b?.getValue();
		expect(resultB.data).toBe('value-from-b');

		const resultC = await client.c?.getValue();
		expect(resultC.data).toBe('value-from-c');
	});
});
