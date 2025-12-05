import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { id, integer, json, select, text } from '../../schema';
import { tableSchemaToArktypeType } from './arktype';

describe('tableSchemaToArktypeType', () => {
	test('returns a complete arktype Type instance', () => {
		const schema = {
			id: id(),
			title: text(),
			count: integer(),
		};

		const validator = tableSchemaToArktypeType(schema);

		expect(validator).toBeDefined();
		expect(typeof validator).toBe('function');
	});

	test('validates complete objects correctly', () => {
		const schema = {
			id: id(),
			title: text(),
			count: integer(),
		};

		const validator = tableSchemaToArktypeType(schema);

		const valid = validator({
			id: 'test-123',
			title: 'Hello',
			count: 42,
		});

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('rejects invalid objects', () => {
		const schema = {
			id: id(),
			title: text(),
			count: integer(),
		};

		const validator = tableSchemaToArktypeType(schema);

		const invalid = validator({
			id: 'test-123',
			title: 'Hello',
			count: 'not a number',
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	test('supports .partial() composition', () => {
		const schema = {
			id: id(),
			title: text(),
			count: integer(),
		};

		const validator = tableSchemaToArktypeType(schema);
		const partialValidator = validator.partial().merge({ id: type.string });

		// Should allow partial objects
		const valid = partialValidator({
			id: 'test-123',
			title: 'Hello',
			// count is omitted
		});

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('supports .array() composition', () => {
		const schema = {
			id: id(),
			title: text(),
		};

		const validator = tableSchemaToArktypeType(schema);
		const arrayValidator = validator.array();

		const valid = arrayValidator([
			{ id: '1', title: 'First' },
			{ id: '2', title: 'Second' },
		]);

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('supports .merge() composition', () => {
		const schema = {
			id: id(),
			title: text(),
		};

		const validator = tableSchemaToArktypeType(schema);
		const merged = validator.merge({ extra: type.boolean });

		const valid = merged({
			id: '123',
			title: 'Test',
			extra: true,
		});

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('handles complex nested schema', () => {
		const schema = {
			id: id(),
			title: text(),
			metadata: json({
				schema: type({
					author: 'string',
					tags: type.string.array(),
				}),
			}),
			status: select({ options: ['draft', 'published'] as const }),
		};

		const validator = tableSchemaToArktypeType(schema);

		const valid = validator({
			id: 'post-123',
			title: 'My Post',
			metadata: { author: 'John Doe', tags: ['tech', 'tutorial'] },
			status: 'draft',
		});

		expect(valid).not.toBeInstanceOf(type.errors);

		// Should reject invalid metadata
		const invalid = validator({
			id: 'post-123',
			title: 'My Post',
			metadata: { arbitrary: 'data' }, // Missing required fields
			status: 'draft',
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	test('nullable fields with .default(null) can be omitted and default to null', () => {
		const schema = {
			id: id(),
			title: text(),
			subtitle: text({ nullable: true }),
			count: integer({ nullable: true }),
			status: select({
				options: ['draft', 'published'] as const,
				nullable: true,
			}),
		};

		const validator = tableSchemaToArktypeType(schema);

		// Missing nullable fields should default to null
		const result = validator({
			id: 'test-123',
			title: 'Required Title',
			// subtitle, count, and status are omitted
		});

		expect(result).not.toBeInstanceOf(type.errors);
		if (!(result instanceof type.errors)) {
			expect(result.subtitle).toBe(null);
			expect(result.count).toBe(null);
			expect(result.status).toBe(null);
		}
	});

	test('required fields must be present even when nullable fields are omitted', () => {
		const schema = {
			id: id(),
			title: text(), // required
			subtitle: text({ nullable: true }), // optional, defaults to null
		};

		const validator = tableSchemaToArktypeType(schema);

		// Missing required field should fail validation
		const invalid = validator({
			id: 'test-123',
			// title is missing (required)
			subtitle: 'Optional subtitle',
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	test('nullable fields accept null explicitly', () => {
		const schema = {
			id: id(),
			title: text(),
			subtitle: text({ nullable: true }),
		};

		const validator = tableSchemaToArktypeType(schema);

		const result = validator({
			id: 'test-123',
			title: 'Title',
			subtitle: null, // explicitly null
		});

		expect(result).not.toBeInstanceOf(type.errors);
		if (!(result instanceof type.errors)) {
			expect(result.subtitle).toBe(null);
		}
	});
});
