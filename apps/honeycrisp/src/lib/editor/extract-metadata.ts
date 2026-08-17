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
 * Title, preview, and word count derived from a note's ProseMirror document.
 *
 * Exactly the three row fields, and nothing else. The whole flattened text used
 * to ride along here to feed a device-local search index; search now reads the
 * document directly (`readNoteText`), so the editor has no reason to carry it.
 */
export type NoteMetadata = {
	title: string;
	preview: string;
	wordCount: number;
};

/**
 * Derive {@link NoteMetadata} from a ProseMirror document.
 *
 * The title is the first block's text (the note's "first line"). `doc.textContent`
 * joins every block with no separator, so splitting it on `\n` never finds a
 * break and the title would swallow the whole note; the first child's own
 * `textContent` is the first line. `textBetween` with a space separator likewise
 * keeps words from adjacent blocks from merging in the preview and word count.
 */
export function extractNoteMetadata(doc: Node): NoteMetadata {
	const firstLine = doc.firstChild?.textContent ?? '';
	const text = doc.textBetween(0, doc.content.size, ' ');
	const trimmed = text.trim();
	return {
		title: firstLine.slice(0, 80).trim(),
		preview: text.slice(0, 100).trim(),
		wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
	};
}
