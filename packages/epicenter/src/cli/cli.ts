import yargs from 'yargs';
import { createServer, DEFAULT_PORT } from '../server/server';
import { buildActionCommands } from './command-builder';
import { buildKvCommands } from './commands/kv-commands';
import { buildMetaCommands } from './commands/meta-commands';
import { buildTableCommands } from './commands/table-commands';
import type { AnyWorkspaceClient } from './discovery';

export function createCLI(client: AnyWorkspaceClient) {
	let cli = yargs()
		.scriptName('epicenter')
		.usage('Usage: $0 <command> [options]')
		.help()
		.version()
		.strict()
		.command(
			'serve',
			'Start HTTP server with REST and WebSocket sync endpoints',
			(yargs) =>
				yargs.option('port', {
					type: 'number',
					description: 'Port to run the server on',
					default: DEFAULT_PORT,
				}),
			(argv) => {
				createServer(client, {
					port: argv.port,
				}).start();
			},
		);

	// Add meta commands (tables, workspaces)
	const metaCommands = buildMetaCommands(client);
	for (const cmd of metaCommands) {
		cli = cli.command(cmd);
	}

	// Add table commands for each table in each workspace
	const tableCommands = buildTableCommands(client);
	for (const cmd of tableCommands) {
		cli = cli.command(cmd);
	}

	// Add KV commands
	const kvCommands = buildKvCommands(client);
	for (const cmd of kvCommands) {
		cli = cli.command(cmd);
	}

	// Add action commands from client.actions
	if (client.actions) {
		const commands = buildActionCommands(client.actions);
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}
	}

	return {
		async run(argv: string[]) {
			const cleanup = async () => {
				await client.destroy();
				process.exit(0);
			};
			process.on('SIGINT', cleanup);
			process.on('SIGTERM', cleanup);

			try {
				await cli.parse(argv);
			} finally {
				process.off('SIGINT', cleanup);
				process.off('SIGTERM', cleanup);
				await client.destroy();
			}
		},
	};
}
