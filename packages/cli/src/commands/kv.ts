/**
 * `epicenter kv <action>` — manage workspace key-value store.
 *
 * Provides get, set, and delete operations on the workspace KV store.
 * Supports inline JSON, @file references, and stdin for values.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	defineCommand,
	runCommand,
	withWorkspaceOptions,
} from '../util/command';
import { formatYargsOptions, outputError } from '../util/format-output';
import { parseJsonInput, readStdinSync } from '../util/parse-input';

/**
 * Parse a value from argv positional, --file, or stdin.
 * Returns undefined on error (with process.exitCode set).
 */
function resolveInputValue(argv: any): unknown {
	const stdinContent = readStdinSync();
	const valueStr = argv.value as string | undefined;

	if (
		valueStr &&
		!valueStr.startsWith('{') &&
		!valueStr.startsWith('[') &&
		!valueStr.startsWith('"') &&
		!valueStr.startsWith('@')
	) {
		return valueStr;
	}

	const result = parseJsonInput({
		positional: valueStr,
		file: argv.file,
		hasStdin: stdinContent !== undefined,
		stdinContent,
	});

	if (result.error) {
		outputError(result.error.message);
		process.exitCode = 1;
		return undefined;
	}

	return result.data;
}

/**
 * @example
 * ```bash
 * epicenter kv get theme
 * epicenter kv set theme '"dark"'
 * epicenter kv set config @config.json
 * epicenter kv delete theme
 * ```
 */
export const kvCommand = defineCommand({
	command: 'kv <action>',
	describe: 'Manage key-value store',
	builder: (yargs: Argv) =>
		withWorkspaceOptions(yargs)
			.command({
				command: 'get <key>',
				describe: 'Get a value by key',
				builder: (y: Argv) =>
					y
						.positional('key', {
							type: 'string',
							demandOption: true,
						})
						.options(formatYargsOptions()),
				handler: async (argv: any) => {
					await runCommand(
						{ dir: argv.dir, workspaceId: argv.workspace },
						(client) => client.kv.get(argv.key),
						argv.format,
					);
				},
			} as unknown as CommandModule)
			.command({
				command: 'set <key> [value]',
				describe: 'Set a value by key',
				builder: (y: Argv) =>
					y
						.positional('key', {
							type: 'string',
							demandOption: true,
						})
						.positional('value', {
							type: 'string',
							description: 'JSON value or @file',
						})
						.option('file', {
							type: 'string',
							description: 'Read value from file',
						})
						.options(formatYargsOptions()),
				handler: async (argv: any) => {
					const parsed = resolveInputValue(argv);
					if (parsed === undefined) return;
					await runCommand(
						{ dir: argv.dir, workspaceId: argv.workspace },
						(client) => {
							client.kv.set(argv.key, parsed);
							return {
								status: 'set',
								key: argv.key,
								value: parsed,
							};
						},
						argv.format,
					);
				},
			} as unknown as CommandModule)
			.command({
				command: 'delete <key>',
				aliases: ['reset'],
				describe: 'Delete a value by key (reset to default)',
				builder: (y: Argv) =>
					y
						.positional('key', {
							type: 'string',
							demandOption: true,
						})
						.options(formatYargsOptions()),
				handler: async (argv: any) => {
					await runCommand(
						{ dir: argv.dir, workspaceId: argv.workspace },
						(client) => {
							client.kv.delete(argv.key);
							return { status: 'deleted', key: argv.key };
						},
						argv.format,
					);
				},
			} as unknown as CommandModule)
			.demandCommand(1, 'Specify an action: get, set, delete'),
	handler: () => {},
});
