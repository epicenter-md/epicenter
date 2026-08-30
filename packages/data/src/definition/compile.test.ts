import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { parseData } from './compile.js';
import { field, type RowOf } from './declaration.js';
import { defineData, defineTable } from './define.js';

const authored = defineData({
	id: 'so.epicenter.data',
	kv: {
		name: field.string(),
		color: field.nullable(field.string()),
	},
	tables: {
		notes: {
			scalars: {
				title: field.string(),
				status: field.select(['draft', 'published']),
				tags: field.multiSelect(['work', 'personal']),
				publishedAt: field.nullable(field.instant()),
			},
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

	test('a type field compiles to a name, not a column', () => {
		// `field.type()` holds a nested `Y.Type` and no JSON value (ADR-0296), so
		// it has no schema to check a payload against and nothing a conformance
		// read could report. It compiles into `types` and out of `fields`.
		const result = parseData({
			id: 'so.epicenter.typed',
			kv: {},
			tables: {
				notes: { scalars: { title: field.string() }, types: ['body'] },
			},
		});
		const notes = expectOk(result).tables.get('notes');
		expect([...(notes?.fields.keys() ?? [])]).toEqual(['title']);
		expect(notes?.types).toEqual(['body']);
		expect(notes?.conformance({ title: 'x' }).issues).toEqual([]);
	});

	test('a type field cannot be declared on a table twice', () => {
		const result = parseData({
			id: 'so.epicenter.dupes',
			kv: {},
			tables: {
				notes: { scalars: { title: field.string() }, types: ['body', 'body'] },
			},
		});
		expect(result.error?.name).toBe('Malformed');
	});

	test('a name cannot be both a scalar and a type field', () => {
		const result = parseData({
			id: 'so.epicenter.collide',
			kv: {},
			tables: {
				notes: { scalars: { body: field.string() }, types: ['body'] },
			},
		});
		expect(result.error?.name).toBe('Malformed');
	});

	test('a table with type content and no codec is refused where it is authored', () => {
		// The rule lives at the authoring call and nowhere else (ADR-0296): a
		// codec is a function, so a definition that arrived as JSON cannot carry
		// one and its absence there says nothing.
		expect(() =>
			defineData({
				id: 'so.epicenter.nocodec',
				kv: {},
				tables: {
					notes: { scalars: { title: field.string() }, types: ['body'] },
				},
			}),
		).toThrow('file codec');
	});

	test('a serialized codec husk compiles as no codec', () => {
		// Behaviors are code and cannot arrive as data (ADR-0266): a definition
		// round-tripped through JSON loses its functions, and that husk must be
		// parseable, because an app bundle's `database.json` is read for its id.
		const authored = defineTable({
			scalars: { title: field.string() },
			types: ['body'],
			file: {
				serialize: () => ({ data: {}, content: '' }),
				deserialize: () => Ok({ title: '' }),
			},
		});
		const result = parseData(
			JSON.parse(
				JSON.stringify({
					id: 'so.epicenter.husk',
					kv: {},
					tables: { notes: authored },
				}),
			),
		);
		expect(result.error).toBeNull();
		expect(result.data?.tables.get('notes')?.file).toBeUndefined();
		expect(result.data?.tables.get('notes')?.types).toEqual(['body']);
	});

	test('declaration defaults are rejected', () => {
		const result = parseData({
			id: 'so.epicenter.defaults',
			kv: {},
			tables: {
				notes: {
					scalars: { title: { type: field.string(), default: 'untitled' } },
				},
			},
		});
		expect(result.error?.name).toBe('DeclarationDefault');
	});

	test('field.json preserves an inner static type at the row boundary', () => {
		const data = defineData({
			id: 'so.epicenter.json',
			kv: {},
			tables: {
				rows: { scalars: { payload: field.json(field.select(['a', 'b'])) } },
			},
		});
		const row: RowOf<typeof data.tables.rows> = { id: '1', payload: 'a' };
		expect(row.payload).toBe('a');
	});
});
