import type { SatisfiedCommand, ShortcutEventState } from '$lib/commands';
import { openRecipePicker } from '$lib/operations/recipe-picker';

/**
 * Desktop-only commands, spread into the registry by the `#platform/commands`
 * seam on Tauri builds. Keeping the picker here (rather than in the shared
 * `commands.ts`) is what stops a browser build from importing the Tauri-only
 * picker window and from offering a shortcut that can only error on the web.
 */
export const platformCommands = [
	{
		id: 'openRecipePicker',
		title: 'Open recipe picker',
		// Fire on release, not press: the global accelerator carries a Cmd/Ctrl+Shift
		// chord, and capturing on press synthesizes Cmd/Ctrl+C while that chord is
		// still held, so the foreground app sees Cmd+Shift+C instead of a clean copy.
		// Register both states (not Released-only) because the local shortcut manager
		// only arms a command on keydown when `on` includes 'Pressed'; without it the
		// in-app shortcut would never fire. The callback guard runs once, on release.
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Released' || state === undefined) openRecipePicker();
		},
	},
] as const satisfies SatisfiedCommand[];
