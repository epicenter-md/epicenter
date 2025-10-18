import { invoke } from '@tauri-apps/api/core';
import { type ChildProcess, Command } from '@tauri-apps/plugin-shell';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CommandService, ShellCommand } from './types';
import { CommandServiceErr } from './types';

export function createCommandServiceDesktop(): CommandService {
	return {
		/**
		 * Execute a command and wait for it to complete.
		 *
		 * Commands are parsed and executed directly without shell wrappers on all platforms.
		 * On Windows, uses CREATE_NO_WINDOW flag to prevent console window flash.
		 *
		 * @see https://github.com/epicenter-md/epicenter/issues/815
		 */
		async execute(command) {
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
						context: { command },
						cause: error,
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
		 * @see https://github.com/epicenter-md/epicenter/issues/815
		 */
		async spawn(command) {
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
					return child;
				},
				catch: (error) => {
					console.error('[TS] spawn: error:', error);
					return CommandServiceErr({
						message: `Failed to spawn command: ${extractErrorMessage(error)}`,
						context: { command },
						cause: error,
					});
				},
			});

			if (error) return Err(error);
			return Ok(data);
		},
	};
}
