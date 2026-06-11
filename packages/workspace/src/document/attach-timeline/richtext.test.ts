import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { xmlFragmentToPlaintext } from '../attach-rich-text.js';
import { populateFragmentFromText } from './richtext.js';
import { attachTimeline } from './timeline.js';

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
		// '' split by \n gives ['']: one paragraph
		expect(fragment.length).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// pushRichtext on Timeline
// ════════════════════════════════════════════════════════════════════════════

describe('attachTimeline - asRichText', () => {
	function setup() {
		return attachTimeline(new Y.Doc());
	}

	test('asRichText on empty timeline creates richtext entry', () => {
		const tl = setup();
		tl.asRichText();
		expect(tl.currentType).toBe('richtext');
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
