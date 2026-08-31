import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';
import { parseData } from './compile.js';
import { plainText } from './content.js';
import { field, type RowOf } from './declaration.js';
import { defineData, defineTable } from './define.js';

const authored = defineData({
	id: 'so.epicenter.data',
	kv: {
		name: field.string(),
		color: field.nullable(field.string()),
	},
	tables: {
		notes: defineTable({
			title: field.string(),
			status: field.select(['draft', 'published']),
			tags: field.multiSelect(['work', 'personal']),
			publishedAt: field.nullable(field.instant()),
			content: plainText(),
		}),
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

	test('the content codec compiles beside the fields, not into them', () => {
		// A row's node holds no JSON value (ADR-0296), so it has no schema to
		// check a payload against and nothing a conformance read could report.
		// It compiles into `content` and stays out of `fields`.
		const result = parseData({
			id: 'so.epicenter.typed',
			kv: {},
			tables: {
				notes: defineTable({
					title: field.string(),
					content: plainText(),
				}),
			},
		});
		const notes = expectOk(result).tables.get('notes');
		expect([...(notes?.fields.keys() ?? [])]).toEqual(['title']);
		expect(notes?.content).toBeDefined();
		expect(notes?.conformance({ title: 'x' }).issues).toEqual([]);
	});

	test("a scalar cannot be called 'content', because every row already has one", () => {
		// The compile-time half is `ValidateFields`, which puts the sentence on
		// the offending key. This is the runtime half, for a definition that
		// arrived as JSON and never met `defineTable`.
		const result = parseData({
			id: 'so.epicenter.collide',
			kv: {},
			tables: { notes: { content: field.string() } },
		});
		expect(result.error?.name).toBe('Malformed');
	});

	test("a scalar cannot be called 'id', because every row already has one", () => {
		const result = parseData({
			id: 'so.epicenter.collide-id',
			kv: {},
			tables: { notes: { id: field.string(), content: {} } },
		});
		expect(result.error?.name).toBe('Malformed');
	});

	test('the old scalar wrapper and type list are not compatibility paths', () => {
		const result = parseData({
			id: 'so.epicenter.old-table-shape',
			kv: {},
			tables: {
				notes: {
					scalars: { title: field.string() },
					types: ['content'],
					content: {},
				},
			},
		});
		expect(result.error?.name).toBe('UnrecognizedField');
	});

	test('a table without the reserved content key is malformed', () => {
		const result = parseData({
			id: 'so.epicenter.missing-content',
			kv: {},
			tables: { notes: { title: field.string() } },
		});
		expect(result.error?.name).toBe('Malformed');
	});

	test("kv may hold a field called 'content', because kv holds no rows", () => {
		// Reserved on a ROW and only there. kv is settings, so nothing collides.
		const result = parseData({
			id: 'so.epicenter.kvcontent',
			kv: { content: field.string() },
			tables: { notes: { title: field.string(), content: {} } },
		});
		expect(result.error).toBeNull();
		// The FIELD, not just the parse. Asserting `error` alone passed for the
		// whole of the flattening, while the table loop skipped `content` for
		// every root including this one: the key compiled away, `kv.get` answered
		// `undefined` for a value the document was holding, and `nonconforming`
		// reported nothing. A pin that cannot see its subject deleted is not one.
		expect([...(result.data?.kv.fields.keys() ?? [])]).toEqual(['content']);
	});

	test('a serialized codec husk compiles as no codec', () => {
		// Behaviors are code and cannot arrive as data (ADR-0266): a definition
		// round-tripped through JSON loses its functions, and that husk must be
		// parseable, because an app bundle's `database.json` is read for its id.
		const authored = defineTable({
			title: field.string(),
			content: plainText(),
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
		// The codec is gone and the scalars survive: a husk is parseable, and
		// what a missing codec costs is paid at the artifact boundary.
		expect(result.data?.tables.get('notes')?.content).toBeUndefined();
		expect([
			...(result.data?.tables.get('notes')?.fields.keys() ?? []),
		]).toEqual(['title']);
	});

	test('declaration defaults are rejected', () => {
		const result = parseData({
			id: 'so.epicenter.defaults',
			kv: {},
			tables: {
				notes: {
					title: { type: field.string(), default: 'untitled' },
					content: {},
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
				rows: defineTable({
					payload: field.json(field.select(['a', 'b'])),
					content: plainText(),
				}),
			},
		});
		const row: RowOf<typeof data.tables.rows> = {
			id: '1',
			payload: 'a',
			content: new Y.Type(),
		};
		expect(row.payload).toBe('a');
	});
});
