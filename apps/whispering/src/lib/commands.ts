import { platformCommands } from '#platform/commands';
import { runRecipeOnClipboard } from '$lib/operations/recipe-clipboard';
import {
	cancelRecording,
	startManualRecording,
	stopManualRecording,
	toggleManualRecording,
	toggleVadRecording,
} from '$lib/operations/recording';

/**
 * Registry of available commands in the application.
 * Defines what commands exist and how they're triggered (keyboard shortcuts,
 * voice, command palette, etc.).
 *
 * The actual command implementations live in $lib/operations/* as plain async
 * functions that can be invoked from anywhere in the UI, not just through this
 * command registry.
 *
 * Platform split: `sharedCommands` exist in every build. Desktop-only commands
 * (the recipe picker, which captures a selection from another app and opens a
 * Tauri window) come from the `#platform/commands` seam, so a browser build
 * never imports their Tauri-only code and never offers them as shortcuts.
 */

/**
 * The keyboard event state passed to callbacks: a trigger backend reports
 * either the press or the release edge. Both the desktop rdev backend (which
 * emits the generated `TriggerState`) and the browser keydown backend speak
 * this exact pair, so the command layer is the single point where they
 * converge.
 */
export type ShortcutEventState = 'Pressed' | 'Released';

export type SatisfiedCommand = {
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

/** Commands available in every build (browser and desktop). */
const sharedCommands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		// Hold to record, release to stop. Recording starts on the press and stops
		// on the release; both the desktop rdev backend and the browser keydown
		// backend emit this Pressed/Released pair. Stateless: the edges are the
		// whole state machine, so the routing is glue that lives with the command,
		// not an operation. Default global key is Fn (macOS) / Ctrl+Win (else).
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Pressed') return startManualRecording();
			if (state === 'Released') return stopManualRecording();
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		// Tap to start, tap to stop. This is also what the in-app record button
		// fires (a click arrives with no edge). Unbound globally by default:
		// push-to-talk owns the default recording key. Bind a key here for a
		// hands-free toggle, e.g. for long-form dictation.
		on: ['Pressed'],
		callback: () => toggleManualRecording(),
	},
	{
		id: 'cancelRecording',
		title: 'Cancel recording',
		on: ['Pressed'],
		callback: () => cancelRecording(),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: ['Pressed'],
		callback: () => toggleVadRecording(),
	},
	{
		id: 'runRecipeOnClipboard',
		title: 'Run recipe on clipboard',
		on: ['Pressed'],
		callback: () => runRecipeOnClipboard(),
	},
] as const satisfies SatisfiedCommand[];

export const commands = [
	...sharedCommands,
	...platformCommands,
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

export type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);

type TriggerTarget = {
	on: readonly ShortcutEventState[];
	callback: (state?: ShortcutEventState) => void;
};
const triggerTargetById = new Map<string, TriggerTarget>(
	commands.map((c) => [c.id, { on: c.on, callback: c.callback }]),
);

/**
 * The single convergence point for trigger backends. The desktop rdev listener
 * and the browser keydown manager both emit raw `(commandId, edge)` pairs into
 * here, so neither reimplements the `on` filter: an edge the command does not
 * subscribe to is dropped, the rest reach the callback. Direct invocations
 * (command palette, in-app buttons) bypass this and call `commandCallbacks`
 * with no edge.
 */
export function dispatchCommandTrigger(
	commandId: string,
	state: ShortcutEventState,
) {
	const target = triggerTargetById.get(commandId);
	if (!target?.on.includes(state)) return;
	target.callback(state);
}
