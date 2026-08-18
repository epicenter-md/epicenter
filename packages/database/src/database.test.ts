import { describe, expect, test } from 'bun:test';

import {
	type CreateInputsOf,
	clearDatabaseCache,
	defineDatabase,
	defineKv,
	defineTable,
	parseDatabase,
	type RowOf,
	type RowsOf,
} from './database.js';

const database = defineDatabase({
	id: 'so.epicenter.honeycrisp',
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
		settings: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	},
});

function parse() {
	const { data, error } = parseDatabase(database);
	if (error !== null) throw error;
	return data;
}

function tableOf(name: string) {
	const table = parse().tables.get(name);
	if (table === undefined) throw new Error(`no table '${name}'`);
	return table;
}

describe('a database declaration is arktype JSON', () => {
	test('the authored literal round-trips byte-identically', () => {
		expect(JSON.stringify(JSON.parse(JSON.stringify(database)))).toBe(
			JSON.stringify(database),
		);
	});

	test('a declaration loaded from disk compiles, which identity keying prevented', () => {
		const fromDisk: unknown = JSON.parse(JSON.stringify(database));
		const { data, error } = parseDatabase(fromDisk);
		expect(error).toBeNull();
		expect(data?.tables.get('notes')?.fields.size).toBe(3);
	});

	test('compilation is memoised on content, not on object identity', () => {
		clearDatabaseCache();
		const first = parseDatabase(structuredClone(database));
		const second = parseDatabase(structuredClone(database));
		expect(first.data).toBe(second.data);
	});
});

describe('defaults and conformance are one mechanism', () => {
	test('defaults are the conforming subset of nothing', () => {
		expect(tableOf('settings').defaults).toEqual({
			theme: 'light',
			fontSize: 14,
		});
	});

	test('a field with no declared default contributes none', () => {
		expect(tableOf('notes').defaults).toEqual({});
	});

	test('a default fills an absent key', () => {
		const { conforming, issues } = tableOf('settings').conformance({});
		expect(conforming).toEqual({ theme: 'light', fontSize: 14 });
		expect(issues).toEqual([]);
	});

	test('a default does not rescue a present but invalid value', () => {
		const { conforming, issues } = tableOf('settings').conformance({
			theme: 'purple',
			fontSize: 20,
		});
		expect(conforming).toEqual({ fontSize: 20 });
		expect(issues.map((issue) => issue.field)).toEqual(['theme']);
	});
});

