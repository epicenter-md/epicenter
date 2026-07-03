/**
 * Reactive terms state: the user-curated term pool captured by selection.
 *
 * Backed by `fromTable()` over the `terms` table for reads and the connected
 * table's `set` / `update` / `delete` for writes. One device-wide singleton,
 * like `dictation` and `inferenceConnections`: there is one term pool per
 * workspace, not one per component.
 */

import { InstantString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import { generateTermId, type Term, type TermId } from '@epicenter/vocab';
import { vocab } from '$lib/vocab';

function createTermsState() {
	const termsView = fromTable(vocab.tables.terms);

	/** Every saved term, newest first. */
	const terms = $derived(
		termsView.all.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);

	/** Count of terms marked usable, for the sidebar group label. */
	const usableCount = $derived(
		terms.filter((term) => term.stage === 'usable').length,
	);

	return {
		get terms() {
			return terms;
		},
		get usableCount() {
			return usableCount;
		},

		/**
		 * Save a term. Saving is explicit: selection capture or the panel
		 * quick-add, never an implicit side effect of reading. Trims and dedupes
		 * by exact text: a repeat save of an already-saved term is a no-op, not a
		 * duplicate row. `note` starts empty because it is human-owned; no code
		 * path prefills it.
		 */
		save(text: string): boolean {
			const trimmed = text.trim();
			if (!trimmed) return false;
			if (terms.some((term) => term.text === trimmed)) return false;
			vocab.tables.terms.set({
				id: generateTermId(),
				text: trimmed,
				note: '',
				stage: 'new',
				createdAt: InstantString.now(),
			});
			return true;
		},

		/** Change a term's acquisition stage. */
		setStage(id: TermId, stage: Term['stage']) {
			vocab.tables.terms.update(id, { stage });
		},

		/** Edit a term's note. Note is human-owned: only ever written from user edits. */
		setNote(id: TermId, note: string) {
			vocab.tables.terms.update(id, { note });
		},

		/** Remove a term from the pool. */
		remove(id: TermId) {
			vocab.tables.terms.delete(id);
		},
	};
}

export const termsState = createTermsState();
