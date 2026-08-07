import { describe, expect, test } from 'bun:test';

import type { RowAddress } from './addresses.js';
import {
	clearLensCache,
	defineLens,
	parseLens,
	type CreateInputsOf,
	type RowsOf,
} from './lens.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
		settings: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	},
});

function parse() {
	const { data, error } = parseLens(lens);
	if (error !== null) throw error;
	return data;
}

function tableOf(name: string) {
	const table = parse().tables.get(name);
	if (table === undefined) throw new Error(`no table '${name}'`);
	return table;
}

function addressOf(tableName: string, rowId: string): RowAddress {
	return { namespace: lens.namespace, tableName, rowId };
}

describe('a lens is arktype JSON', () => {
	test('the authored literal round-trips byte-identically', () => {
		expect(JSON.stringify(JSON.parse(JSON.stringify(lens)))).toBe(
			JSON.stringify(lens),
		);
	});

	test('a lens loaded from disk compiles, which identity keying prevented', () => {
		const fromDisk: unknown = JSON.parse(JSON.stringify(lens));
		const { data, error } = parseLens(fromDisk);
		expect(error).toBeNull();
		expect(data?.tables.get('notes')?.fields.size).toBe(3);
	});

	test('compilation is memoised on content, not on object identity', () => {
		clearLensCache();
		const first = parseLens(structuredClone(lens));
		const second = parseLens(structuredClone(lens));
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

describe('one read verb, recovery composed at the call site', () => {
	test('a conforming payload projects to a row', () => {
		const { data, error } = tableOf('notes').project(addressOf('notes', 'n1'), {
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		expect(error).toBeNull();
		expect(data).toEqual({
			id: 'n1',
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
	});

	test('a nonconforming payload carries what did pass, unrepaired', () => {
		const { data, error } = tableOf('notes').project(addressOf('notes', 'n1'), {
			title: 'Groceries',
			tags: 'food',
			date: null,
		});
		expect(data).toBeNull();
		expect(error?.name).toBe('Nonconforming');
		expect(error?.conforming).toEqual({
			id: 'n1',
			title: 'Groceries',
			date: null,
		});
		expect(error?.issues.map((issue) => issue.field)).toEqual(['tags']);
		// Never repaired and never hidden: the raw payload survives intact.
		expect(error?.raw).toEqual({
			title: 'Groceries',
			tags: 'food',
			date: null,
		});
	});

	test('the call site recovers with defaults under what survived', () => {
		const settings = tableOf('settings');
		const { data, error } = settings.project(addressOf('settings', 'app'), {
			theme: 'purple',
			fontSize: 20,
		});
		// The one composition. `??` and never a destructuring default: an Err
		// sets `data` to null, and a destructuring default fires only on
		// `undefined`, so `const { data = fallback }` would hand back null.
		const cfg = data ?? { ...settings.defaults, ...error?.conforming };
		// A whole row either way, id included, so the two branches of `??` have
		// the same shape and no call site has to add the id back.
		expect(cfg).toEqual({ id: 'app', theme: 'light', fontSize: 20 });
	});

	test('a destructuring default does not fire on an Err, which is why ?? is the rule', () => {
		const { data } = tableOf('notes').project(addressOf('notes', 'n1'), {});
		const wrong = data ?? 'fallback';
		expect(data).toBeNull();
		expect(wrong).toBe('fallback');
		// The trap, spelled out: `= fallback` never fires, because data is null.
		const { data: trap = 'fallback' } = tableOf('notes').project(
			addressOf('notes', 'n1'),
			{},
		);
		expect(trap).toBeNull();
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
		['no namespace', { tables: {} }],
		['a one-label namespace', { namespace: 'honeycrisp', tables: {} }],
		[
			'a reserved table name',
			{ namespace: 'so.epicenter.app', tables: { query: { a: 'string' } } },
		],
		[
			'table names differing only by case',
			{
				namespace: 'so.epicenter.app',
				tables: { notes: { a: 'string' }, Notes: { a: 'string' } },
			},
		],
		[
			'a reserved field prefix',
			{
				namespace: 'so.epicenter.app',
				tables: { notes: { '!presence': 'string' } },
			},
		],
		[
			'an optional field key',
			{ namespace: 'so.epicenter.app', tables: { notes: { 'date?': 'string' } } },
		],
		[
			'the structural id',
			{ namespace: 'so.epicenter.app', tables: { notes: { id: 'string' } } },
		],
		[
			'a non-keyword expression',
			{ namespace: 'so.epicenter.app', tables: { notes: { title: 'strng' } } },
		],
		[
			'a non-string field',
			{ namespace: 'so.epicenter.app', tables: { notes: { title: 42 } } },
		],
		[
			'a field that transforms its value',
			{
				namespace: 'so.epicenter.app',
				tables: { notes: { when: 'string.date.parse' } },
			},
		],
		[
			'a field that transforms nested',
			{
				namespace: 'so.epicenter.app',
				tables: { notes: { payload: 'string.json.parse' } },
			},
		],
	];

	for (const [reason, value] of cases) {
		test(`refuses ${reason}`, () => {
			const { data, error } = parseLens(value);
			expect(data).toBeNull();
			expect(error).not.toBeNull();
		});
	}
});

describe('a field is one type through every door', () => {
	test('a transforming field is refused by name, with the fix in the message', () => {
		const { data, error } = parseLens({
			namespace: 'so.epicenter.app',
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
		const { data, error } = parseLens({
			namespace: 'so.epicenter.app',
			tables: { settings: { theme: "'light'|'dark' = 'light'" } },
		});
		expect(error).toBeNull();
		expect(data?.tables.get('settings')?.defaults).toEqual({ theme: 'light' });

		const { error: stillRefused } = parseLens({
			namespace: 'so.epicenter.app',
			tables: { notes: { when: "string.date.parse = '2020-01-01'" } },
		});
		expect(stillRefused?.name).toBe('TransformingField');
	});

	test('every validation-only rich type still passes', () => {
		// Nothing expressive is lost by refusing morphs: arktype ships a
		// validating form of each of these, and each keeps the stored value.
		const { data, error } = parseLens({
			namespace: 'so.epicenter.app',
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
		const { data } = parseLens({
			namespace: 'so.epicenter.app',
			tables: { notes: { when: 'string.date.iso' } },
		});
		const table = data?.tables.get('notes');
		const { data: written } = table?.validateWrite({ when: '2026-08-07' }) ?? {};
		expect(written).toEqual({ when: '2026-08-07' });
		const { data: read } = table?.project(
			{ namespace: 'so.epicenter.app', tableName: 'notes', rowId: 'n1' },
			{ when: '2026-08-07' },
		) ?? {};
		// Same string in, same string out, and the same string in the projection.
		expect(read).toEqual({ id: 'n1', when: '2026-08-07' });
	});
});

describe('types', () => {
	test('a row type infers from the literal', () => {
		type Rows = RowsOf<typeof lens>;
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
		type Inputs = CreateInputsOf<typeof lens>;
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
