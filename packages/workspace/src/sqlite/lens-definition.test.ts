/**
 * Release-local Table Lens Definition Tests
 *
 * Verifies that definitions own only present-value validation and projection,
 * while storage identity and required-field presence remain outside schemas.
 *
 * Key behaviors:
 * - `id` is structural and cannot be declared
 * - optional fields are validated against declared field names
 * - only the closed `field.*` vocabulary is accepted
 */

import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import { defineTable } from './lens-definition.js';

test('defineTable keeps id structural and fields immutable', () => {
	const definition = defineTable({
		fields: { title: field.string() },
		optional: ['title'],
	});

	expect(definition.fields.title.type).toBe('string');
	expect(Object.keys(definition.fields)).toEqual(['title']);
	expect(Object.isFrozen(definition)).toBe(true);
	expect(Object.isFrozen(definition.fields)).toBe(true);
	expect(Object.isFrozen(definition.optional)).toBe(true);
	expect(() =>
		defineTable({
			fields: { id: field.string(), title: field.string() } as never,
		}),
	).toThrow(/structural 'id'/);
	expect(() =>
		defineTable({
			fields: { ID: field.string(), title: field.string() },
		}),
	).toThrow(/structural 'id'/);
	expect(() =>
		defineTable({
			fields: { title: field.string(), Title: field.string() },
		}),
	).toThrow(/collides with another field in SQLite/);
});

test('defineTable refuses unknown and duplicate optional names', () => {
	expect(() =>
		defineTable({
			fields: { title: field.string() },
			optional: ['missing'] as never,
		}),
	).toThrow("Optional field 'missing' is not declared");
	expect(() =>
		defineTable({
			fields: { title: field.string() },
			optional: ['title', 'title'],
		}),
	).toThrow("Optional field 'title' is listed twice");
});

test('defineTable refuses schemas outside the field vocabulary', () => {
	expect(() =>
		defineTable({
			fields: { nested: Type.Object({ value: Type.String() }) },
		}),
	).toThrow("Field 'nested' must use the field.* vocabulary");
});
