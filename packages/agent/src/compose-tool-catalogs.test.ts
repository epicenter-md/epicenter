/**
 * Composed Tool Catalog Tests
 *
 * Verifies live catalog unioning, first-wins collisions, and resolution.
 *
 * Key behaviors:
 * - Definitions merge by name
 * - The first owner resolves collisions
 * - Getter sources are read live
 */
import { describe, expect, test } from 'bun:test';
import { composeToolCatalogs } from './compose-tool-catalogs.js';
import type { ToolCatalog } from './tools.js';

function catalog(label: string, names: string[]): ToolCatalog {
	return {
		definitions: () => names.map((name) => ({ name, kind: 'query' })),
		resolve: async (call) => ({
			content: `${label}:${call.toolName}`,
			isError: false,
		}),
	};
}

const call = (toolName: string) => ({ toolCallId: '1', toolName, input: null });
const signal = new AbortController().signal;

describe('composeToolCatalogs', () => {
	test('unions definitions and routes calls to their owner', async () => {
		const merged = composeToolCatalogs([
			catalog('a', ['one']),
			catalog('b', ['two']),
		]);
		expect(merged.definitions().map((item) => item.name)).toEqual([
			'one',
			'two',
		]);
		expect(await merged.resolve(call('two'), signal)).toEqual({
			content: 'b:two',
			isError: false,
		});
	});

	test('first catalog wins a name collision', async () => {
		const merged = composeToolCatalogs([
			catalog('first', ['same']),
			catalog('second', ['same']),
		]);
		expect(merged.definitions()).toHaveLength(1);
		expect(await merged.resolve(call('same'), signal)).toEqual({
			content: 'first:same',
			isError: false,
		});
	});

	test('unknown tools return an error', async () => {
		const outcome = await composeToolCatalogs([]).resolve(
			call('missing'),
			signal,
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain('missing');
	});

	test('getter sources expose and resolve catalogs mounted later', async () => {
		const catalogs = [catalog('a', ['one'])];
		const merged = composeToolCatalogs(() => catalogs);
		catalogs.push(catalog('b', ['two']));
		expect(merged.definitions().map((item) => item.name)).toEqual([
			'one',
			'two',
		]);
		expect(await merged.resolve(call('two'), signal)).toEqual({
			content: 'b:two',
			isError: false,
		});
	});
});
