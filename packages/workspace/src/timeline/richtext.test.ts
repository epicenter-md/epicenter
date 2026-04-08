import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	populateFragmentFromMarkdown,
	populateFragmentFromText,
	xmlFragmentToPlaintext,
} from './richtext.js';
import { createTimeline } from './timeline.js';

/** Helper: build a paragraph XmlElement with text content (standalone, for insertion). */
function makeParagraph(content: string): Y.XmlElement {
	const p = new Y.XmlElement('paragraph');
	const t = new Y.XmlText();
	t.insert(0, content);
	p.insert(0, [t]);
	return p;
}

/** Helper: create a doc-backed XmlFragment via builder callback. */
function createDocFragment(
	build?: (fragment: Y.XmlFragment) => void,
): Y.XmlFragment {
	const doc = new Y.Doc();
	const fragment = doc.getXmlFragment('test');
	build?.(fragment);
	return fragment;
}

// ════════════════════════════════════════════════════════════════════════════
// xmlFragmentToPlaintext
// ════════════════════════════════════════════════════════════════════════════

describe('xmlFragmentToPlaintext', () => {
	test('empty fragment returns empty string', () => {
		const fragment = createDocFragment();
		expect(xmlFragmentToPlaintext(fragment)).toBe('');
	});

	test('single paragraph', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('Hello world')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Hello world');
	});

	test('multiple paragraphs get newlines between them', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('First'), makeParagraph('Second')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('First\nSecond');
	});

	test('heading elements get newlines', () => {
		const fragment = createDocFragment((f) => {
			const h = new Y.XmlElement('heading');
			const ht = new Y.XmlText();
			ht.insert(0, 'Title');
			h.insert(0, [ht]);
			f.insert(0, [h, makeParagraph('Body text')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Title\nBody text');
	});

	test('inline elements do not add newlines', () => {
		const fragment = createDocFragment((f) => {
			const p = new Y.XmlElement('paragraph');
			const t1 = new Y.XmlText();
			t1.insert(0, 'Hello ');
			const bold = new Y.XmlElement('bold');
			const t2 = new Y.XmlText();
			t2.insert(0, 'world');
			bold.insert(0, [t2]);
			p.insert(0, [t1, bold]);
			f.insert(0, [p]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Hello world');
	});

	test('three paragraphs get correct newlines', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('A'), makeParagraph('B'), makeParagraph('C')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('A\nB\nC');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// populateFragmentFromText
// ════════════════════════════════════════════════════════════════════════════

describe('populateFragmentFromText', () => {
	test('single line creates one paragraph', () => {
		const fragment = createDocFragment((f) => {
			populateFragmentFromText(f, 'Hello');
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Hello');
		expect(fragment.length).toBe(1);
	});

	test('multiline text creates multiple paragraphs', () => {
		const fragment = createDocFragment((f) => {
			populateFragmentFromText(f, 'Line 1\nLine 2\nLine 3');
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Line 1\nLine 2\nLine 3');
		expect(fragment.length).toBe(3);
	});

	test('empty text creates one empty paragraph', () => {
		const fragment = createDocFragment((f) => {
			populateFragmentFromText(f, '');
		});
		// '' split by \n gives [''] — one paragraph
		expect(fragment.length).toBe(1);
	});

	test('round-trip: populate → extract preserves text', () => {
		const original = 'First paragraph\nSecond paragraph\nThird paragraph';
		const fragment = createDocFragment((f) => {
			populateFragmentFromText(f, original);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe(original);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// pushRichtext on Timeline
// ════════════════════════════════════════════════════════════════════════════

describe('createTimeline - asRichText', () => {
	function setup() {
		return createTimeline(new Y.Doc());
	}

	test('asRichText on empty timeline creates richtext entry', () => {
		const tl = setup();
		tl.asRichText();
		expect(tl.currentType).toBe('richtext');
	});

	test('asRichText returns XmlFragment', () => {
		const tl = setup();
		const fragment = tl.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
	});

	test('richtext entry has createdAt', () => {
		const tl = setup();
		tl.asRichText();
		const entry = tl.currentEntry;
		if (!entry) throw new Error('expected richtext');
		expect(entry.createdAt).toBeTypeOf('number');
	});

	test('read extracts plaintext from richtext entry', () => {
		const tl = setup();
		const fragment = tl.asRichText();

		const p = new Y.XmlElement('paragraph');
		const t = new Y.XmlText();
		t.insert(0, 'Hello from richtext');
		p.insert(0, [t]);
		fragment.insert(0, [p]);

		expect(tl.read()).toBe('Hello from richtext');
	});

	test('read on empty richtext returns empty string', () => {
		const tl = setup();
		tl.asRichText();
		expect(tl.read()).toBe('');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// populateFragmentFromMarkdown
// ════════════════════════════════════════════════════════════════════════════

describe('populateFragmentFromMarkdown', () => {
	test('heading with bold text', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '# Hello **world**');

		const children = fragment.toArray();
		expect(children.length).toBe(1);

		const heading = children[0] as Y.XmlElement;
		expect(heading.nodeName).toBe('heading');
		expect(heading.getAttribute('level')).toBe('1');

		const textNodes = heading.toArray();
		expect(textNodes.length).toBe(2);
		expect((textNodes[0] as Y.XmlText).toDelta()).toEqual([
			{ insert: 'Hello ' },
		]);
		const boldText = textNodes[1] as Y.XmlText;
		expect(boldText.toDelta()).toEqual([
			{ insert: 'world', attributes: { bold: true } },
		]);
	});

	test('paragraph with mixed formatting', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, 'Some **bold** and *italic* text');

		const para = fragment.toArray()[0] as Y.XmlElement;
		expect(para.nodeName).toBe('paragraph');

		const runs = para.toArray() as Y.XmlText[];
		expect(runs.length).toBe(5);
		expect(runs[0].toString()).toBe('Some ');
		expect(runs[1].toDelta()).toEqual([
			{ insert: 'bold', attributes: { bold: true } },
		]);
		expect(runs[2].toString()).toBe(' and ');
		expect(runs[3].toDelta()).toEqual([
			{ insert: 'italic', attributes: { italic: true } },
		]);
		expect(runs[4].toString()).toBe(' text');
	});

	test('link preserves href', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '[click here](https://example.com)');

		const para = fragment.toArray()[0] as Y.XmlElement;
		const linkText = para.toArray()[0] as Y.XmlText;
		expect(linkText.toDelta()[0].insert).toBe('click here');
		expect(linkText.toDelta()).toEqual([
			{
				insert: 'click here',
				attributes: { link: { href: 'https://example.com' } },
			},
		]);
	});

	test('code block with language', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '```typescript\nconst x = 1;\n```');

		const codeBlock = fragment.toArray()[0] as Y.XmlElement;
		expect(codeBlock.nodeName).toBe('codeBlock');
		expect(codeBlock.getAttribute('language')).toBe('typescript');
		expect((codeBlock.toArray()[0] as Y.XmlText).toString()).toBe(
			'const x = 1;',
		);
	});

	test('blockquote containing paragraph', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '> A quoted paragraph');

		const bq = fragment.toArray()[0] as Y.XmlElement;
		expect(bq.nodeName).toBe('blockquote');
		const inner = bq.toArray()[0] as Y.XmlElement;
		expect(inner.nodeName).toBe('paragraph');
		expect((inner.toArray()[0] as Y.XmlText).toString()).toBe(
			'A quoted paragraph',
		);
	});

	test('bullet list', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '- item 1\n- item 2');

		const list = fragment.toArray()[0] as Y.XmlElement;
		expect(list.nodeName).toBe('bulletList');
		const items = list.toArray() as Y.XmlElement[];
		expect(items.length).toBe(2);
		expect(items[0].nodeName).toBe('listItem');
		expect(items[1].nodeName).toBe('listItem');
	});

	test('ordered list', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '1. first\n2. second');

		const list = fragment.toArray()[0] as Y.XmlElement;
		expect(list.nodeName).toBe('orderedList');
	});

	test('inline code', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, 'Use `foo()` here');

		const para = fragment.toArray()[0] as Y.XmlElement;
		const runs = para.toArray() as Y.XmlText[];
		expect(runs[0].toString()).toBe('Use ');
		expect(runs[1].toDelta()).toEqual([
			{ insert: 'foo()', attributes: { code: true } },
		]);
		expect(runs[2].toString()).toBe(' here');
	});

	test('horizontal rule', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, 'Above\n\n---\n\nBelow');

		const children = fragment.toArray() as Y.XmlElement[];
		expect(children.length).toBe(3);
		expect(children[0].nodeName).toBe('paragraph');
		expect(children[1].nodeName).toBe('horizontalRule');
		expect(children[2].nodeName).toBe('paragraph');
	});

	test('nested bold+italic', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(fragment, '***bold and italic***');

		const para = fragment.toArray()[0] as Y.XmlElement;
		const text = para.toArray()[0] as Y.XmlText;
		expect(text.toDelta()).toEqual([
			{ insert: 'bold and italic', attributes: { bold: true, italic: true } },
		]);
	});

	test('multi-block document', () => {
		const fragment = createDocFragment();
		populateFragmentFromMarkdown(
			fragment,
			'# Title\n\nA paragraph.\n\n> A quote\n\n- item',
		);

		const children = fragment.toArray() as Y.XmlElement[];
		expect(children.length).toBe(4);
		expect(children[0].nodeName).toBe('heading');
		expect(children[1].nodeName).toBe('paragraph');
		expect(children[2].nodeName).toBe('blockquote');
		expect(children[3].nodeName).toBe('bulletList');
	});
});
