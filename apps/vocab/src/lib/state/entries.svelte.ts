/**
 * Reactive entries state: the user-curated entry pool captured by selection.
 *
 * Backed by `fromTable()` over the `entries` table for reads and the table
 * lens's `create` / `update` / `delete` for writes. Created once per opened
 * application: there is one entry pool per replica, not one per component.
 */

import { InstantString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import type { Entry, VocabData } from '@epicenter/vocab';

export function createEntriesState(vocab: VocabData) {
	const entriesView = fromTable(vocab.entries);

	/** Every saved entry, newest first. */
	const entries = $derived(
		entriesView.all.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);

	/** Count of entries marked usable, for the sidebar group label. */
	const usableCount = $derived(
		entries.filter((entry) => entry.stage === 'usable').length,
	);

	return {
		get entries() {
			return entries;
		},
		get usableCount() {
			return usableCount;
		},

		/**
		 * Save an entry. Saving is explicit: selection capture or the panel
		 * quick-add, never an implicit side effect of reading. Trims and dedupes
		 * by exact text: a repeat save of an already-saved entry is a no-op, not a
		 * duplicate row. `note` starts empty because it is human-owned; no code
		 * path prefills it.
		 */
		save(text: string): boolean {
			const trimmed = text.trim();
			if (!trimmed) return false;
			if (entries.some((entry) => entry.text === trimmed)) return false;
			void vocab.entries.create({
				text: trimmed,
				note: '',
				stage: 'new',
				createdAt: InstantString.now(),
			});
			return true;
		},

		/** Change an entry's acquisition stage. */
		setStage(id: string, stage: Entry['stage']) {
			void vocab.entries.patch(id, { stage });
		},

		/** Edit an entry's note. Note is human-owned: only ever written from user edits. */
		setNote(id: string, note: string) {
			void vocab.entries.patch(id, { note });
		},

		/** Remove an entry from the pool. */
		remove(id: string) {
			void vocab.entries.delete(id);
		},
	};
}
