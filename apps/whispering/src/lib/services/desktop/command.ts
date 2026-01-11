import { invoke } from '@tauri-apps/api/core';
import type { Child, ChildProcess } from '@tauri-apps/plugin-shell';
import type { Brand } from 'wellcrafted/brand';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';

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

export const CommandServiceLive = {
	/**
	 * Execute a command and wait for it to complete.
	 *
	 * Commands are parsed and executed directly without shell wrappers on all platforms.
	 * On Windows, uses CREATE_NO_WINDOW flag to prevent console window flash.
	 *
	 * @param command - The command to execute (e.g., "ffmpeg -version")
	 * @returns The command output (stdout/stderr/exit code) or an error
	 * @see https://github.com/EpicenterHQ/epicenter/issues/815
	 */
	async execute(command: ShellCommand) {
		console.log('[TS] execute: starting command:', command);
		const { data, error } = await tryAsync({
			try: async () => {
				// Rust returns CommandOutput which matches ChildProcess<string> structure
				const result = await invoke<ChildProcess<string>>('execute_command', {
					command,
				});
				console.log('[TS] execute: completed with code:', result.code);
				return result;
			},
			catch: (error) => {
				console.error('[TS] execute: error:', error);
				return CommandServiceErr({
					message: 'Failed to execute command',
				});
			},
		});

		if (error) return Err(error);
		return Ok(data);
	},

	/**
	 * Spawn a child process without waiting for it to complete.
	 *
	 * Commands are parsed and executed directly without shell wrappers on all platforms.
	 * On Windows, uses CREATE_NO_WINDOW flag to prevent console window flash.
	 * Returns a Child instance that can be used to control the process.
	 *
	 * @param command - The command to spawn (e.g., "ffmpeg -f avfoundation -i :0 output.wav")
	 * @returns A Child process handle or an error
	 * @see https://github.com/EpicenterHQ/epicenter/issues/815
	 */
	async spawn(command: ShellCommand) {
		console.log('[TS] spawn: starting command:', command);
		const { data, error } = await tryAsync({
			try: async () => {
				// Rust returns just the PID (u32)
				const pid = await invoke<number>('spawn_command', { command });
				console.log('[TS] spawn: received PID:', pid);

				// Wrap the PID in a Child instance for process control
				const { Child } = await import('@tauri-apps/plugin-shell');
				const child = new Child(pid);
				console.log('[TS] spawn: wrapped PID in Child instance');
				return child as Child;
			},
			catch: (error) => {
				console.error('[TS] spawn: error:', error);
				return CommandServiceErr({
					message: `Failed to spawn command: ${extractErrorMessage(error)}`,
				});
			},
		});

		if (error) return Err(error);
		return Ok(data);
	},
};

export type CommandService = typeof CommandServiceLive;
