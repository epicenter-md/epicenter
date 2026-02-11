import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Type } from 'typebox';
import { id, integer, json, select, text } from '../../schema';
import { tableToArktype } from './to-arktype';

describe('tableToArktype', () => {
	test('returns a complete arktype Type instance', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			integer({ id: 'count' }),
		] as const;

		const validator = tableToArktype(fields);

		expect(validator).toBeDefined();
		expect(typeof validator).toBe('function');
	});

	test('validates complete objects correctly', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			integer({ id: 'count' }),
		] as const;

		const validator = tableToArktype(fields);

		const valid = validator({
			id: 'test-123',
			title: 'Hello',
			count: 42,
		});

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('rejects invalid objects', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			integer({ id: 'count' }),
		] as const;

		const validator = tableToArktype(fields);

		const invalid = validator({
			id: 'test-123',
			title: 'Hello',
			count: 'not a number',
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	test('supports .partial() composition', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			integer({ id: 'count' }),
		] as const;

		const validator = tableToArktype(fields);
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
		const fields = [id(), text({ id: 'title' })] as const;

		const validator = tableToArktype(fields);
		const arrayValidator = validator.array();

		const valid = arrayValidator([
			{ id: '1', title: 'First' },
			{ id: '2', title: 'Second' },
		]);

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('supports .merge() composition', () => {
		const fields = [id(), text({ id: 'title' })] as const;

		const validator = tableToArktype(fields);
		const merged = validator.merge({ extra: type.boolean });

		const valid = merged({
			id: '123',
			title: 'Test',
			extra: true,
		});

		expect(valid).not.toBeInstanceOf(type.errors);
	});

	test('handles complex nested schema', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			json({
				id: 'metadata',
				schema: Type.Object({
					author: Type.String(),
					tags: Type.Array(Type.String()),
				}),
			}),
			select({ id: 'status', options: ['draft', 'published'] as const }),
		] as const;

		const validator = tableToArktype(fields);

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
		const fields = [
			id(),
			text({ id: 'title' }),
			text({ id: 'subtitle', nullable: true }),
			integer({ id: 'count', nullable: true }),
			select({
				id: 'status',
				options: ['draft', 'published'] as const,
				nullable: true,
			}),
		] as const;

		const validator = tableToArktype(fields);

		// Missing nullable fields should default to null
		const result = validator({
			id: 'test-123',
			title: 'Required Title',
			// subtitle, count, and status are omitted
		});

		expect(result).not.toBeInstanceOf(type.errors);
		if (!(result instanceof type.errors)) {
			const row = result as {
				subtitle: string | null;
				count: number | null;
				status: string | null;
			};
			expect(row.subtitle).toBe(null);
			expect(row.count).toBe(null);
			expect(row.status).toBe(null);
		}
	});

	test('required fields must be present even when nullable fields are omitted', () => {
		const fields = [
			id(),
			text({ id: 'title' }), // required
			text({ id: 'subtitle', nullable: true }), // optional, defaults to null
		] as const;

		const validator = tableToArktype(fields);

		// Missing required field should fail validation
		const invalid = validator({
			id: 'test-123',
			// title is missing (required)
			subtitle: 'Optional subtitle',
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	test('nullable fields accept null explicitly', () => {
		const fields = [
			id(),
			text({ id: 'title' }),
			text({ id: 'subtitle', nullable: true }),
		] as const;

		const validator = tableToArktype(fields);

		const result = validator({
			id: 'test-123',
			title: 'Title',
			subtitle: null, // explicitly null
		});

		expect(result).not.toBeInstanceOf(type.errors);
		if (!(result instanceof type.errors)) {
			const row = result as { subtitle: string | null };
			expect(row.subtitle).toBe(null);
		}
	});
});
