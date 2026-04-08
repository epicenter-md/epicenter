/**
 * Content type conversion helpers for the timeline.
 *
 * Two kinds of functions:
 * - **Extract** functions: read from doc-backed Y types → return primitives
 * - **Populate** functions: write primitives → into doc-backed Y types
 *
 * The `as*()` methods on Timeline compose these with push ops inside
 * `ydoc.transact()`. This ensures all Y type creation happens inside the
 * transaction (user preference, no functional difference but simpler mental model).
 *
 * @module
 */

import type { PhrasingContent, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import * as Y from 'yjs';

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

// ════════════════════════════════════════════════════════════════════════════
// MARKDOWN → Y.XmlFragment
// ════════════════════════════════════════════════════════════════════════════

/**
 * Populate a doc-backed Y.XmlFragment from a markdown string.
 *
 * Parses markdown via `remark-parse` into an mdast, then walks the tree to
 * build Y.XmlElement/Y.XmlText nodes that match Tiptap's document schema:
 *
 * - Headings → `<heading level="N">`
 * - Paragraphs → `<paragraph>`
 * - Bold → Y.XmlText with `{ bold: true }`
 * - Italic → Y.XmlText with `{ italic: true }`
 * - Links → Y.XmlText with `{ link: { href: url } }`
 * - Inline code → Y.XmlText with `{ code: true }`
 * - Code blocks → `<codeBlock language="lang">`
 * - Blockquotes → `<blockquote>` containing paragraphs
 * - Lists → `<bulletList>` or `<orderedList>` containing `<listItem>`s
 * - Horizontal rules → `<horizontalRule>`
 *
 * The fragment must already be integrated into a Y.Doc.
 *
 * @param fragment - A doc-backed Y.XmlFragment to populate
 * @param markdown - Markdown string to parse and convert
 *
 * @example
 * ```typescript
 * const fragment = timeline.asRichText();
 * populateFragmentFromMarkdown(fragment, '# Hello **world**');
 * // fragment now contains: <heading level="1">Hello <bold>world</bold></heading>
 * ```
 */
export function populateFragmentFromMarkdown(
	fragment: Y.XmlFragment,
	markdown: string,
): void {
	const tree = unified().use(remarkParse).parse(markdown);
	insertBlockNodes(fragment, tree.children);
}

/**
 * Insert block-level mdast nodes into a Y.XmlFragment or Y.XmlElement parent.
 */
function insertBlockNodes(
	parent: Y.XmlFragment | Y.XmlElement,
	nodes: RootContent[],
): void {
	for (const node of nodes) {
		switch (node.type) {
			case 'heading': {
				const el = new Y.XmlElement('heading');
				el.setAttribute('level', String(node.depth));
				insertInlineNodes(el, node.children);
				parent.insert(parent.length, [el]);
				break;
			}
			case 'paragraph': {
				const el = new Y.XmlElement('paragraph');
				insertInlineNodes(el, node.children);
				parent.insert(parent.length, [el]);
				break;
			}
			case 'blockquote': {
				const el = new Y.XmlElement('blockquote');
				insertBlockNodes(el, node.children);
				parent.insert(parent.length, [el]);
				break;
			}
			case 'list': {
				const tag = node.ordered ? 'orderedList' : 'bulletList';
				const el = new Y.XmlElement(tag);
				for (const item of node.children) {
					const li = new Y.XmlElement('listItem');
					insertBlockNodes(li, item.children);
					el.insert(el.length, [li]);
				}
				parent.insert(parent.length, [el]);
				break;
			}
			case 'code': {
				const el = new Y.XmlElement('codeBlock');
				if (node.lang) el.setAttribute('language', node.lang);
				const text = new Y.XmlText();
				text.insert(0, node.value);
				el.insert(0, [text]);
				parent.insert(parent.length, [el]);
				break;
			}
			case 'thematicBreak': {
				const el = new Y.XmlElement('horizontalRule');
				parent.insert(parent.length, [el]);
				break;
			}
			// Skip unknown block types silently
		}
	}
}

/**
 * Collect formatting marks from nested mdast inline nodes.
 *
 * mdast nests marks: `strong > emphasis > text` means bold+italic.
 * We flatten this into a single attributes object for Y.XmlText.
 */
type InlineAttrs = Record<string, string | boolean | Record<string, string>>;

function collectInlineRuns(
	nodes: PhrasingContent[],
	inheritedAttrs: InlineAttrs,
	runs: Array<{ text: string; attrs: InlineAttrs }>,
): void {
	for (const node of nodes) {
		switch (node.type) {
			case 'text':
				runs.push({ text: node.value, attrs: { ...inheritedAttrs } });
				break;
			case 'strong':
				collectInlineRuns(
					node.children,
					{ ...inheritedAttrs, bold: true },
					runs,
				);
				break;
			case 'emphasis':
				collectInlineRuns(
					node.children,
					{ ...inheritedAttrs, italic: true },
					runs,
				);
				break;
			case 'link':
				collectInlineRuns(
					node.children,
					{ ...inheritedAttrs, link: { href: node.url } },
					runs,
				);
				break;
			case 'inlineCode':
				runs.push({
					text: node.value,
					attrs: { ...inheritedAttrs, code: true },
				});
				break;
			// Skip unknown inline types silently
		}
	}
}

/**
 * Insert inline mdast nodes into a Y.XmlElement as formatted Y.XmlText runs.
 *
 * Flattens nested marks (bold > italic > text) into Y.XmlText nodes with
 * merged attribute objects, matching how Tiptap/ProseMirror stores formatting.
 */
function insertInlineNodes(
	parent: Y.XmlElement,
	nodes: PhrasingContent[],
): void {
	const runs: Array<{ text: string; attrs: InlineAttrs }> = [];
	collectInlineRuns(nodes, {}, runs);
	for (const run of runs) {
		const text = new Y.XmlText();
		const attrs = Object.keys(run.attrs).length > 0 ? run.attrs : undefined;
		text.insert(0, run.text, attrs);
		parent.insert(parent.length, [text]);
	}
}
