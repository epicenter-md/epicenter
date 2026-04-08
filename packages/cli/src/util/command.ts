/**
 * CLI command infrastructure.
 *
 * Provides the building blocks every command file uses:
 * - `defineCommand` — type-narrowing identity function for command objects
 * - `withWorkspaceOptions` — adds `--dir`, `--workspace`, `--format` to yargs
 * - `runCommand` — one-shot workspace lifecycle with error handling
 * - `resolveTable` — table lookup by name
 */

import type { AnyWorkspaceClient } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig } from '../load-config';
import { formatYargsOptions, output, outputError } from './format-output';

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Identity function for defining a yargs command with full type inference.
 *
 * Same pattern as `defineConfig` in Vite or `defineStore` in Pinia—a
 * pass-through that narrows the type without any runtime overhead.
 *
 * @example
 * ```typescript
 * export const listCommand = defineCommand({
 *   command: 'list <table>',
 *   describe: 'List all valid rows in a table',
 *   builder: (y) => withWorkspaceOptions(y).positional('table', { type: 'string', demandOption: true }),
 *   handler: async (argv) => { ... },
 * });
 * ```
 */
export function defineCommand(command: CommandModule): CommandModule {
	return command;
}

// ─── withWorkspaceOptions ────────────────────────────────────────────────────

/**
 * Add the standard workspace-scoped options to a yargs builder.
 *
 * Every command that operates on a workspace needs `--dir` (project directory),
 * `--workspace` (workspace ID when config exports multiple), and `--format`
 * (output formatting). Call this in your `builder` to avoid duplicating the
 * option definitions across every command file.
 *
 * @example
 * ```typescript
 * builder: (y: Argv) =>
 *   withWorkspaceOptions(y)
 *     .positional('table', { type: 'string', demandOption: true }),
 * ```
 */
export function withWorkspaceOptions<T>(y: Argv<T>) {
	return y
		.option('dir', {
			type: 'string',
			default: '.',
			alias: 'C',
			description: 'Directory containing epicenter.config.ts',
		})
		.option('workspace', {
			type: 'string',
			alias: 'w',
			description: 'Workspace ID (required if config has multiple workspaces)',
		})
		.options(formatYargsOptions());
}

// ─── runCommand ──────────────────────────────────────────────────────────────

/**
 * Run a one-shot workspace command with full lifecycle and error handling.
 *
 * Loads the config → finds the workspace → awaits ready → runs the operation →
 * outputs the result → disposes the client. Catches errors and sets
 * `process.exitCode = 1` so command handlers are just a lambda.
 *
 * @example
 * ```typescript
 * await runCommand(
 *   { dir: argv.dir, workspaceId: argv.workspace },
 *   (client) => client.tables.notes.getAllValid(),
 *   argv.format,
 * );
 * ```
 */
export async function runCommand<T>(
	opts: { dir: string; workspaceId?: string },
	fn: (client: AnyWorkspaceClient) => T | Promise<T>,
	format?: 'json' | 'jsonl',
): Promise<void> {
	try {
		const { clients } = await loadConfig(opts.dir);
		const client = resolveWorkspace(clients, opts.workspaceId);
		await client.whenReady;

		try {
			const result = await fn(client);
			output(result, { format });
		} finally {
			await Promise.all(clients.map((c) => c.dispose()));
		}
	} catch (err) {
		outputError(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

// ─── resolveTable ────────────────────────────────────────────────────────────

/**
 * Resolve a table by name from a workspace client, or throw a clear error.
 *
 * @example
 * ```typescript
 * const table = resolveTable(client, 'posts');
 * const rows = table.getAllValid();
 * ```
 */
export function resolveTable(client: AnyWorkspaceClient, name: string) {
	const table = client.tables[name];
	if (!table) throw new Error(`Table "${name}" not found`);
	return table;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the right workspace from loaded clients, or throw.
 *
 * Exported for commands that need manual lifecycle control (e.g. `rpc`).
 * Most commands should use `runCommand` instead.
 */
export function resolveWorkspace(
	clients: AnyWorkspaceClient[],
	workspaceId?: string,
): AnyWorkspaceClient {
	if (workspaceId) {
		const found = clients.find((c) => c.id === workspaceId);
		if (!found) {
			const ids = clients.map((c) => c.id).join(', ');
			throw new Error(
				`Workspace "${workspaceId}" not found. Available: ${ids}`,
			);
		}
		return found;
	}

	if (clients.length === 1) return clients[0]!;

	const ids = clients.map((c) => c.id).join(', ');
	throw new Error(
		`Multiple workspaces found. Specify one with --workspace: ${ids}`,
	);
}
