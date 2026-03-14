/**
 * defineKv Tests
 *
 * Verifies that `defineKv(schema, defaultValue)` produces correct KvDefinitions
 * with validate-or-default semantics. No migration—invalid data falls back to default.
 *
 * Key behaviors:
 * - Schema validates values correctly
 * - Default value is stored on the definition
 * - Primitive and object schemas both work
 */

import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineKv } from './define-kv.js';

test('creates valid KV definition with object schema', () => {
	const theme = defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' });

	const result = theme.schema['~standard'].validate({ mode: 'dark' });
	expect(result).not.toHaveProperty('issues');
});

test('stores the default value on the definition', () => {
	const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), {
		collapsed: false,
		width: 300,
	});

	expect(sidebar.defaultValue).toEqual({ collapsed: false, width: 300 });
});

test('primitive schema validates correctly', () => {
	const fontSize = defineKv(type('number'), 0);

	const result = fontSize.schema['~standard'].validate(14);
	expect(result).not.toHaveProperty('issues');
	expect(fontSize.defaultValue).toBe(0);
});

test('boolean schema validates correctly', () => {
	const enabled = defineKv(type('boolean'), true);

	const valid = enabled.schema['~standard'].validate(false);
	expect(valid).not.toHaveProperty('issues');

	const invalid = enabled.schema['~standard'].validate('not-a-boolean');
	expect(invalid).toHaveProperty('issues');
});

test('rejects invalid data', () => {
	const theme = defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' });

	const result = theme.schema['~standard'].validate({ mode: 'invalid' });
	expect(result).toHaveProperty('issues');
});

test('string enum schema validates correctly', () => {
	const mode = defineKv(type("'light' | 'dark' | 'system'"), 'light');

	const valid = mode.schema['~standard'].validate('system');
	expect(valid).not.toHaveProperty('issues');

	const invalid = mode.schema['~standard'].validate('neon');
	expect(invalid).toHaveProperty('issues');
});
