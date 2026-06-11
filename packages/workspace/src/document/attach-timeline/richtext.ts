/**
 * Content population helpers for the timeline.
 *
 * Populate functions write primitives into doc-backed Y types. The `as*()`
 * methods on Timeline compose these with push ops inside `ydoc.transact()`,
 * so all Y type creation happens inside the transaction (user preference,
 * no functional difference but simpler mental model).
 *
 * Plaintext *extraction* is exposed as `xmlFragmentToPlaintext` from
 * `@epicenter/workspace`: import it from there.
 *
 * @module
 */

import * as Y from 'yjs';

/**
 * Populate a doc-backed Y.XmlFragment with paragraphs from a plaintext string.
 *
 * Each line becomes a `<paragraph>` XmlElement with an XmlText child.
 * The fragment must already be integrated into a Y.Doc (e.g., from
 * a timeline entry's 'content' field after asRichText()).
 *
 * @param fragment - A doc-backed Y.XmlFragment to populate
 * @param text - Plaintext to split into paragraphs
 */
export function populateFragmentFromText(
	fragment: Y.XmlFragment,
	text: string,
): void {
	const lines = text.split('\n');
	for (const line of lines) {
		const paragraph = new Y.XmlElement('paragraph');
		const xmlText = new Y.XmlText();
		xmlText.insert(0, line);
		paragraph.insert(0, [xmlText]);
		fragment.insert(fragment.length, [paragraph]);
	}
}
