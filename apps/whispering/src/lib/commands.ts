import type { ShortcutEvent } from '@tauri-apps/plugin-global-shortcut';
import { rpc } from '$lib/query';

/**
 * Registry of available commands in the application.
 * Defines what commands exist and how they're triggered (keyboard shortcuts, voice, command palette, etc.).
 *
 * The actual command implementations live in /lib/query/actions.ts as reusable mutations
 * that can be invoked from anywhere in the UI, not just through this command registry.
 */

/**
 * The keyboard event state passed to callbacks.
 * Derived from Tauri's ShortcutEvent type for consistency.
 */
export type ShortcutEventState = ShortcutEvent['state'];

type SatisfiedCommand = {
	id: string;
	title: string;
	/**
	 * When to trigger the callback.
	 * - ['Pressed']: Only on key press
	 * - ['Released']: Only on key release
	 * - ['Pressed', 'Released']: On both press and release
	 */
	on: ShortcutEventState[];
	callback: (state?: ShortcutEventState) => void;
};

export const commands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Pressed') {
				rpc.commands.startManualRecording(undefined);
			} else if (state === 'Released') {
				rpc.commands.stopManualRecording(undefined);
			}
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		on: ['Pressed'],
		callback: () => rpc.commands.toggleManualRecording(undefined),
	},
	{
		id: 'startManualRecording',
		title: 'Start recording',
		on: ['Pressed'],
		callback: () => rpc.commands.startManualRecording(undefined),
	},
	{
		id: 'stopManualRecording',
		title: 'Stop recording',
		on: ['Pressed'],
		callback: () => rpc.commands.stopManualRecording(undefined),
	},
	{
		id: 'cancelManualRecording',
		title: 'Cancel recording',
		on: ['Pressed'],
		callback: () => rpc.commands.cancelManualRecording(undefined),
	},
	{
		id: 'startVadRecording',
		title: 'Start voice activated recording',
		on: ['Pressed'],
		callback: () => rpc.commands.startVadRecording(undefined),
	},
	{
		id: 'stopVadRecording',
		title: 'Stop voice activated recording',
		on: ['Pressed'],
		callback: () => rpc.commands.stopVadRecording(undefined),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: ['Pressed'],
		callback: () => rpc.commands.toggleVadRecording(undefined),
	},
	{
		id: 'openTransformationPicker',
		title: 'Open transformation picker',
		on: ['Pressed'],
		callback: () => rpc.commands.openTransformationPicker(undefined),
	},
	{
		id: 'runTransformationOnClipboard',
		title: 'Run transformation on clipboard',
		on: ['Pressed'],
		callback: () => rpc.commands.runTransformationOnClipboard(undefined),
	},
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);
