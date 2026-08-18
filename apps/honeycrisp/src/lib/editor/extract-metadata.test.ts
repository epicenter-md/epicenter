/**
 * Tests for note metadata derivation.
 *
 * These lock the two extraction bugs fixed alongside the editor init repair: the
 * title must come from the first block alone (not every block concatenated), and
 * the preview must separate adjacent blocks with a space (not run the last word
 * of one block into the first word of the next).
 */

import { describe, expect, test } from 'bun:test';
import { type Node, Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { extractNoteMetadata } from './extract-metadata.js';

const schema = new Schema({
	nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
	marks: basicSchema.spec.marks,
});

/** Build a doc from one paragraph per argument (an empty string is an empty paragraph). */
function docOf(...paragraphs: string[]): Node {
	const blocks = paragraphs.map((text) =>
		text.length === 0
			? schema.nodes.paragraph!.create()
			: schema.nodes.paragraph!.create(null, schema.text(text)),
	);
	return schema.nodes.doc!.create(null, blocks);
}

describe('extractNoteMetadata', () => {
	test('title is the first block only, not every block concatenated', () => {
		const { title } = extractNoteMetadata(docOf('My Title', 'Body text'));
		expect(title).toBe('My Title');
	});

	test('preview separates adjacent blocks with a space', () => {
		const { preview } = extractNoteMetadata(docOf('Hello', 'World'));
		expect(preview).toBe('Hello World');
	});

	test('empty document yields empty metadata', () => {
		expect(extractNoteMetadata(docOf(''))).toEqual({
			title: '',
			preview: '',
		});
	});

	test('title is capped at 80 characters', () => {
		const long = 'x'.repeat(200);
		expect(extractNoteMetadata(docOf(long)).title).toHaveLength(80);
	});

	test('preview is capped at 100 characters', () => {
		const long = 'y'.repeat(200);
		expect(extractNoteMetadata(docOf(long)).preview).toHaveLength(100);
	});
});
