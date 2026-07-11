import { getCurrentWindow } from '@tauri-apps/api/window';
import { recipePicker } from '$lib/state/recipe-picker.svelte';

/** Raise Epicenter before presenting Whispering's in-app recipe picker. */
export async function presentRecipePicker(input: string): Promise<void> {
	const window = getCurrentWindow();
	await window.show();
	await window.setFocus();
	recipePicker.open(input);
}
