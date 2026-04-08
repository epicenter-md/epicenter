import { homedir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { createAuthCommand } from './commands/auth';
import {
	countCommand,
	deleteCommand,
	exportCommand,
	getCommand,
	listCommand,
	tablesCommand,
} from './commands/data';
import { describeCommand } from './commands/describe';
import { kvCommand } from './commands/kv';
import { initCommand } from './commands/project';
import { rpcCommand } from './commands/rpc';
import { runActionCommand } from './commands/run';
import { sizeCommand } from './commands/size';
import { startCommand } from './commands/start';

/** Resolution order: EPICENTER_HOME env > ~/.epicenter/ */
export function resolveEpicenterHome(flagValue?: string): string {
	return flagValue ?? Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Create the Epicenter CLI instance.
 *
 * Registers all top-level commands: table CRUD (get, list, count, delete),
 * tables, kv, export, init, run, describe, start, and auth.
 *
 * @returns An object with a `run` method that parses and executes CLI commands.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const home = resolveEpicenterHome();

			const cli = yargs()
				.scriptName('epicenter')
				.command(startCommand)
				.command(getCommand)
				.command(listCommand)
				.command(countCommand)
				.command(deleteCommand)
				.command(tablesCommand)
				.command(kvCommand)
				.command(exportCommand)
				.command(initCommand)
				.command(runActionCommand)
				.command(describeCommand)
				.command(sizeCommand)
				.command(rpcCommand)
				.command(createAuthCommand(home))
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
