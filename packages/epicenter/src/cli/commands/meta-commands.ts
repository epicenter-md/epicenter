import type { CommandModule } from 'yargs';
import type { AnyWorkspaceClient } from '../discovery.js';
import { formatYargsOptions, output } from '../format-output.js';

/**
 * Build meta commands (tables).
 */
export function buildMetaCommands(client: AnyWorkspaceClient): CommandModule[] {
	return [
		{
			command: 'tables',
			describe: 'List all table names',
			builder: (yargs) => yargs.options(formatYargsOptions()),
			handler: (argv) => {
				const tableNames = Object.keys(client.definitions.tables);
				output(tableNames, { format: argv.format as any });
			},
		},
	];
}
