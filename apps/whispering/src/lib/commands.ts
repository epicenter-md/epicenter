import { rpc } from '$lib/query';
import type { ShortcutTriggerState } from './services/_shortcut-trigger-state';

type SatisfiedCommand = {
	id: string;
	title: string;
	on: ShortcutTriggerState;
	callback: () => void;
};

export const commands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		on: 'Both',
		callback: () => rpc.commands.toggleManualRecording.execute(undefined),
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		on: 'Pressed',
		callback: () => rpc.commands.toggleManualRecording.execute(undefined),
	},
	{
		id: 'startManualRecording',
		title: 'Start recording',
		on: 'Pressed',
		callback: () => rpc.commands.startManualRecording.execute(undefined),
	},
	{
		id: 'stopManualRecording',
		title: 'Stop recording',
		on: 'Pressed',
		callback: () => rpc.commands.stopManualRecording.execute(undefined),
	},
	{
		id: 'cancelManualRecording',
		title: 'Cancel recording',
		on: 'Pressed',
		callback: () => rpc.commands.cancelManualRecording.execute(undefined),
	},
	{
		id: 'startVadRecording',
		title: 'Start voice activated recording',
		on: 'Pressed',
		callback: () => rpc.commands.startVadRecording.execute(undefined),
	},
	{
		id: 'stopVadRecording',
		title: 'Stop voice activated recording',
		on: 'Pressed',
		callback: () => rpc.commands.stopVadRecording.execute(undefined),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: 'Pressed',
		callback: () => rpc.commands.toggleVadRecording.execute(undefined),
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
