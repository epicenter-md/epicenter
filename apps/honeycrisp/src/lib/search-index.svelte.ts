/**
 * Honeycrisp's own full-text index over its notes.
 *
 * The row carries `title` and `preview`, and `preview` is a hundred characters
 * for a list subtitle. Searching it meant a word past the opening line could not
 * be found, and the field's name did not say so. Prose lives in the document
 * plane by decision (ADR-0207) so it can merge per character, which means the
 * row will never carry it and neither will the folder. Searching a note's body
 * is therefore Honeycrisp's job, not the platform's, and this is where it lives.
 *
 * Device-local and never synced: it is a derived view of documents that are
 * already durable, so losing it costs one warm-up rather than any data.
 *
 * Warmed on demand rather than at boot. Opening every note's document to index
 * it is real work, and a person who never searches should never pay for it, so
 * the sweep starts the first time a query is typed. Until a note is indexed its
 * `preview` still answers, which is exactly today's behavior, so search degrades
 * to what it used to be instead of to nothing.
 */

import { SvelteMap } from 'svelte/reactivity';

/** What the index can answer for one note. */
type Indexed = { text: string };

export type NoteSearchIndex = ReturnType<typeof createNoteSearchIndex>;

/**
 * Read a note document's flattened text without a ProseMirror view.
 *
 * The editor derives the same string through ProseMirror when a note is open,
 * and this is the path for the notes that are not. It walks the Yjs types the
 * editor binds to, so it needs no schema and no editor state: every `Y.XmlText`
 * under `body` contributes its characters, joined by spaces so words in adjacent
 * blocks do not merge, which is the same rule `extractNoteMetadata` follows.
 */
export function readDocumentText(document: {
	get(name: string): unknown;
}): string {
	const root = document.get('body') as { toJSON?: () => unknown } | undefined;
	if (typeof root?.toJSON !== 'function') return '';

	// `toJSON` is the type's own public shape: a node is either a string, which
	// is text, or an object with `children`. Yjs 14 has one `YType` rather than
	// distinct XML classes, so there is no class to branch on and no reason to
	// reach past this into internals.
	const parts: string[] = [];
	const visit = (node: unknown): void => {
		if (typeof node === 'string') {
			parts.push(node);
			return;
		}
		if (node === null || typeof node !== 'object') return;
		const { children } = node as { children?: unknown };
		if (Array.isArray(children)) for (const child of children) visit(child);
	};
	visit(root.toJSON());
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function createNoteSearchIndex({
	openDocumentText,
	onError,
}: {
	/** Read one note's text, opening and releasing its document. */
	openDocumentText: (noteId: string) => Promise<string>;
	onError: (cause: unknown) => void;
}) {
	const entries = new SvelteMap<string, Indexed>();
	let sweeping = false;

	/**
	 * Index every note that has none yet, one document at a time.
	 *
	 * Serial on purpose: this is background work behind a list the person is
	 * already reading, and opening many documents at once competes with the note
	 * they actually have open. Results appear as each one lands, because the map
	 * is reactive.
	 */
	async function warm(noteIds: readonly string[]): Promise<void> {
		if (sweeping) return;
		sweeping = true;
		try {
			for (const noteId of noteIds) {
				if (entries.has(noteId)) continue;
				try {
					entries.set(noteId, { text: await openDocumentText(noteId) });
				} catch (cause) {
					// A note whose document will not open is not a reason to stop
					// indexing the rest, and it still answers on its preview.
					onError(cause);
				}
			}
		} finally {
			sweeping = false;
		}
	}

	return {
		/** Record the text of a note the editor already has open. */
		record(noteId: string, text: string): void {
			entries.set(noteId, { text });
		},
		/** Forget a deleted note, so a sweep never reopens it. */
		forget(noteId: string): void {
			entries.delete(noteId);
		},
		/** The indexed text, or `undefined` while this note is still unindexed. */
		textFor(noteId: string): string | undefined {
			return entries.get(noteId)?.text;
		},
		warm,
	};
}
