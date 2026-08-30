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

		// The codec builds its own body and hands it back (ADR-0296, amended), so
		// nothing here mints or attaches one first.
		const fields = expectOk(
			codec.deserialize({ data: { title: 'Title' }, content: markdown }),
		);
		// Integrated before it is read, the way `create` does it. A detached type
		// accumulates its writes in a prelim delta and READS AS EMPTY until
		// `_integrate` replays them, so serializing one straight out of the codec
		// would report an empty note and pass nothing.
		const document = new Y.Doc();
		try {
			const row = document.get('tables:notes');
			document.transact(() => {
				row.setAttr('body' as never, fields.body as never);
			});
			const body = row.getAttr('body' as never) as Y.Type;
			// What `deserialize` produced is what `serialize` reads back: the pair
			// is the identity on the text.
			expect(codec.serialize({ id: 'r1', ...fields, body }).content).toBe(
				markdown,
			);
			expect(body.toString()).toContain('Title');
		} finally {
			document.destroy();
		}
	});

	test('the body it returns is fresh, so two rows never share one', () => {
		const codec = honeycrispDefinition.tables.notes.file;
		if (codec === undefined)
			throw new Error('the notes table declares a codec');
		const one = expectOk(codec.deserialize({ data: {}, content: '# One' }));
		const two = expectOk(codec.deserialize({ data: {}, content: '# Two' }));
		expect(one.body).not.toBe(two.body);
		// Detached until `create` integrates it. A type that already belongs to a
		// document is what `createRow` refuses, because two rows given one type
		// would share one body.
		expect((one.body as Y.Type).doc).toBeNull();
	});
});
