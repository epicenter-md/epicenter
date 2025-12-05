import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	createTableValidators,
	id,
	integer,
	json,
	select,
	tags,
	text,
	ytext,
} from './index';

describe('createTableValidators', () => {
	describe('toArktype() validation', () => {
		test('validates valid data', () => {
			const validators = createTableValidators({
				id: id(),
				title: text(),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				title: 'Hello World',
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result).toEqual({ id: '123', title: 'Hello World' });
			}
		});

		test('validates ytext strings', () => {
			const validators = createTableValidators({
				id: id(),
				content: ytext(),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				content: 'Hello World',
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(typeof result.content).toBe('string');
				expect(result.content).toBe('Hello World');
			}
		});

		test('validates multi-select arrays', () => {
			const validators = createTableValidators({
				id: id(),
				tags: tags({ options: ['typescript', 'javascript', 'python'] }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				tags: ['typescript', 'javascript'],
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(Array.isArray(result.tags)).toBe(true);
				expect(result.tags).toEqual(['typescript', 'javascript']);
			}
		});

		test('returns errors for wrong types', () => {
			const validators = createTableValidators({
				id: id(),
				count: integer(),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				count: 'not a number',
			});

			expect(result instanceof type.errors).toBe(true);
			if (result instanceof type.errors) {
				expect(result.summary).toContain('count');
			}
		});

		test('validates select options', () => {
			const validators = createTableValidators({
				id: id(),
				status: select({ options: ['draft', 'published'] }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				status: 'draft',
			});

			expect(result instanceof type.errors).toBe(false);
		});

		test('returns errors for invalid select option', () => {
			const validators = createTableValidators({
				id: id(),
				status: select({ options: ['draft', 'published'] }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				status: 'invalid',
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates nullable fields', () => {
			const validators = createTableValidators({
				id: id(),
				optional: text({ nullable: true }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				optional: null,
			});

			expect(result instanceof type.errors).toBe(false);
		});

		test('returns errors for missing required fields', () => {
			const validators = createTableValidators({
				id: id(),
				title: text(),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				// Missing title
			});

			expect(result instanceof type.errors).toBe(true);
			if (result instanceof type.errors) {
				expect(result.summary).toContain('title');
			}
		});

		test('validates multi-select options in array', () => {
			const validators = createTableValidators({
				id: id(),
				tags: tags({ options: ['typescript', 'javascript', 'python'] }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				tags: ['invalid-tag'],
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates JSON with valid data', () => {
			const configSchema = type({
				theme: 'string',
				autoSave: 'boolean',
			});

			const validators = createTableValidators({
				id: id(),
				config: json({ schema: configSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				config: {
					theme: 'dark',
					autoSave: true,
				},
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result.config).toEqual({
					theme: 'dark',
					autoSave: true,
				});
			}
		});

		test('returns errors for JSON with invalid data', () => {
			const configSchema = type({
				theme: 'string',
				autoSave: 'boolean',
			});

			const validators = createTableValidators({
				id: id(),
				config: json({ schema: configSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				config: {
					theme: 'dark',
					autoSave: 'not a boolean', // Invalid
				},
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates nullable JSON', () => {
			const metaSchema = type({
				version: 'string',
			});

			const validators = createTableValidators({
				id: id(),
				meta: json({ schema: metaSchema, nullable: true }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				meta: null,
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result.meta).toBe(null);
			}
		});

		test('validates JSON with complex nested structures', () => {
			const productSchema = type({
				name: 'string',
				price: 'number',
				tags: 'string[]',
				metadata: {
					category: 'string',
					inStock: 'boolean',
				},
			});

			const validators = createTableValidators({
				id: id(),
				product: json({ schema: productSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				product: {
					name: 'Widget',
					price: 29.99,
					tags: ['electronics', 'gadgets'],
					metadata: {
						category: 'tech',
						inStock: true,
					},
				},
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result.product).toEqual({
					name: 'Widget',
					price: 29.99,
					tags: ['electronics', 'gadgets'],
					metadata: {
						category: 'tech',
						inStock: true,
					},
				});
			}
		});

		test('returns errors for non-serialized cell values', () => {
			const validators = createTableValidators({
				id: id(),
				count: integer(),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				count: new Y.Text(), // Y.js types don't match integer schema
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates select options and returns errors for invalid options', () => {
			const validators = createTableValidators({
				id: id(),
				status: select({ options: ['draft', 'published'] }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				status: 'invalid',
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates multi-select structure and options', () => {
			const validators = createTableValidators({
				id: id(),
				tags: tags({ options: ['typescript', 'javascript', 'python'] }),
			});

			const validator = validators.toArktype();

			// Invalid structure (not an array)
			const result1 = validator({
				id: '123',
				tags: new Y.Text(), // Y.js types don't match array schema
			});

			expect(result1 instanceof type.errors).toBe(true);

			// Invalid option (valid structure, bad value)
			const result2 = validator({
				id: '123',
				tags: ['invalid-tag'],
			});

			expect(result2 instanceof type.errors).toBe(true);
		});

		test('validates JSON with plain object', () => {
			const userSchema = type({
				username: 'string',
				role: 'string',
			});

			const validators = createTableValidators({
				id: id(),
				user: json({ schema: userSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				user: {
					username: 'john_doe',
					role: 'admin',
				},
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result.user).toEqual({
					username: 'john_doe',
					role: 'admin',
				});
			}
		});

		test('returns errors for JSON with Y.js types', () => {
			const dataSchema = type({
				content: 'string',
			});

			const validators = createTableValidators({
				id: id(),
				data: json({ schema: dataSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				data: new Y.Text(), // Y.js type doesn't match JSON schema
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('returns errors for JSON with invalid data structure', () => {
			const settingsSchema = type({
				notifications: 'boolean',
				volume: 'number',
			});

			const validators = createTableValidators({
				id: id(),
				settings: json({ schema: settingsSchema }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				settings: {
					notifications: true,
					volume: 'loud', // Invalid: should be number
				},
			});

			expect(result instanceof type.errors).toBe(true);
		});

		test('validates nullable JSON with null value', () => {
			const preferencesSchema = type({
				language: 'string',
			});

			const validators = createTableValidators({
				id: id(),
				preferences: json({ schema: preferencesSchema, nullable: true }),
			});

			const validator = validators.toArktype();
			const result = validator({
				id: '123',
				preferences: null,
			});

			expect(result instanceof type.errors).toBe(false);
			if (!(result instanceof type.errors)) {
				expect(result.preferences).toBe(null);
			}
		});
	});
});
