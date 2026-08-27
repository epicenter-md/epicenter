import { describe, expect, test } from 'bun:test';
import { defineData, field, parseData, type RowOf } from './definition.js';

const authored = defineData({
	id: 'so.epicenter.data',
	kv: {
		name: field.string(),
		color: field.nullable(field.string()),
	},
	tables: {
		notes: {
			title: field.string(),
			status: field.select(['draft', 'published']),
			tags: field.multiSelect(['work', 'personal']),
			publishedAt: field.nullable(field.instant()),
		},
	},
});

function parsed() {
	const result = parseData(JSON.parse(JSON.stringify(authored)));
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

describe('data definitions', () => {
	test('authored and serialized definitions compile identically', () => {
		const serialized = JSON.parse(JSON.stringify(authored));
		const result = parseData(serialized);
		expect(result.error).toBeNull();
		expect(result.data?.canonical).toBe(parseData(authored).data?.canonical);
	});

	test('missing fields are nonconforming, including nullable fields', () => {
		const result = parsed().tables.get('notes')!.conformance({
			title: 'one',
			status: 'draft',
			tags: [],
		});
		expect(result.conforming).toEqual({
			title: 'one',
			status: 'draft',
			tags: [],
		});
		expect(result.issues.map((issue) => issue.field)).toEqual(['publishedAt']);
	});

	test('nullable accepts null while non-nullable rejects it', () => {
		const table = parsed().tables.get('notes')!;
		expect(
			table.conformance({
				title: 'one',
				status: 'draft',
				tags: [],
				publishedAt: null,
			}).issues,
		).toEqual([]);
		const invalid = table.conformance({
			title: null,
			status: 'draft',
			tags: [],
			publishedAt: null,
		});
		expect(invalid.conforming).toEqual({
			status: 'draft',
			tags: [],
			publishedAt: null,
		});
		expect(invalid.issues.map((issue) => issue.field)).toEqual(['title']);
	});

	test('invalid values preserve conforming fields', () => {
		const result = parsed().tables.get('notes')!.conformance({
			title: 'one',
			status: 'broken',
			tags: 'not-an-array',
			publishedAt: null,
		});
		expect(result.conforming).toEqual({ title: 'one', publishedAt: null });
		expect(result.issues.map((issue) => issue.field)).toEqual([
			'status',
			'tags',
		]);
	});

	test('undefined is not storage JSON', () => {
		const table = parsed().tables.get('notes')!;
		expect(() => table.validateWrite({ title: undefined })).toThrow();
	});

	test('declaration defaults are rejected', () => {
		const result = parseData({
			id: 'so.epicenter.defaults',
			kv: {},
			tables: {
				notes: { title: { type: field.string(), default: 'untitled' } },
			},
		});
		expect(result.error?.name).toBe('DeclarationDefault');
	});

	test('field.json preserves an inner static type at the row boundary', () => {
		const data = defineData({
			id: 'so.epicenter.json',
			kv: {},
			tables: { rows: { payload: field.json(field.select(['a', 'b'])) } },
		});
		const row: RowOf<typeof data.tables.rows> = { id: '1', payload: 'a' };
		expect(row.payload).toBe('a');
	});
});
