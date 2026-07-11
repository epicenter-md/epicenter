import { recipePicker } from '$lib/state/recipe-picker.svelte';
import { commands } from '$lib/tauri/commands';

/** Raise Epicenter before presenting Whispering's in-app recipe picker. */
export async function presentRecipePicker(input: string): Promise<void> {
	const { error } = await commands.revealWhisperingWindow();
	if (error !== null) throw new Error(error);
	recipePicker.open(input);
}
