/**
 * Reading a Lens that arrived as data (ADR-0168, ADR-0210).
 *
 * The claim under test is the round trip: a Lens an application authored with
 * `defineLens` survives `JSON.stringify` and comes back usable, and everything
 * that is not a Lens is refused with a sentence rather than a throw.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { defineLens, defineTable, optional } from './definitions.js';
import { lensFromJson, lensFromJsonText } from './from-json.js';

const authored = defineLens({
	namespace: 'so.epicenter.vocab',
	title: 'Vocab',
	tables: {
		entries: defineTable({
			fields: {
				term: field.string(),
				reading: optional(field.string()),
				seen: field.number(),
				note: field.string(),
			},
			body: 'note',
		}),
	},
});

/** What an installed app ships: the authored Lens, serialized. */
const serialized = JSON.stringify(authored);

describe('a round trip preserves the whole Lens', () => {
	test('namespace, title, table names, and field names survive', () => {
		const { data: lens, error } = lensFromJsonText(serialized);
		expect(error).toBeNull();
		expect(lens?.namespace).toBe('so.epicenter.vocab');
		expect(lens?.title).toBe('Vocab');
		expect(Object.keys(lens?.tables ?? {})).toEqual(['entries']);
		expect(Object.keys(lens?.tables.entries?.fields ?? {})).toEqual([
			'term',
			'reading',
			'seen',
			'note',
		]);
	});

	test('the body designation survives, because prose is addressed by it', () => {
		const { data: lens } = lensFromJsonText(serialized);
		expect(lens?.tables.entries?.body).toBe('note');
	});

	test('the recovered Lens serializes to the same bytes', () => {
		const { data: lens } = lensFromJsonText(serialized);
		expect(JSON.stringify(lens)).toBe(serialized);
	});

	test('a Lens with no title round trips without growing one', () => {
		const untitled = defineLens({
			namespace: 'so.epicenter.plain',
			tables: { rows: defineTable({ fields: { a: field.string() } }) },
		});
		const { data: lens } = lensFromJsonText(JSON.stringify(untitled));
		expect(lens?.title).toBeUndefined();
		expect(JSON.stringify(lens)).toBe(JSON.stringify(untitled));
	});
});

describe('what is refused, and with what sentence', () => {
	test('a field outside the field.* vocabulary', () => {
		const { data, error } = lensFromJson({
			namespace: 'so.epicenter.bad',
			// `{ type: 'string' }` would be accepted, because that is exactly what
			// `field.string()` serializes to. This is a shape the vocabulary has no
			// reading for, which is what an app inventing its own schema looks like.
			tables: { rows: { fields: { a: { type: 'object' } } } },
		});
		expect(data).toBeNull();
		expect(error?.message).toContain('field.*');
	});

	test('a table name that is not a bare SQL identifier', () => {
		const { error } = lensFromJson({
			namespace: 'so.epicenter.bad',
			tables: { 'not a table': { fields: { a: field.string() } } },
		});
		expect(error).not.toBeNull();
	});

	test('a single-label namespace, which is what an app id looks like', () => {
		const { data, error } = lensFromJson({
			namespace: 'vocab',
			tables: { rows: { fields: { a: field.string() } } },
		});
		expect(data).toBeNull();
		expect(error?.message).toContain('namespace');
	});

	test('two table names differing only in case', () => {
		const { error } = lensFromJson({
			namespace: 'so.epicenter.bad',
			tables: {
				rows: { fields: { a: field.string() } },
				Rows: { fields: { a: field.string() } },
			},
		});
		expect(error).not.toBeNull();
	});

	test('a body field that is not prose', () => {
		const { error } = lensFromJson({
			namespace: 'so.epicenter.bad',
			tables: { rows: { fields: { n: field.number() } , body: 'n' } },
		});
		expect(error).not.toBeNull();
	});

	test('a title that is not a string', () => {
		const { error } = lensFromJson({
			namespace: 'so.epicenter.bad',
			title: 7,
			tables: { rows: { fields: { a: field.string() } } },
		});
		expect(error?.message).toContain('title');
	});

	test('malformed JSON text, rather than a malformed Lens', () => {
		const { data, error } = lensFromJsonText('{ not json');
		expect(data).toBeNull();
		expect(error).not.toBeNull();
	});

	for (const [label, value] of [
		['null', null],
		['an array', []],
		['a string', 'so.epicenter.vocab'],
		['no tables', { namespace: 'so.epicenter.vocab' }],
		['no namespace', { tables: {} }],
	] as const) {
		test(`${label} is not a Lens`, () => {
			const { data, error } = lensFromJson(value);
			expect(data).toBeNull();
			expect(error).not.toBeNull();
		});
	}
});

describe('the recovered Lens is usable, not just shaped right', () => {
	test('its table definition compiles, so a row can be projected through it', () => {
		const { data: lens } = lensFromJsonText(serialized);
		// A definition that was merely parsed and not rebuilt would be unknown to
		// the compiler registry, and this is what would catch that.
		const authoredAgain = defineLens({
			namespace: lens?.namespace ?? '',
			tables: lens?.tables ?? {},
		});
		expect(authoredAgain.namespace).toBe('so.epicenter.vocab');
	});
});
