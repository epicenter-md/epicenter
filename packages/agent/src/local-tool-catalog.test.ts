/**
 * Local Tool Catalog Tests
 *
 * Verifies the structural adapter from callable local actions to tool catalogs.
 *
 * Key behaviors:
 * - Action metadata becomes tool metadata
 * - Raw and Result returns normalize to outcomes
 * - Declared schemas reject invalid input before invocation
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Err } from 'wellcrafted/result';
import {
	createLocalToolCatalog,
	type LocalAction,
} from './local-tool-catalog.js';

function action(
	type: 'query' | 'mutation',
	handler: (...args: never[]) => unknown,
	metadata: Partial<LocalAction> = {},
): LocalAction {
	return Object.assign(handler, { type, ...metadata });
}

const signal = new AbortController().signal;

describe('createLocalToolCatalog', () => {
	test('lists action metadata and resolves raw values', async () => {
		const catalog = createLocalToolCatalog({
			now: action('query', () => ({ now: 7 }), {
				description: 'local clock',
			}),
		});
		expect(catalog.definitions()[0]).toMatchObject({
			name: 'now',
			kind: 'query',
			description: 'local clock',
		});
		expect(
			await catalog.resolve(
				{ toolCallId: '1', toolName: 'now', input: {} },
				signal,
			),
		).toEqual({
			content: '{"now":7}',
			details: { now: 7 },
			isError: false,
		});
	});

	test('Result errors and thrown errors become readable outcomes', async () => {
		const catalog = createLocalToolCatalog({
			result_error: action('mutation', () => Err(new Error('bad result'))),
			throw_error: action('mutation', () => {
				throw new Error('bad throw');
			}),
		});
		for (const toolName of ['result_error', 'throw_error']) {
			const outcome = await catalog.resolve(
				{ toolCallId: '1', toolName, input: {} },
				signal,
			);
			expect(outcome.isError).toBe(true);
			expect(outcome.content).toContain('bad');
		}
	});

	test('declared input schema rejects invalid input before invocation', async () => {
		let invoked = false;
		const catalog = createLocalToolCatalog({
			double: action(
				'query',
				((input: { value: number }) => {
					invoked = true;
					return input.value * 2;
				}) as (...args: never[]) => unknown,
				{ input: Type.Object({ value: Type.Number() }) },
			),
		});
		const outcome = await catalog.resolve(
			{ toolCallId: '1', toolName: 'double', input: { value: 'no' } },
			signal,
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain('Invalid action input');
		expect(invoked).toBe(false);
	});

	test('unknown action names return an error', async () => {
		const outcome = await createLocalToolCatalog({}).resolve(
			{ toolCallId: '1', toolName: 'missing', input: {} },
			signal,
		);
		expect(outcome.isError).toBe(true);
	});
});
