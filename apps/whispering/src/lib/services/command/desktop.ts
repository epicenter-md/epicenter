import { invoke } from '@tauri-apps/api/core';
import { type ChildProcess } from '@tauri-apps/plugin-shell';
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
		 * Uses Tauri's Command API directly to properly maintain stdin/stdout/stderr handles.
		 * On Windows, uses CREATE_NO_WINDOW flag to prevent console window flash.
		 * Returns a Child instance that can be used to control the process.
		 *
		 * @see https://github.com/epicenter-md/epicenter/issues/815
		 */
		async spawn(command) {
			console.log('[TS] spawn: starting command:', command);
			const { data, error } = await tryAsync({
				try: async () => {
					const { Command } = await import('@tauri-apps/plugin-shell');

					// Parse command string into program and args
					const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
					const program = parts[0]?.replace(/"/g, '') || '';
					const args = parts.slice(1).map(arg => arg.replace(/"/g, ''));

					console.log('[TS] spawn: program:', program, 'args:', args);

					// Create command with proper options
					const cmd = await Command.create(program, args, {
						// TEMPORARY: Commented out for debugging
						// encoding: 'utf-8',
					});

					// Spawn returns a Child with proper stdin/stdout/stderr handles
					const child = await cmd.spawn();
					console.log('[TS] spawn: spawned with PID:', child.pid);
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
