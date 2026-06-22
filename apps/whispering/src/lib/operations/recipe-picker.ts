import { tauri } from '#platform/tauri';
import { captureSelection } from '$lib/operations/selection';
import { report } from '$lib/report';
import { recipePicker } from '$lib/state/recipe-picker.svelte';

/**
 * Capture the foreground app's current selection, then raise the in-app recipe
 * picker over it. The capture (a synthetic copy) runs while the other app is
 * still focused; only then do we focus Whispering's window so the palette is
 * visible. The user picks a recipe and the picker runs it on the selection.
 *
 * Desktop only (registered through the Tauri command seam). A future floating
 * picker window will drop the window-focus step. See ADR 0046.
 */
export async function openRecipePicker() {
	const { data: selection, error } = await captureSelection();
	if (error) {
		report.error({ title: "Couldn't read your selection", cause: error });
		return;
	}
	const input = selection?.trim() ? selection : '';
	if (!input) {
		report.info({
			title: 'Nothing selected',
			description:
				'Select some text, then open the recipe picker to reshape it.',
		});
		return;
	}
	await tauri?.mainWindow.focus();
	recipePicker.open(input);
}
