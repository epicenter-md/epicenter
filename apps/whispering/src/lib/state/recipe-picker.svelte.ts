/**
 * Reactive state for the in-app Recipe picker: the command-palette surface the
 * `openRecipePicker` / `runRecipeOnClipboard` shortcuts raise.
 *
 * Lives outside any component because two owners touch it: the operations
 * (imperative; capture the source text, then `open(input)`) and the mounted
 * `<RecipePicker>` component (reactive; reads `isOpen`/`source`, runs the chosen
 * recipe, then `close()`). A module-level rune is the shared seam, the same shape
 * the Polish HUD uses.
 *
 * This is the in-app step on the way to a floating picker window: the operations
 * focus the main window before opening, so the palette is visible even when the
 * shortcut fired from another app. See ADR 0046.
 */
let isOpen = $state(false);
let source = $state('');

export const recipePicker = {
	/** Whether the picker is currently showing. Reactive. */
	get isOpen(): boolean {
		return isOpen;
	},

	/** The captured text the chosen recipe will run on (selection or clipboard). */
	get source(): string {
		return source;
	},

	/** Open the picker over `input` (the captured selection or clipboard text). */
	open(input: string): void {
		source = input;
		isOpen = true;
	},

	/** Close the picker and drop the captured source. */
	close(): void {
		isOpen = false;
		source = '';
	},
};
