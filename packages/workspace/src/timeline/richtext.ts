/**
 * Content type conversion helpers for the timeline.
 *
 * Two kinds of functions:
 * - **Extract** functions: read from doc-backed Y types → return primitives
 * - **Populate** functions: write primitives → into doc-backed Y types
 *
 * The `as*()` methods on DocumentHandle compose these with timeline push
 * methods inside `ydoc.transact()`. This ensures all Y type creation
 * happens inside the transaction (user preference, no functional difference
 * but simpler mental model).
 *
 * @module
 */
import * as Y from 'yjs';

/**
 * The result of reading a sheet—columns and rows Y.Maps.
 */
export type SheetBinding = {
	columns: Y.Map<Y.Map<string>>;
	rows: Y.Map<Y.Map<string>>;
};

/**
 * Block-level element names that produce line breaks in plaintext extraction.
 * Based on Tiptap/ProseMirror defaults.
 */
const BLOCK_ELEMENTS = new Set([
	'paragraph',
	'heading',
	'blockquote',
	'listItem',
	'bulletList',
	'orderedList',
	'codeBlock',
	'horizontalRule',
	'tableRow',
]);

// ════════════════════════════════════════════════════════════════════════════
// EXTRACT FUNCTIONS (doc-backed Y types → primitives)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract plaintext from a Y.XmlFragment.
 *
 * Walks the tree recursively, collecting text from Y.XmlText nodes.
 * Block-level elements get newlines between them so paragraphs
 * don't smash together.
 *
 * @example
 * ```typescript
 * // <paragraph>Hello</paragraph><paragraph>World</paragraph>
 * xmlFragmentToPlaintext(fragment); // "Hello\nWorld"
 * ```
 */
export function xmlFragmentToPlaintext(fragment: Y.XmlFragment): string {
	const parts: string[] = [];
	collectPlaintext(fragment, parts);
	return parts.join('');
}

function collectPlaintext(
	node: Y.XmlFragment | Y.XmlElement,
	parts: string[],
): void {
	const children = node.toArray();
	for (let i = 0; i < children.length; i++) {
		const child = children[i];

		if (child instanceof Y.XmlText) {
			parts.push(child.toString());
		} else if (child instanceof Y.XmlElement) {
			const isBlock = BLOCK_ELEMENTS.has(child.nodeName);

			collectPlaintext(child, parts);

			// Add newline after block elements (except the last one)
			if (isBlock && i < children.length - 1) {
				parts.push('\n');
			}
		}
	}
}

// ════════════════════════════════════════════════════════════════════════════
// POPULATE FUNCTIONS (primitives → doc-backed Y types)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Populate a doc-backed Y.XmlFragment with paragraphs from a plaintext string.
 *
 * Each line becomes a `<paragraph>` XmlElement with an XmlText child.
 * The fragment must already be integrated into a Y.Doc (e.g., from
 * a timeline entry's 'content' field after pushRichtext()).
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
