import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Brand } from 'wellcrafted/brand';
import type { Child, ChildProcess } from '@tauri-apps/plugin-shell';

export const { CommandServiceError, CommandServiceErr } = createTaggedError(
	'CommandServiceError',
);
export type CommandServiceError = ReturnType<typeof CommandServiceError>;

/**
 * Branded type for shell commands that should be executed
 */
export type ShellCommand = string & Brand<'ShellCommand'>;

/**
 * Type assertion to mark a string as a shell command
 */
export function asShellCommand(str: string): ShellCommand {
	return str as ShellCommand;
}

export type CommandService = {
	/**
	 * Execute a shell command and return the output.
	 *
	 * The command is automatically wrapped with the appropriate shell for the platform:
	 * - Windows: `cmd /c <command>`
	 * - Unix/macOS: `sh -c <command>`
	 *
	 * This allows commands to use shell features like pipes, redirects, and PATH resolution.
	 *
	 * @param command - The shell command to execute
	 * @returns The command output (stdout/stderr) or an error
	 */
	execute: (
		command: ShellCommand,
	) => Promise<Result<ChildProcess<string>, CommandServiceError>>;

	/**
	 * Spawn a shell command as a child process.
	 *
	 * The command is automatically wrapped with the appropriate shell for the platform:
	 * - Windows: `cmd /c <command>`
	 * - Unix/macOS: `sh -c <command>`
	 *
	 * This allows long-running processes to be spawned and controlled (e.g., FFmpeg recording).
	 * The returned Child process can be used to write to stdin, read from stdout/stderr,
	 * and kill the process when needed.
	 *
	 * @param command - The shell command to spawn
	 * @returns A Child process handle or an error
	 */
	spawn: (command: ShellCommand) => Promise<Result<Child, CommandServiceError>>;
};
