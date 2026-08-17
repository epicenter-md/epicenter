/**
 * Pure derivation of a note's table-row metadata from its ProseMirror document.
 *
 * The editor owns a rich-text document; the note list shows a title, a preview,
 * and a word count. These helpers translate the former into the latter with no
 * editor-view or Svelte dependency, so they can be unit-tested directly.
 *
 * @module
 */

import type { Node } from 'prosemirror-model';

/**
 * The row fields derived from a note's ProseMirror document.
 *
 * Exactly what the note list renders, and nothing else. Two things used to ride
 * along here and no longer do: the whole flattened text, which fed a
 * device-local search index that search replaced by reading the document
 * (`readNoteText`), and a word count nothing ever displayed.
 */
export type NoteMetadata = {
	title: string;
	preview: string;
};

/**
 * Derive {@link NoteMetadata} from a ProseMirror document.
 *
 * The title is the first block's text (the note's "first line"). `doc.textContent`
 * joins every block with no separator, so splitting it on `\n` never finds a
 * break and the title would swallow the whole note; the first child's own
 * `textContent` is the first line. `textBetween` with a space separator likewise
 * keeps words from adjacent blocks from merging in the preview.
 */
export function extractNoteMetadata(doc: Node): NoteMetadata {
	const firstLine = doc.firstChild?.textContent ?? '';
	const text = doc.textBetween(0, doc.content.size, ' ');
	return {
		title: firstLine.slice(0, 80).trim(),
		preview: text.slice(0, 100).trim(),
	};
}
