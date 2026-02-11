#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import { Err, tryAsync } from 'wellcrafted/result';
import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';
import { resolveWorkspace } from './discovery';

// ═══════════════════════════════════════════════════════════════════════════
// DIRECTORY FLAG PARSING
// ═══════════════════════════════════════════════════════════════════════════

type DirectoryParseResult =
	| { ok: true; baseDir: string; remainingArgs: string[] }
	| { ok: false; error: string };

/**
 * Parse -C/--dir flag from argv BEFORE yargs processes subcommands.
 */
export function parseDirectoryFlag(argv: string[]): DirectoryParseResult {
	let baseDir = process.cwd();
	const remainingArgs: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		// Handle -C <dir> or --dir <dir>
		if (arg === '-C' || arg === '--dir') {
			const nextArg = argv[i + 1];
			if (!nextArg || nextArg.startsWith('-')) {
				return { ok: false, error: `${arg} requires a directory argument` };
			}
			baseDir = resolve(nextArg);
			i++;
			continue;
		}

		// Handle -C=<dir> or --dir=<dir>
		if (arg.startsWith('-C=')) {
			baseDir = resolve(arg.slice(3));
			continue;
		}
		if (arg.startsWith('--dir=')) {
			baseDir = resolve(arg.slice(6));
			continue;
		}

		remainingArgs.push(arg);
	}

	return { ok: true, baseDir, remainingArgs };
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION (testable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main orchestration logic - pure and testable.
 */
export async function run(argv: string[]): Promise<void> {
	const parsed = parseDirectoryFlag(argv);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}

	const resolution = await resolveWorkspace(parsed.baseDir);

	if (resolution.status === 'not_found') {
		throw new Error(
			'No epicenter.config.ts found.\n' +
				'Create one: export default createWorkspaceClient({...})',
		);
	}

	if (resolution.status === 'ambiguous') {
		const lines = [
			'No epicenter.config.ts found in current directory.',
			'',
			'Found configs in subdirectories:',
			...resolution.configs.map((c) => `  - ${c}`),
			'',
			'Use -C <dir> to specify which project:',
			`  epicenter -C ${dirname(resolution.configs[0]!)} <command>`,
		];
		throw new Error(lines.join('\n'));
	}

	await createCLI(resolution.client).run(parsed.remainingArgs);
}

// ═══════════════════════════════════════════════════════════════════════════
// WATCH MODE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Re-exec with bun --watch if not already in watch mode.
 * Returns the exit code from the child process, or null to continue.
 */
async function maybeSpawnWatchMode(): Promise<number | null> {
	if (process.env.EPICENTER_WATCH_MODE || process.env.EPICENTER_NO_WATCH) {
		return null;
	}

	const scriptPath = process.argv[1];
	if (!scriptPath) {
		return null;
	}

	const proc = Bun.spawn(
		['bun', '--watch', scriptPath, ...process.argv.slice(2)],
		{
			env: { ...process.env, EPICENTER_WATCH_MODE: '1' },
			stdio: ['inherit', 'inherit', 'inherit'],
		},
	);

	await proc.exited;
	return proc.exitCode ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
	const watchExitCode = await maybeSpawnWatchMode();
	if (watchExitCode !== null) {
		process.exit(watchExitCode);
	}

	const result = await tryAsync({
		try: () => run(hideBin(process.argv)),
		catch: (error) => Err(String(error)),
	});

	if (result.error) {
		console.error('Error:', result.error);
		process.exit(1);
	}
}

main();
