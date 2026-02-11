import type { CommandModule } from 'yargs';
import type { AnyWorkspaceClient } from '../discovery.js';
import { formatYargsOptions, output, outputError } from '../format-output.js';
import { parseJsonInput, readStdinSync } from '../parse-input.js';

/**
 * Build yargs commands for KV operations.
 */
export function buildKvCommands(client: AnyWorkspaceClient): CommandModule[] {
	return [buildKvCommand(client)];
}

function buildKvCommand(client: AnyWorkspaceClient): CommandModule {
	return {
		command: 'kv <action>',
		describe: 'Manage key-value store',
		builder: (yargs) => {
			return yargs
				.command({
					command: 'list',
					describe: 'List all KV entries',
					builder: (y) => y.options(formatYargsOptions()),
					handler: () => {
						// KV doesn't have a built-in list method, so we need to iterate known keys
						// For now, output a message indicating this limitation
						// In a real implementation, you'd need access to the KV definition keys
						outputError(
							'KV list requires knowledge of defined keys. Use specific get commands.',
						);
						process.exitCode = 1;
					},
				})
				.command({
					command: 'get <key>',
					describe: 'Get a value by key',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: (argv) => {
						const key = argv.key as string;
						try {
							const result = client.kv.get(key);
							if (result.status === 'not_found') {
								outputError(`Key not found: ${key}`);
								process.exitCode = 1;
								return;
							}
							output(result, { format: argv.format as 'json' | 'jsonl' });
						} catch (error) {
							outputError(
								`Error getting key "${key}": ${error instanceof Error ? error.message : String(error)}`,
							);
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'set <key> [value]',
					describe: 'Set a value by key',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.positional('value', {
								type: 'string',
								description: 'JSON value or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read value from file',
							})
							.options(formatYargsOptions()),
					handler: (argv) => {
						const key = argv.key as string;

						// Try to parse the value
						const stdinContent = readStdinSync();
						const valueStr = argv.value as string | undefined;

						// For simple string values, allow non-JSON input
						let value: unknown;
						if (
							valueStr &&
							!valueStr.startsWith('{') &&
							!valueStr.startsWith('[') &&
							!valueStr.startsWith('"') &&
							!valueStr.startsWith('@')
						) {
							// Treat as raw string value
							value = valueStr;
						} else {
							const result = parseJsonInput({
								positional: valueStr,
								file: argv.file as string | undefined,
								hasStdin: stdinContent !== undefined,
								stdinContent,
							});

							if (!result.ok) {
								outputError(result.error);
								process.exitCode = 1;
								return;
							}
							value = result.data;
						}

						try {
							client.kv.set(key, value as never);
							output(
								{ status: 'set', key, value },
								{ format: argv.format as 'json' | 'jsonl' },
							);
						} catch (error) {
							outputError(
								`Error setting key "${key}": ${error instanceof Error ? error.message : String(error)}`,
							);
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'delete <key>',
					aliases: ['reset'],
					describe: 'Delete a value by key (reset to undefined)',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: (argv) => {
						const key = argv.key as string;
						try {
							client.kv.delete(key as never);
							output(
								{ status: 'deleted', key },
								{ format: argv.format as 'json' | 'jsonl' },
							);
						} catch (error) {
							outputError(
								`Error deleting key "${key}": ${error instanceof Error ? error.message : String(error)}`,
							);
							process.exitCode = 1;
						}
					},
				})
				.demandCommand(1, 'Specify an action: list, get, set, delete');
		},
		handler: () => {},
	};
}
