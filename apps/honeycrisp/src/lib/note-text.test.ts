/**
 * Reading a note's prose out of its document, which is what makes search cover
 * a whole note.
 *
 * The claim under test is the one the old preview-only search could not make: a
 * word past the opening line is findable. `preview` is a hundred characters for
 * a list subtitle, and prose stays in the document plane so it can merge per
 * character (ADR-0207), so this reads the document rather than the row.
 */

import { describe, expect, test } from 'bun:test';
import { pmToFragment } from '@y/prosemirror';
import * as Y from '@y/y';
import { Schema } from 'prosemirror-model';
import { readNoteText } from './note-text';

/** Enough of Honeycrisp's schema to build a real body: blocks holding text. */
const schema = new Schema({
	nodes: {
		doc: { content: 'block+' },
		paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
		text: {},
	},
});

/**
 * A note document written the way the editor writes one, through the same
 * `pmToFragment` binding, so this exercises the real stored shape rather than a
 * hand-built imitation of it.
 */
function documentOf(...paragraphs: string[]) {
	const doc = new Y.Doc();
	pmToFragment(
		schema.node(
			'doc',
			null,
			paragraphs.map((text) =>
				schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]),
			),
		),
		doc.get('body'),
	);
	return doc;
}

describe('readNoteText', () => {
	test('reads every block, which is the point', () => {
		const doc = documentOf('The opening line', 'A much later paragraph');
		expect(readNoteText(doc)).toBe('The opening line A much later paragraph');
	});

	test('joins blocks with a space so adjacent words never merge', () => {
		expect(readNoteText(documentOf('one', 'two'))).toBe('one two');
	});

	test('an empty document reads as empty rather than throwing', () => {
		expect(readNoteText(new Y.Doc())).toBe('');
		expect(readNoteText(documentOf(''))).toBe('');
	});

	test('a note whose document has not arrived reads as empty', () => {
		// The caller falls back to the row's `preview`, which is search's old
		// answer, rather than dropping the note out of the results.
		expect(readNoteText(undefined)).toBe('');
	});

	test('a long note is not truncated, unlike the preview it replaces', () => {
		const long = 'word '.repeat(400).trim();
		const text = readNoteText(documentOf('Title line', long));
		expect(text.length).toBeGreaterThan(1000);
		expect(text).toContain('Title line');
	});
});
