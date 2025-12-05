import type { Child, ChildProcess } from '@tauri-apps/plugin-shell';
import type { Brand } from 'wellcrafted/brand';
import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

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
	 * Execute a command and return the output.
	 *
	 * Commands are parsed and executed directly without shell wrappers.
	 * PATH resolution works automatically on all platforms.
	 * On Windows, prevents console window flash using CREATE_NO_WINDOW flag.
	 *
	 * @param command - The command to execute (e.g., "ffmpeg -version")
	 * @returns The command output (stdout/stderr/exit code) or an error
	 */
	execute: (
		command: ShellCommand,
	) => Promise<Result<ChildProcess<string>, CommandServiceError>>;

	/**
	 * Spawn a command as a child process without waiting for it to complete.
	 *
	 * Commands are parsed and executed directly without shell wrappers.
	 * PATH resolution works automatically on all platforms.
	 * On Windows, prevents console window flash using CREATE_NO_WINDOW flag.
	 *
	 * The returned Child process can be used to write to stdin and kill the process.
	 *
	 * @param command - The command to spawn (e.g., "ffmpeg -f avfoundation -i :0 output.wav")
	 * @returns A Child process handle or an error
	 */
	spawn: (command: ShellCommand) => Promise<Result<Child, CommandServiceError>>;
};
