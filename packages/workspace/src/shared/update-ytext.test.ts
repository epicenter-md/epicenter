/**
 * Y.Text / Y.XmlFragment String Update Tests
 *
 * Validates string-to-CRDT update helpers that use minimal diffs to preserve
 * CRDT character identity. Ensures updates are transactional, no-op when
 * content is identical, and safe when called with detached Yjs types.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	updateYTextFromString,
	updateYXmlFragmentFromString,
} from './update-ytext';

describe('updateYTextFromString', () => {
	test('no-op when content is identical', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'Hello World');

		let transactionCount = 0;
		ydoc.on('update', () => transactionCount++);

		updateYTextFromString(ytext, 'Hello World');
		expect(transactionCount).toBe(0);
		expect(ytext.toString()).toBe('Hello World');
	});

	test('inserts text in the middle', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'Hello World');

		updateYTextFromString(ytext, 'Hello Beautiful World');
		expect(ytext.toString()).toBe('Hello Beautiful World');
	});

	test('deletes text', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'Hello Beautiful World');

		updateYTextFromString(ytext, 'Hello World');
		expect(ytext.toString()).toBe('Hello World');
	});

	test('replaces entire content', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'abc');

		updateYTextFromString(ytext, 'xyz');
		expect(ytext.toString()).toBe('xyz');
	});

	test('inserts target content when initial text is empty', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');

		updateYTextFromString(ytext, 'Hello');
		expect(ytext.toString()).toBe('Hello');
	});

	test('deletes all content when target text is empty', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'Hello');

		updateYTextFromString(ytext, '');
		expect(ytext.toString()).toBe('');
	});

	test('preserves CRDT identity for unchanged characters', () => {
		const doc1 = new Y.Doc({ guid: 'doc1' });
		const doc2 = new Y.Doc({ guid: 'doc2' });
		const text1 = doc1.getText('text');
		const text2 = doc2.getText('text');

		// Sync doc1 -> doc2 so both start with same content
		text1.insert(0, 'Hello World');
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		expect(text2.toString()).toBe('Hello World');

		// Simulate concurrent edit: doc2 appends "!"
		text2.insert(text2.length, '!');

		// Meanwhile, doc1 does a diff-based update (e.g., agent sed)
		updateYTextFromString(text1, 'Hello Beautiful World');

		// Merge both changes
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Both docs should have the merged result: "!" preserved
		expect(text1.toString()).toBe('Hello Beautiful World!');
		expect(text2.toString()).toBe('Hello Beautiful World!');
	});

	test('emits exactly one update event (single transaction)', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'aaa bbb ccc');

		let updateCount = 0;
		ydoc.on('update', () => updateCount++);

		updateYTextFromString(ytext, 'aaa xxx ccc yyy');
		expect(updateCount).toBe(1);
	});

	test('throws when Y.Text is not attached to a doc', () => {
		const ytext = new Y.Text();
		expect(() => updateYTextFromString(ytext, 'Hello')).toThrow(
			'Y.Text must be attached to a Y.Doc',
		);
	});

	test('handles multiline content', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'line 1\nline 2\nline 3');

		updateYTextFromString(ytext, 'line 1\nline 2 modified\nline 3\nline 4');
		expect(ytext.toString()).toBe('line 1\nline 2 modified\nline 3\nline 4');
	});
});

describe('updateYXmlFragmentFromString', () => {
	// Simple test serialize/apply for plain text content in XmlFragment
	const serialize = (frag: Y.XmlFragment): string => {
		let result = '';
		for (let i = 0; i < frag.length; i++) {
			const child = frag.get(i);
			if (child instanceof Y.XmlText) {
				result += child.toString();
			}
		}
		return result;
	};

	const apply = (frag: Y.XmlFragment, content: string): void => {
		const text = new Y.XmlText(content);
		frag.insert(0, [text]);
	};

	test('no-op when content is identical', () => {
		const ydoc = new Y.Doc();
		const frag = ydoc.getXmlFragment('richtext');
		frag.insert(0, [new Y.XmlText('Hello')]);

		let updateCount = 0;
		ydoc.on('update', () => updateCount++);

		updateYXmlFragmentFromString(frag, 'Hello', serialize, apply);
		expect(updateCount).toBe(0);
	});

	test('replaces content when different', () => {
		const ydoc = new Y.Doc();
		const frag = ydoc.getXmlFragment('richtext');
		frag.insert(0, [new Y.XmlText('Hello')]);

		updateYXmlFragmentFromString(frag, 'Goodbye', serialize, apply);
		expect(serialize(frag)).toBe('Goodbye');
	});

	test('clears and rebuilds in a single transaction', () => {
		const ydoc = new Y.Doc();
		const frag = ydoc.getXmlFragment('richtext');
		frag.insert(0, [new Y.XmlText('original')]);

		let updateCount = 0;
		ydoc.on('update', () => updateCount++);

		updateYXmlFragmentFromString(frag, 'replaced', serialize, apply);
		expect(updateCount).toBe(1);
		expect(serialize(frag)).toBe('replaced');
	});

	test('throws when XmlFragment is not attached to a doc', () => {
		const frag = new Y.XmlFragment();
		expect(() =>
			updateYXmlFragmentFromString(frag, 'new', serialize, apply),
		).toThrow('Y.XmlFragment must be attached to a Y.Doc');
	});
});
