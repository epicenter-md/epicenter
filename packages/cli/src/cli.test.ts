/**
 * CLI Tests
 *
 * These tests verify that the CLI entry point correctly dispatches
 * commands via top-level commands (get, list, count, delete, tables, kv, export, auth, start).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli';

describe('createCLI', () => {
	test('returns an object with a run method', () => {
		const cli = createCLI();
		expect(typeof cli.run).toBe('function');
	});

	test('rejects with usage when no arguments provided', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// exitProcess(false) makes yargs throw instead of calling process.exit
		await expect(cli.run([])).rejects.toThrow(
			'Not enough non-option arguments',
		);

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).toContain('epicenter');
		errorSpy.mockRestore();
	});
});
