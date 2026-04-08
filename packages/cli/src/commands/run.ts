/**
 * `epicenter run <action> [--args]` — invoke a workspace action by dot-path.
 *
 * Finds the action using `iterateActions()`, converts its TypeBox input schema
 * to CLI flags via `typeboxToYargsOptions()`, calls the action, and outputs
 * the result.
 */

import type { Action } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { Argv } from 'yargs';
import {
	defineCommand,
	runCommand,
	withWorkspaceOptions,
} from '../util/command';
import { typeboxToYargsOptions } from '../util/typebox-to-yargs';

/**
 * @example
 * ```bash
 * epicenter run posts.getAll
 * epicenter run posts.create --title "Hello World"
 * epicenter run posts.create --title "Hi" -w my-blog
 * ```
 */
export const runActionCommand = defineCommand({
	command: 'run <action>',
	describe: 'Invoke a workspace action by dot-path',
	builder: (y: Argv) =>
		withWorkspaceOptions(y)
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Action path in dot notation (e.g. posts.create)',
			})
			.strict(false),
	handler: async (argv: any) => {
		const actionPath = (argv.action as string).split('.');

		await runCommand(
			{ dir: argv.dir, workspaceId: argv.workspace },
			async (client) => {
				if (!client.actions) {
					throw new Error('This workspace has no actions defined');
				}

				// Find action by dot-path
				let found: Action | undefined;
				for (const [action, path] of iterateActions(client.actions)) {
					if (path.join('.') === actionPath.join('.')) {
						found = action;
						break;
					}
				}

				if (!found) {
					const available: string[] = [];
					for (const [, path] of iterateActions(client.actions)) {
						available.push(path.join('.'));
					}
					const msg =
						available.length > 0
							? `Action "${argv.action}" not found. Available actions:\n  ${available.join('\n  ')}`
							: `Action "${argv.action}" not found. No actions defined in this workspace.`;
					throw new Error(msg);
				}

				// Build input from CLI args if action has input schema
				let input: Record<string, unknown> | undefined;
				if (found.input) {
					const yargsOpts = typeboxToYargsOptions(found.input);
					input = {};
					for (const key of Object.keys(yargsOpts)) {
						if (argv[key] !== undefined) {
							input[key] = argv[key];
						}
					}
				}

				if (input) {
					return await found(input);
				}
				return await (found as Action<undefined>)();
			},
			argv.format,
		);
	},
});
