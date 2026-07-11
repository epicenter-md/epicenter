import { recipePicker } from '$lib/state/recipe-picker.svelte';

/** Present the picker inside the already-visible browser page. */
export async function presentRecipePicker(input: string): Promise<void> {
	recipePicker.open(input);
}
