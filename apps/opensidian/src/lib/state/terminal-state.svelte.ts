import { createPersistedState } from '@epicenter/svelte';
import { type } from 'arktype';
import { defineCommand } from 'just-bash';
import { Ok, tryAsync } from 'wellcrafted/result';
import { bash, fs } from '$lib/client';
import { fsState } from '$lib/state/fs-state.svelte';

/**
 * A single entry in the terminal history.
 *
 * Input entries show the command the user typed (rendered with a `$` prompt).
 * Output entries carry the result of executing that command—stdout, stderr,
 * and the process exit code.
 */
type TerminalEntry =
	| { type: 'input'; command: string }
	| { type: 'output'; stdout: string; stderr: string; exitCode: number };

/**
 * Reactive terminal state singleton.
 *
 * Follows the same factory pattern as `fs-state.svelte.ts`: a factory
 * function creates all `$state` and exposes a public API via a returned
 * object with getters. Components import the singleton and read directly.
 *
 * Manages:
 * - **History**: scrollable list of input/output entries
 * - **Command recall**: arrow-up/down cycles through previously executed commands
 * - **Execution**: delegates to `bash.exec()` from workspace.ts
 * - **Visibility**: open/closed state for the terminal panel
 *
 * @example
 * ```svelte
 * <script>
 *   import { terminalState } from '$lib/state/terminal-state.svelte';
 *   terminalState.open // reactive boolean
 * </script>
 * ```
 */
function createTerminalState() {
	const openState = createPersistedState({
		key: 'opensidian.terminal-open',
		schema: type('boolean'),
		defaultValue: false,
	});
	let history = $state<TerminalEntry[]>([]);
	let commandHistory = $state<string[]>([]);
	let historyIndex = $state(-1);
	let running = $state(false);

	// ── Custom commands ──────────────────────────────────────────────
	// Registered once at singleton creation via bash.registerCommand().
	// Uses registerCommand() instead of the constructor's customCommands
	// option to avoid a circular dependency (workspace → fs-state).

	bash.registerCommand(
		defineCommand('open', async (args) => {
			const path = args[0];
			if (!path)
				return {
					stdout: '',
					stderr: 'Usage: open <path>',
					exitCode: 1,
				};
			const id = fs.lookupId(path);
			if (!id)
				return {
					stdout: '',
					stderr: `No such file: ${path}`,
					exitCode: 1,
				};
			fsState.selectFile(id);
			return { stdout: `Opened ${path}\n`, stderr: '', exitCode: 0 };
		}),
	);
	const WELCOME_MESSAGE = [
		'Welcome to OpenSidian \u2014 notes on CRDTs with a bash terminal.',
		'',
		'Try these:',
		'  echo "# Hello HN" > /hello.md    create a file',
		'  ls /                              list files',
		'  open /hello.md                    open in editor',
		'  cat /hello.md                     print contents',
		'',
		'80+ commands: awk, sed, grep, jq, find, sqlite3, curl, and more.',
		'Press \u2318` to toggle this terminal.',
	].join('\n');

	function ensureWelcome() {
		if (history.length === 0) {
			history = [
				{
					type: 'output',
					stdout: WELCOME_MESSAGE + '\n',
					stderr: '',
					exitCode: 0,
				},
			];
		}
	}

	// If terminal was persisted as open, show welcome on load.
	if (openState.current) ensureWelcome();

	return {
		get open() {
			return openState.current;
		},
		get history() {
			return history;
		},
		get running() {
			return running;
		},

		/** Toggle the terminal panel open/closed. */
		toggle() {
			openState.current = !openState.current;
			if (openState.current) ensureWelcome();
		},

		/** Show the terminal panel. */
		show() {
			openState.current = true;
			ensureWelcome();
		},

		/** Hide the terminal panel. */
		hide() {
			openState.current = false;
		},

		/**
		 * Execute a command against the Yjs virtual filesystem.
		 *
		 * Appends an input entry, runs `bash.exec()`, then appends the
		 * output entry. No-ops if the command is blank or another command
		 * is already running.
		 *
		 * @example
		 * ```typescript
		 * await terminalState.exec('echo "hello" > /greeting.md');
		 * await terminalState.exec('cat /greeting.md');
		 * // history now has 4 entries: input, output, input, output
		 * ```
		 */
		async exec(command: string) {
			if (!command.trim() || running) return;
			running = true;
			history = [...history, { type: 'input', command }];
			commandHistory = [...commandHistory, command];
			historyIndex = -1;
			const { data: entry } = await tryAsync({
				try: async () => {
					const result = await bash.exec(command);
					return {
						type: 'output' as const,
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					};
				},
				catch: (err) =>
					Ok({
						type: 'output' as const,
						stdout: '',
						stderr: err instanceof Error ? err.message : 'Unknown error',
						exitCode: 1,
					}),
			});
			history = [...history, entry];
			running = false;
		},

		/**
		 * Recall the previous command (arrow-up behavior).
		 *
		 * Returns the command string, or `undefined` if at the end of history.
		 */
		previousCommand(): string | undefined {
			if (commandHistory.length === 0) return undefined;
			if (historyIndex === -1) {
				historyIndex = commandHistory.length - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
			return commandHistory[historyIndex];
		},

		/**
		 * Recall the next command (arrow-down behavior).
		 *
		 * Returns the command string, or `undefined` to clear the input
		 * (user has moved past the most recent command).
		 */
		nextCommand(): string | undefined {
			if (historyIndex === -1) return undefined;
			if (historyIndex < commandHistory.length - 1) {
				historyIndex++;
				return commandHistory[historyIndex];
			}
			historyIndex = -1;
			return undefined;
		},

		/** Clear all terminal output history. */
		clear() {
			history = [];
		},

		/** Print a welcome message as a single output entry. */
		printWelcome() {
			ensureWelcome();
		},
	};
}

export const terminalState = createTerminalState();