describe('conformance selects, defaults, and reports; it never repairs', () => {
	test('a conforming payload survives whole', () => {
		const { conforming, issues } = tableOf('notes').conformance({
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		expect(issues).toEqual([]);
		expect(conforming).toEqual({
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
	});

	test('a nonconforming payload carries what did pass, unrepaired', () => {
		const { conforming, issues } = tableOf('notes').conformance({
			title: 'Groceries',
			tags: 'food',
			date: null,
		});
		expect(conforming).toEqual({ title: 'Groceries', date: null });
		expect(issues.map((issue) => issue.field)).toEqual(['tags']);
	});

	test('an undeclared field is selected out rather than reported', () => {
		// Unknown fields stay preserved in the document; the declaration simply
		// does not speak for them, so they appear in neither half of the answer.
		const { conforming, issues } = tableOf('notes').conformance({
			title: 'Groceries',
			tags: [],
			date: null,
			futureField: 'from a release that has not shipped',
		});
		expect(issues).toEqual([]);
		expect(conforming).toEqual({ title: 'Groceries', tags: [], date: null });
	});

	test('the call site recovers with defaults under what survived', () => {
		const settings = tableOf('settings');
		const { conforming } = settings.conformance({
			theme: 'purple',
			fontSize: 20,
		});
		const cfg = { ...settings.defaults, ...conforming };
		expect(cfg).toEqual({ theme: 'light', fontSize: 20 });
	});
});

describe('a write validates only what it was handed', () => {
	test('supplied values are validated', () => {
		const { data, error } = tableOf('notes').validateWrite({
			title: 'Shopping',
		});
		expect(error).toBeNull();
		expect(data).toEqual({ title: 'Shopping' });
	});

	test('a default never fires on a write, because nothing absent is visited', () => {
		const { data, error } = tableOf('settings').validateWrite({});
		expect(error).toBeNull();
		expect(data).toEqual({});
	});

	test('one bad value refuses the call and touches no other field', () => {
		const { data, error } = tableOf('notes').validateWrite({
			title: 'Shopping',
			tags: 'food',
		});
		expect(data).toBeNull();
		expect(error?.name).toBe('Nonconforming');
	});

	test('an undeclared field is refused by name', () => {
		const { error } = tableOf('notes').validateWrite({ nope: 1 });
		expect(error?.name).toBe('UnknownField');
	});
});

describe('the grammar refuses what the records reserve', () => {
	const cases: [string, unknown][] = [
		['a non-object', 'nope'],
		['no id', { tables: {} }],
		['a one-label id', { id: 'honeycrisp', tables: {} }],
		[
			'the reserved table name, which collides with the KV relation',
			{ id: 'so.epicenter.app', tables: { kv: { a: 'string' } } },
		],
		[
			'table names differing only by case',
			{
				id: 'so.epicenter.app',
				tables: { notes: { a: 'string' }, Notes: { a: 'string' } },
			},
		],
		[
			'a reserved field prefix',
			{
				id: 'so.epicenter.app',
				tables: { notes: { '!presence': 'string' } },
			},
		],
		[
			'an optional field key',
			{
				id: 'so.epicenter.app',
				tables: { notes: { 'date?': 'string' } },
			},
		],
		[
			'the structural id',
			{ id: 'so.epicenter.app', tables: { notes: { id: 'string' } } },
		],
		[
			'a non-keyword expression',
			{ id: 'so.epicenter.app', tables: { notes: { title: 'strng' } } },
		],
		[
			'a non-string field',
			{ id: 'so.epicenter.app', tables: { notes: { title: 42 } } },
		],
		[
			'a field that transforms its value',
			{
				id: 'so.epicenter.app',
				tables: { notes: { when: 'string.date.parse' } },
			},
		],
		[
			'a field that transforms nested',
			{
				id: 'so.epicenter.app',
				tables: { notes: { payload: 'string.json.parse' } },
			},
		],
	];

	for (const [reason, value] of cases) {
		test(`refuses ${reason}`, () => {
			const { data, error } = parseDatabase(value);
			expect(data).toBeNull();
			expect(error).not.toBeNull();
		});
	}
});

describe('a field is one type through every door', () => {
	test('a transforming field is refused by name, with the fix in the message', () => {
		const { data, error } = parseDatabase({
			id: 'so.epicenter.app',
			tables: { notes: { when: 'string.date.parse' } },
		});
		expect(data).toBeNull();
		expect(error?.name).toBe('TransformingField');
		expect(error?.message).toContain('string.date.iso');
	});

	test('a declared default is not a transform, though arktype counts it as one', () => {
		// The trap this gate has to avoid. arktype reports `includesTransform` on
		// the WRAPPER for every defaulted field, because filling an absent key is
		// a transformation; asking the property's value instead is what keeps
		// defaults legal while still refusing a morph that carries one.
		const { data, error } = parseDatabase({
			id: 'so.epicenter.app',
			tables: { settings: { theme: "'light'|'dark' = 'light'" } },
		});
		expect(error).toBeNull();
		expect(data?.tables.get('settings')?.defaults).toEqual({ theme: 'light' });

		const { error: stillRefused } = parseDatabase({
			id: 'so.epicenter.app',
			tables: { notes: { when: "string.date.parse = '2020-01-01'" } },
		});
		expect(stillRefused?.name).toBe('TransformingField');
	});

	test('every validation-only rich type still passes', () => {
		// Nothing expressive is lost by refusing morphs: arktype ships a
		// validating form of each of these, and each keeps the stored value.
		const { data, error } = parseDatabase({
			id: 'so.epicenter.app',
			tables: {
				notes: {
					when: 'string.date.iso',
					id_: 'string.uuid',
					email: 'string.email',
					amount: 'string.numeric',
				},
			},
		});
		expect(error).toBeNull();
		expect(data?.tables.get('notes')?.fields.size).toBe(4);
	});

	test('a validated date round-trips as the string it was stored as', () => {
		const { data } = parseDatabase({
			id: 'so.epicenter.app',
			tables: { notes: { when: 'string.date.iso' } },
		});
		const table = data?.tables.get('notes');
		const { data: written } =
			table?.validateWrite({ when: '2026-08-07' }) ?? {};
		expect(written).toEqual({ when: '2026-08-07' });
		// Same string in, same string out, and the same string in the projection.
		expect(table?.conformance({ when: '2026-08-07' })).toEqual({
			conforming: { when: '2026-08-07' },
			issues: [],
		});
	});
});

describe('types', () => {
	test('a row type infers from the literal', () => {
		type Rows = RowsOf<typeof database>;
		const note: Rows['notes'] = {
			id: 'n1',
			title: 'Groceries',
			tags: ['food'],
			date: null,
		};
		// A read always supplies the default, so this is the plain union rather
		// than arktype's `Default<...>` marker.
		const settings: Rows['settings'] = {
			id: 'app',
			theme: 'dark',
			fontSize: 14,
		};
		expect(note.title).toBe('Groceries');
		expect(settings.theme).toBe('dark');
	});

	test('a create input makes exactly the defaulted fields optional', () => {
		type Inputs = CreateInputsOf<typeof database>;
		// Every declared default may be omitted...
		const bare: Inputs['settings'] = {};
		// ...and supplying one is still checked.
		const full: Inputs['settings'] = { theme: 'dark', fontSize: 18 };
		// A field with no default stays required.
		const note: Inputs['notes'] = {
			title: 'Groceries',
			tags: ['food'],
			date: null,
		};
		expect(bare).toEqual({});
		expect(full.theme).toBe('dark');
		expect(note.title).toBe('Groceries');
	});
});

describe('defineTable and defineKv are validation identities', () => {
	test('the returned value is the argument, and inference is the literal', () => {
		const notes = defineTable({
			title: 'string',
			tags: 'string[]',
			date: 'string|null = null',
		});
		// Identity at runtime: nothing is compiled or copied at authoring time.
		expect(notes).toEqual({
			title: 'string',
			tags: 'string[]',
			date: 'string|null = null',
		});
		// Inference carries through the hoisted ingredient, which is the whole
		// reason the helper exists: `RowOf` works on the table the app named.
		const row: RowOf<typeof notes> = {
			id: 'n1',
			title: 'Groceries',
			tags: [],
			date: null,
		};
		expect(row.date).toBeNull();
	});

	test('ingredients compose into defineDatabase unchanged', () => {
		const notes = defineTable({ title: 'string' });
		const preferences = defineKv({ theme: "'light'|'dark' = 'light'" });
		const composed = defineDatabase({
			id: 'so.epicenter.composed',
			tables: { notes },
			kv: preferences,
		});
		const { data, error } = parseDatabase(composed);
		expect(error).toBeNull();
		expect(data?.tables.get('notes')?.fields.size).toBe(1);
		expect(data?.kv?.defaults).toEqual({ theme: 'light' });
	});
});
