import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { recipePicker } from '$lib/state/recipe-picker.svelte';

/**
 * Read the clipboard, then raise the in-app recipe picker over it. The user
 * picks a recipe and the picker runs it on the clipboard text. On desktop the
 * Whispering window is focused first so the palette is visible even when the
 * shortcut fired from another app; on web the picker just opens. See ADR 0046.
 */
export async function runRecipeOnClipboard() {
	const { data: clipboard, error } = await services.text.readFromClipboard();
	if (error) {
		report.error({ title: "Couldn't read your clipboard", cause: error });
		return;
	}
	const input = clipboard?.trim() ? clipboard : '';
	if (!input) {
		report.info({
			title: 'Your clipboard is empty',
			description: 'Copy some text, then run a recipe on it.',
		});
		return;
	}
	await tauri?.mainWindow.focus();
	recipePicker.open(input);
}
