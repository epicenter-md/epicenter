import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema';
import { jsonSchemaToYargsOptions } from './json-schema-to-yargs';

describe('jsonSchemaToYargsOptions', () => {
	test('converts string field to string option', () => {
		const schema = type({ title: 'string' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.title).toBeDefined();
		expect(options.title?.type).toBe('string');
		expect(options.title?.demandOption).toBe(true);
	});

	test('converts number field to number option', () => {
		const schema = type({ count: 'number' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.count).toBeDefined();
		expect(options.count?.type).toBe('number');
		expect(options.count?.demandOption).toBe(true);
	});

	test('converts integer field to number option', () => {
		const schema = type({ count: 'number.integer' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.count).toBeDefined();
		expect(options.count?.type).toBe('number');
	});

	test('converts boolean field to boolean option', () => {
		const schema = type({ published: 'boolean' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.published).toBeDefined();
		expect(options.published?.type).toBe('boolean');
		expect(options.published?.demandOption).toBe(true);
	});

	test('converts optional field to non-required option', () => {
		const schema = type({ 'title?': 'string' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.title).toBeDefined();
		expect(options.title?.type).toBe('string');
		expect(options.title?.demandOption).toBe(false);
	});

	test('converts string literal union to choices', () => {
		const schema = type({ status: "'draft' | 'published' | 'archived'" });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.status).toBeDefined();
		expect(options.status?.type).toBe('string');
		expect(options.status?.choices).toContain('draft');
		expect(options.status?.choices).toContain('published');
		expect(options.status?.choices).toContain('archived');
		expect(options.status?.choices).toHaveLength(3);
	});

	test('converts array field to array option', () => {
		const schema = type({ tags: 'string[]' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.tags).toBeDefined();
		expect(options.tags?.type).toBe('array');
	});

	test('handles multiple fields', () => {
		const schema = type({
			title: 'string',
			count: 'number',
			'published?': 'boolean',
		});
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(Object.keys(options)).toHaveLength(3);
		expect(options.title?.type).toBe('string');
		expect(options.title?.demandOption).toBe(true);
		expect(options.count?.type).toBe('number');
		expect(options.count?.demandOption).toBe(true);
		expect(options.published?.type).toBe('boolean');
		expect(options.published?.demandOption).toBe(false);
	});

	test('returns empty object for non-object schema', () => {
		const options = jsonSchemaToYargsOptions({ type: 'string' });
		expect(options).toEqual({});
	});

	test('handles schema without descriptions gracefully', () => {
		const schema = type({ title: 'string' });
		const jsonSchema = standardSchemaToJsonSchema(schema);
		const options = jsonSchemaToYargsOptions(jsonSchema);

		expect(options.title?.description).toBeUndefined();
	});
});
