import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { honeycrispDefinition, NOTE_BODY } from '../data/index.js';
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

	test('the declared codec round-trips a body through a Yjs document', () => {
		const codec = honeycrispDefinition.tables.notes.document.file;
		const markdown = [
			'# Title',
			'',
			'Body with **bold**.',
			'',
			'- [x] done',
		].join('\n');

		const written = new Y.Doc();
		try {
			const reader = written as unknown as {
				get(root: string, typeName?: string | null): unknown;
			};
			codec.deserialize(markdown, reader);
			// What was written through `deserialize` is what `serialize` reads back:
			// the export/import pair over one document is the identity on the text.
			expect(codec.serialize(reader)).toBe(markdown);
			// And the body landed at the root every open names (ADR-0248).
			expect(String(written.get(NOTE_BODY).toString())).toContain('Title');
		} finally {
			written.destroy();
		}
	});
});
