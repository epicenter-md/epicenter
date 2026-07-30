/**
 * Namespaced Tool Catalog Tests
 *
 * Verifies definition prefixing and call routing through a namespace.
 *
 * Key behaviors:
 * - Names are prefixed with a stable separator
 * - Resolution strips only the known prefix
 * - Unowned names fail without delegation
 */
import { describe, expect, test } from 'bun:test';
import { composeToolCatalogs } from './compose-tool-catalogs.js';
import { namespaceToolCatalog } from './namespace-tool-catalog.js';
import type { ToolCatalog } from './tools.js';

const signal = new AbortController().signal;
const inner: ToolCatalog = {
	definitions: () => [{ name: 'weird__name', kind: 'query' }],
	resolve: async (call) => ({ content: call.toolName, isError: false }),
};

describe('namespaceToolCatalog', () => {
	test('prefixes definitions and strips the prefix during resolution', async () => {
		const catalog = namespaceToolCatalog('device', inner);
		expect(catalog.definitions()[0]?.name).toBe('device__weird__name');
		expect(
			await catalog.resolve(
				{ toolCallId: '1', toolName: 'device__weird__name', input: null },
				signal,
			),
		).toEqual({ content: 'weird__name', isError: false });
	});

	test('unprefixed names return an error', async () => {
		const outcome = await namespaceToolCatalog('device', inner).resolve(
			{ toolCallId: '1', toolName: 'weird__name', input: null },
			signal,
		);
		expect(outcome.isError).toBe(true);
	});

	test('same-named tools coexist under distinct namespaces', () => {
		const merged = composeToolCatalogs([
			namespaceToolCatalog('first', inner),
			namespaceToolCatalog('second', inner),
		]);
		expect(merged.definitions().map((item) => item.name)).toEqual([
			'first__weird__name',
			'second__weird__name',
		]);
	});
});
