/**
 * Honeycrisp's body index, which is what makes search cover a whole note.
 *
 * The claim under test is the one the old search could not make: a word past
 * the opening line is findable. `preview` is a hundred characters for a list
 * subtitle, and prose stays in the document plane so it can merge per character
 * (ADR-0207), so the index reads the document rather than the row.
 */

import { pmToFragment } from '@y/prosemirror';
import * as Y from '@y/y';
import { describe, expect, test } from 'bun:test';
import { Schema } from 'prosemirror-model';
import { createNoteSearchIndex, readDocumentText } from './search-index.svelte';

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

describe('readDocumentText', () => {
	test('reads every block, which is the point', () => {
		const doc = documentOf('The opening line', 'A much later paragraph');
		expect(readDocumentText(doc)).toBe(
			'The opening line A much later paragraph',
		);
	});

	test('joins blocks with a space so adjacent words never merge', () => {
		expect(readDocumentText(documentOf('one', 'two'))).toBe('one two');
	});

	test('an empty document reads as empty rather than throwing', () => {
		expect(readDocumentText(new Y.Doc())).toBe('');
		expect(readDocumentText(documentOf(''))).toBe('');
	});

	test('a long note is not truncated, unlike the preview it replaces', () => {
		const long = 'word '.repeat(400).trim();
		const text = readDocumentText(documentOf('Title line', long));
		expect(text.length).toBeGreaterThan(1000);
		expect(text).toContain('Title line');
	});
});

describe('createNoteSearchIndex', () => {
	test('a warmed note answers with its whole body', () => {
		const index = createNoteSearchIndex({
			readText: (noteId) => `body of ${noteId}`,
			onError: () => undefined,
		});
		expect(index.textFor('a')).toBeUndefined();

		index.warm(['a', 'b']);
		expect(index.textFor('a')).toBe('body of a');
		expect(index.textFor('b')).toBe('body of b');
	});

	test('a note the editor already has open needs no sweep', () => {
		const read: string[] = [];
		const index = createNoteSearchIndex({
			readText: (noteId) => {
				read.push(noteId);
				return 'swept';
			},
			onError: () => undefined,
		});

		index.record('a', 'typed just now');
		index.warm(['a', 'b']);
		expect(index.textFor('a')).toBe('typed just now');
		expect(read).toEqual(['b']);
	});

	test('one unreadable document does not stop the sweep', () => {
		const failures: unknown[] = [];
		const index = createNoteSearchIndex({
			readText: (noteId) => {
				if (noteId === 'broken') throw new Error('cannot read');
				return `body of ${noteId}`;
			},
			onError: (cause) => failures.push(cause),
		});

		index.warm(['broken', 'fine']);
		expect(failures).toHaveLength(1);
		// The unreadable one stays unindexed and falls back to its preview; the
		// rest of the sweep still lands.
		expect(index.textFor('broken')).toBeUndefined();
		expect(index.textFor('fine')).toBe('body of fine');
	});

	test('a forgotten note is reindexed rather than remembered', () => {
		const index = createNoteSearchIndex({
			readText: () => 'body',
			onError: () => undefined,
		});
		index.warm(['a']);
		index.forget('a');
		expect(index.textFor('a')).toBeUndefined();
	});
});
