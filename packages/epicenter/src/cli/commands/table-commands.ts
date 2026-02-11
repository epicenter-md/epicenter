import type { CommandModule } from 'yargs';
import type { AnyWorkspaceClient } from '../discovery.js';
import { formatYargsOptions, output, outputError } from '../format-output.js';
import { parseJsonInput, readStdinSync } from '../parse-input.js';

/**
 * Build yargs commands for all tables in a workspace.
 */
export function buildTableCommands(
	client: AnyWorkspaceClient,
): CommandModule[] {
	const commands: CommandModule[] = [];
	const tableNames = Object.keys(client.definitions.tables);

	for (const tableName of tableNames) {
		const tableHelper = (client.tables as Record<string, unknown>)[tableName];
		commands.push(buildTableCommand(tableName, tableHelper));
	}

	return commands;
}

function buildTableCommand(
	tableName: string,
	tableHelper: any, // TableHelper<any>
): CommandModule {
	return {
		command: `${tableName} <action>`,
		describe: `Manage ${tableName} table`,
		builder: (yargs) => {
			return yargs
				.command({
					command: 'list',
					describe: 'List all valid rows',
					builder: (y) =>
						y
							.option('all', {
								type: 'boolean',
								description: 'Include invalid rows',
							})
							.options(formatYargsOptions()),
					handler: (argv) => {
						const rows = argv.all
							? tableHelper.getAll()
							: tableHelper.getAllValid();
						output(rows, { format: argv.format as any });
					},
				})
				.command({
					command: 'get <id>',
					describe: 'Get a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: (argv) => {
						const result = tableHelper.get(argv.id as string);
						if (result.status === 'not_found') {
							outputError(`Row not found: ${argv.id}`);
							process.exitCode = 1;
							return;
						}
						output(result, { format: argv.format as any });
					},
				})
				.command({
					command: 'set <id> [json]',
					describe: 'Create or replace a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.positional('json', {
								type: 'string',
								description: 'JSON row data or @file',
							})
							.option('file', { type: 'string', description: 'Read from file' })
							.options(formatYargsOptions()),
					handler: (argv) => {
						const id = argv.id;
						const stdinContent = readStdinSync();
						const result = parseJsonInput({
							positional: argv.json,
							file: argv.file,
							hasStdin: stdinContent !== undefined,
							stdinContent,
						});

						if (result.ok === false) {
							outputError(result.error);
							process.exitCode = 1;
							return;
						}

						const parsed = tableHelper.parse(id, result.data);
						if (parsed.status === 'invalid') {
							outputError('Invalid row data');
							output(parsed.errors, { format: argv.format as any });
							process.exitCode = 1;
							return;
						}

						tableHelper.set(parsed.row);
						output(parsed.row, { format: argv.format as any });
					},
				})
				.command({
					command: 'update <id>',
					describe:
						'Partial update a row using flags (e.g., --title "New Title")',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions())
							.strict(false), // Allow unknown flags as field updates
					handler: (argv) => {
						const id = argv.id as string;

						// Collect field updates from flags (exclude yargs internals)
						const reservedKeys = new Set([
							'_',
							'$0',
							'id',
							'format',
							'help',
							'version',
						]);
						const partial: Record<string, unknown> = {};

						for (const [key, value] of Object.entries(argv)) {
							if (!reservedKeys.has(key) && !key.includes('-')) {
								// Parse JSON values for objects/arrays, keep primitives as-is
								if (
									typeof value === 'string' &&
									(value.startsWith('{') || value.startsWith('['))
								) {
									try {
										partial[key] = JSON.parse(value);
									} catch {
										partial[key] = value;
									}
								} else {
									partial[key] = value;
								}
							}
						}

						if (Object.keys(partial).length === 0) {
							outputError(
								'No fields to update. Use flags like --title "New Title"',
							);
							process.exitCode = 1;
							return;
						}

						const updateResult = tableHelper.update(id, partial);
						if (updateResult.status === 'not_found') {
							outputError(`Row not found: ${id}`);
							process.exitCode = 1;
							return;
						}
						if (updateResult.status === 'invalid') {
							outputError(`Row is invalid and cannot be updated`);
							output(updateResult, { format: argv.format as any });
							process.exitCode = 1;
							return;
						}
						output(updateResult.row, { format: argv.format as any });
					},
				})
				.command({
					command: 'delete <id>',
					describe: 'Delete a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: (argv) => {
						const result = tableHelper.delete(argv.id as string);
						output(result, { format: argv.format as any });
					},
				})
				.command({
					command: 'clear',
					describe: 'Delete all rows',
					handler: () => {
						tableHelper.clear();
						output({ status: 'cleared' });
					},
				})
				.command({
					command: 'count',
					describe: 'Count rows',
					handler: () => {
						output({ count: tableHelper.count() });
					},
				})
				.demandCommand(
					1,
					'Specify an action: list, get, set, update, delete, clear, count',
				);
		},
		handler: () => {},
	};
}
