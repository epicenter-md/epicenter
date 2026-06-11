import { diffChars } from 'diff';
import type * as Y from 'yjs';

/**
 * Updates a Y.Text to match a target string using minimal character-level diffs.
 *
 * Instead of delete-all + insert-all (which destroys CRDT character identity),
 * this computes the minimal set of insertions and deletions needed to transform
 * the current content into the target. Unchanged characters keep their CRDT
 * identity, so concurrent edits from other users merge correctly.
 *
 * All operations happen in a single Yjs transaction.
 *
 * @param yText - The Y.Text to update
 * @param newString - The target string content
 *
 * @example
 * ```typescript
 * const ytext = ydoc.getText('text');
 * ytext.insert(0, 'Hello World');
 *
 * updateYTextFromString(ytext, 'Hello Beautiful World');
 * // Only inserts " Beautiful": "Hello " and "World" keep CRDT identity
 * ```
 */
export function updateYTextFromString(yText: Y.Text, newString: string): void {
	const doc = yText.doc;
	if (!doc) throw new Error('Y.Text must be attached to a Y.Doc');

	const currentString = yText.toString();
	if (currentString === newString) return;

	const diffs = diffChars(currentString, newString);

	doc.transact(() => {
		let index = 0;
		for (const change of diffs) {
			if (change.added) {
				yText.insert(index, change.value);
				index += change.value.length;
			} else if (change.removed) {
				yText.delete(index, change.value.length);
			} else {
				index += change.value.length;
			}
		}
	});
}

/**
 * Updates a Y.XmlFragment to match a markdown string.
 *
 * Unlike Y.Text where character-level diffing preserves CRDT identity,
 * tree-structure diffing isn't practical: ProseMirror nodes don't have
 * a clean character-level mapping. This does a full clear-and-rebuild
 * when the serialized content differs from the target.
 *
 * The early-return on string equality still avoids unnecessary Yjs operations
 * when the content hasn't actually changed (the common case for `writeFile`
 * after a no-op `sed` or `grep`).
 *
 * All operations happen in a single Yjs transaction.
 *
 * @param xmlFragment - The Y.XmlFragment to update
 * @param markdown - The target markdown string
 * @param serialize - Serializes the current XmlFragment to a markdown string for comparison
 * @param apply - Populates a cleared XmlFragment from a markdown string
 *
 * @example
 * ```typescript
 * updateYXmlFragmentFromString(
 *   ydoc.getXmlFragment('richtext'),
 *   '# Hello\n\nNew content here.',
 *   (frag) => remarkSerialize(frag),
 *   (frag, md) => remarkParseToProseMirror(frag, md),
 * );
 * ```
 */
export function updateYXmlFragmentFromString(
	xmlFragment: Y.XmlFragment,
	markdown: string,
	serialize: (fragment: Y.XmlFragment) => string,
	apply: (fragment: Y.XmlFragment, markdown: string) => void,
): void {
	const doc = xmlFragment.doc;
	if (!doc) throw new Error('Y.XmlFragment must be attached to a Y.Doc');

	const currentMarkdown = serialize(xmlFragment);
	if (currentMarkdown === markdown) return;

	doc.transact(() => {
		xmlFragment.delete(0, xmlFragment.length);
		apply(xmlFragment, markdown);
	});
}
