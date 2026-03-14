import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
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

describe('createTimeline - pushRichtext', () => {
	function setup() {
		return createTimeline(new Y.Doc());
	}

	test('pushRichtext creates entry with type richtext', () => {
		const tl = setup();
		const entry = tl.pushRichtext();
		expect(entry.get('type')).toBe('richtext');
	});

	test('pushRichtext creates XmlFragment and frontmatter', () => {
		const tl = setup();
		const entry = tl.pushRichtext();
		expect(entry.get('content')).toBeInstanceOf(Y.XmlFragment);
		expect(entry.get('frontmatter')).toBeInstanceOf(Y.Map);
	});

	test('pushRichtext sets createdAt', () => {
		const tl = setup();
		const entry = tl.pushRichtext();
		expect(entry.get('createdAt')).toBeTypeOf('number');
	});

	test('currentMode returns richtext after pushRichtext', () => {
		const tl = setup();
		tl.pushRichtext();
		expect(tl.currentMode).toBe('richtext');
	});

	test('readAsString extracts plaintext from richtext entry', () => {
		const tl = setup();
		const entry = tl.pushRichtext();
		const fragment = entry.get('content') as Y.XmlFragment;

		const p = new Y.XmlElement('paragraph');
		const t = new Y.XmlText();
		t.insert(0, 'Hello from richtext');
		p.insert(0, [t]);
		fragment.insert(0, [p]);

		expect(tl.readAsString()).toBe('Hello from richtext');
	});

	test('readAsString on empty richtext returns empty string', () => {
		const tl = setup();
		tl.pushRichtext();
		expect(tl.readAsString()).toBe('');
	});
});
