import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';

import { defineTable, optional } from './definitions.js';
import { serializeTableDefinition } from './wire.js';

const NAMESPACE = 'so.epicenter.test';

test('a table declaring no body carries no body key at all', () => {
	const table = defineTable({ fields: { title: field.string() } });

	// Absent, not `undefined`: a definition written before this key existed must
	// serialize to the same JSON it always did.
	expect('body' in table).toBe(false);
	expect(
		'body' in serializeTableDefinition(NAMESPACE, 'notes', table),
	).toBe(false);
});

test("a table declaring body: 'text' carries it through the wire form", () => {
	const table = defineTable({
		fields: { title: field.string(), tags: optional(field.string()) },
		body: 'text',
	});

	expect(table.body).toBe('text');

	const wire = serializeTableDefinition(NAMESPACE, 'notes', table);
	expect(wire.body).toBe('text');

	// The whole point of a string tag over a callback: the declaration survives
	// JSON, so a wire-named table rebuilt on the far side still knows its body is
	// renderable (ADR-0207).
	expect(JSON.parse(JSON.stringify(wire)).body).toBe('text');
});

test('an unknown body kind is refused at definition time', () => {
	expect(() =>
		defineTable({
			fields: { title: field.string() },
			// @ts-expect-error the vocabulary is closed on purpose
			body: 'xml',
		}),
	).toThrow("Unknown body kind 'xml'; the only kind is 'text'");
});

test('declaring a body does not add a field to the row', () => {
	const withBody = defineTable({
		fields: { title: field.string() },
		body: 'text',
	});
	const withoutBody = defineTable({ fields: { title: field.string() } });

	// A document is reached through `openDocument`, never as a field, so the two
	// definitions must project identical rows.
	expect(Object.keys(withBody.fields)).toEqual(Object.keys(withoutBody.fields));
	expect(withBody.fields).toEqual(withoutBody.fields);
});
