import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { expectOk } from 'wellcrafted/testing';

import { honeycrispDefinition } from '../data/index.js';
import { parseNoteBody, serializeNoteBody } from './markdown.js';
import { noteSchema } from './schema.js';

/** Parse, serialize, and hand back the text: the fixpoint a note must hold. */
function roundTrip(markdown: string): string {
	return serializeNoteBody(parseNoteBody(markdown));
}

describe('the note body Markdown codec', () => {
	test('prose round-trips through its own export', () => {
		const markdown = [
			'# Groceries',
			'',
			'A list with **bold**, *emphasis*, `code`, and a [link](https://example.com).',
			'',
			'> quoted',
			'',
			'* milk',
			'* eggs',
			'',
			'1. first',
			'2. second',
		].join('\n');
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('strikethrough survives both directions', () => {
		const markdown = 'keep ~~gone~~ keep';
		const parsed = parseNoteBody(markdown);
		const strikes: string[] = [];
		parsed.descendants((node) => {
			if (node.marks.some((mark) => mark.type.name === 'strike')) {
				strikes.push(node.textContent);
			}
		});
		expect(strikes).toEqual(['gone']);
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('a task list round-trips with its checked state', () => {
		const markdown = ['- [x] milk', '- [ ] eggs'].join('\n');
		const parsed = parseNoteBody(markdown);
		const items: boolean[] = [];
		parsed.descendants((node) => {
			if (node.type.name === 'taskItem')
				items.push(Boolean(node.attrs.checked));
		});
		expect(items).toEqual([true, false]);
		expect(roundTrip(markdown)).toBe(markdown);
	});

	test('a list mixing task markers and plain items stays a bullet list', () => {
		const markdown = ['* [x] milk', '* eggs'].join('\n');
		const parsed = parseNoteBody(markdown);
		let taskItems = 0;
		parsed.descendants((node) => {
			if (node.type.name === 'taskItem') taskItems += 1;
		});
		// Half-marked is not a task list; the markers stay visible text, which is
		// also exactly what the file showed. The serializer escapes the literal
		// bracket on the way out, so the contract here is content, not bytes: the
		// re-emitted file parses back to the same document.
		expect(taskItems).toBe(0);
		expect(parseNoteBody(roundTrip(markdown)).eq(parsed)).toBe(true);
	});

	test('underline keeps its text and loses its mark', () => {
		const underlined = noteSchema.node('doc', null, [
			noteSchema.node('paragraph', null, [
				noteSchema.text('kept', [noteSchema.mark('underline')]),
			]),
		]);
		expect(serializeNoteBody(underlined)).toBe('kept');
	});

	test('the declared codec round-trips a body through an attached type', () => {
		const codec = honeycrispDefinition.tables.notes.file;
		if (codec === undefined)
			throw new Error('the notes table declares a codec');
		const markdown = [
			'# Title',
			'',
			'Body with **bold**.',
			'',
			'- [x] done',
		].join('\n');

		// An ATTACHED type, because that is the only kind the codec is ever
		// handed (ADR-0296): a detached one replays a single positional prelim
		// delta, and a Markdown conversion is many sequential writes.
		const document = new Y.Doc();
		try {
			const row = document.get('tables:notes');
			const body = new Y.Type();
			document.transact(() => {
				row.setAttr('body' as never, body as never);
			});

			const fields = expectOk(
				codec.deserialize(
					{ data: { title: 'Title' }, content: markdown },
					{
						body,
					},
				),
			);
			// What was written through `deserialize` is what `serialize` reads
			// back: the pair is the identity on the text.
			expect(codec.serialize({ id: 'r1', ...fields, body }).content).toBe(
				markdown,
			);
			expect(body.toString()).toContain('Title');
		} finally {
			document.destroy();
		}
	});
});
