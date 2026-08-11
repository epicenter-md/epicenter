import { createContext } from 'svelte';
import type { createEntriesState } from './state/entries.svelte.js';

/**
 * The tutor surface: one document, deliberately chosen, and the state bound to
 * it.
 *
 * The runtime carries no default document for work (ADR-0233), so the surface
 * root is where the choice lives: this surface edits the account's
 * conversations and entries when the generation has an account, and the
 * device's otherwise. The state is document-bound, which is why the surface
 * owns it instead of the runtime: two open documents would mean two entry
 * pools, never one global one.
 *
 * `showReadings` is deliberately absent. It is read and written on the DEVICE
 * document in every generation, so it is not part of the chosen-document story
 * and a component reaches the runtime for it.
 */
export type VocabSurface = {
	entries: ReturnType<typeof createEntriesState>;
};

export const [getVocabSurface, setVocabSurface] = createContext<VocabSurface>();
