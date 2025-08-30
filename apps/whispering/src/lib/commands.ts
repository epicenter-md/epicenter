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
	{
		id: 'toggleOutputLanguage',
		title: 'Cycle through favorite output languages',
		on: 'Pressed',
		callback: () => rpc.commands.toggleOutputLanguage.execute(undefined),
	},
	{
		id: 'setOutputLanguageSlot1',
		title: 'Switch to favorite language #1',
		on: 'Pressed',
		callback: () => rpc.commands.setOutputLanguageSlot.execute({ slot: 1 }),
	},
	{
		id: 'setOutputLanguageSlot2',
		title: 'Switch to favorite language #2',
		on: 'Pressed',
		callback: () => rpc.commands.setOutputLanguageSlot.execute({ slot: 2 }),
	},
	{
		id: 'setOutputLanguageSlot3',
		title: 'Switch to favorite language #3',
		on: 'Pressed',
		callback: () => rpc.commands.setOutputLanguageSlot.execute({ slot: 3 }),
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
