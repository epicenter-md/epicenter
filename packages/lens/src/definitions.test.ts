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
	expect('body' in serializeTableDefinition(NAMESPACE, 'notes', table)).toBe(
		false,
	);
});

test('a declared body names one of the table’s own fields', () => {
	const table = defineTable({
		fields: {
			title: field.string(),
			content: field.string(),
			tags: optional(field.tags()),
		},
		body: 'content',
	});

	expect(table.body).toBe('content');
	expect(serializeTableDefinition(NAMESPACE, 'notes', table).body).toBe(
		'content',
	);
});

test('a body naming an undeclared field is refused', () => {
	expect(() =>
		defineTable({
			fields: { title: field.string() },
			// @ts-expect-error only a declared field name is accepted
			body: 'content',
		}),
	).toThrow("Body field 'content' is not a declared field");
});

test('a body must be prose, not some other field kind', () => {
	// Every other kind has a YAML representation that belongs in frontmatter, and
	// a body is written verbatim with no type to recover it by.
	expect(() =>
		defineTable({ fields: { count: field.integer() }, body: 'count' }),
	).toThrow("Body field 'count' must be field.string(), not field.integer()");

	expect(() =>
		defineTable({
			fields: { status: field.select(['draft', 'live']) },
			body: 'status',
		}),
	).toThrow("Body field 'status' must be field.string(), not field.select()");
});

test('the body is an ordinary field, not a fourth thing', () => {
	const table = defineTable({
		fields: { title: field.string(), content: field.string() },
		body: 'content',
	});

	// The whole simplification in one assertion: declaring a body changes where
	// the value is written, never what the row holds.
	expect(Object.keys(table.fields)).toEqual(['title', 'content']);
	expect(
		serializeTableDefinition(NAMESPACE, 'notes', table).fields,
	).toHaveProperty('content');
});
