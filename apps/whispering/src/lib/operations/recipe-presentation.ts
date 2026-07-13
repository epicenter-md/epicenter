import { environment } from '#runtime';
import { recipePicker } from '$lib/state/recipe-picker.svelte';

/** Raise the app surface, then present the in-app recipe picker over `input`. */
export async function presentRecipePicker(input: string): Promise<void> {
	await environment.reveal();
	recipePicker.open(input);
}
