/**
 * What the user is looking at right now, derived from where they are.
 *
 * `navigation` owns where: the folder, the note, the query, the deleted view.
 * This owns the answer that follows from it. The two are separate because one
 * is a place the URL can hold and the other is a question only the notes table
 * can answer.
 *
 * @example
 * ```svelte
 * <script>
 *   import { getHoneycrisp } from '$lib/honeycrisp/index.js';
 *   const honeycrisp = getHoneycrisp();
 * </script>
 *
 * {#each honeycrisp.view.currentNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current title: {honeycrisp.view.currentTitle}</p>
 * ```
 */

import type { createFolders } from './folders.svelte.js';
import { navigation } from './navigation.svelte.js';
import type { createNotes } from './notes.svelte.js';

export function createView({
	folders,
	notes,
}: {
	folders: ReturnType<typeof createFolders>;
	notes: ReturnType<typeof createNotes>;
}) {
	// The one order notes appear in: newest edit first. There is no
	// user-selectable sort by decision; the earlier sort control was inert (the
	// list re-sorted by updatedAt regardless) and nobody noticed, so the
	// feature was deleted rather than repaired. This comparator is ordering's
	// single owner: the list component groups (pinned, date labels) without
	// ever re-sorting.
	const byRecentEdit = (
		a: { updatedAt: string },
		b: { updatedAt: string },
	): number => b.updatedAt.localeCompare(a.updatedAt);

	/** Notes filtered by selected folder and search query, newest edit first. */
	const filteredNotes = $derived.by(() => {
		const folderId = navigation.folderId;
		const q = navigation.query.trim().toLowerCase();

		return notes.all
			.filter((n) => folderId === null || n.folderId === folderId)
			.filter((n) => {
				if (!q) return true;
				if (n.title.toLowerCase().includes(q)) return true;
				// The whole note, read out of its document. `preview` is a hundred
				// characters for a list subtitle, so searching it alone could not
				// find a word past the first line, and prose is not the row's to
				// carry (ADR-0207). It answers for a note whose document has not
				// arrived yet, which is what search could do before.
				return (notes.text(n.id) || n.preview).toLowerCase().includes(q);
			})
			.toSorted(byRecentEdit);
	});

	/** Human-readable name for the current folder. Feeds `currentTitle`. */
	const folderName = $derived.by(() => {
		const folderId = navigation.folderId;
		return folderId ? (folders.get(folderId)?.name ?? 'Notes') : 'All Notes';
	});

	return {
		/**
		 * The list of notes the user currently sees: deleted notes when in
		 * Recently Deleted, otherwise the folder/search-filtered + sorted list.
		 */
		get currentNotes() {
			return navigation.isDeletedView
				? notes.deleted.toSorted(byRecentEdit)
				: filteredNotes;
		},
		/** The header title for the current notes list. */
		get currentTitle(): string {
			return navigation.isDeletedView ? 'Recently Deleted' : folderName;
		},
		/** Whether the new-note control should appear. Off in Recently Deleted. */
		get currentShowControls(): boolean {
			return !navigation.isDeletedView;
		},
		/**
		 * The empty-state message for the current notes list.
		 *
		 * "No notes yet" is a claim about the person's history, and it is false
		 * when the list is empty because this release cannot INTERPRET what they
		 * wrote. A note written by a newer release, or by a workspace this one has
		 * since changed, reads as `Nonconforming` (ADR-0125); the row is intact
		 * and unreadable, which is a different thing from absent and deserves a
		 * different sentence.
		 */
		get currentEmptyMessage(): string {
			const unreadable = notes.nonconforming.length;
			if (unreadable > 0) {
				return `${unreadable} ${unreadable === 1 ? 'note is' : 'notes are'} here but this version of Honeycrisp cannot read ${unreadable === 1 ? 'it' : 'them'}. Nothing has been lost.`;
			}
			return navigation.isDeletedView
				? 'No deleted notes'
				: 'No notes yet. Click + to create one.';
		},
	};
}
