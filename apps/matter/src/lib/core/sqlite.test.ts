import { describe, expect, test } from 'bun:test';
import { classifyRows } from './conformance';
import { validateModel } from './model';
import { projectToSqlite } from './sqlite';
import type { Row } from './parse';

function model(fields: Record<string, Record<string, unknown>>) {
	const { data, error } = validateModel({ fields });
	if (error) throw new Error(error.message);
	return data;
}

const m = model({
	title: { type: 'string' },
	status: { type: 'string', enum: ['draft', 'published'] },
	count: { type: 'integer' },
	score: { type: 'number' },
	live: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	url: { type: 'string', format: 'uri' },
});

const valid: Row = {
	fileName: 'post-1.md',
	frontmatter: {
		title: 'Hello',
		status: 'draft',
		count: 3,
		score: 4.5,
		live: true,
		tags: ['a', 'b'],
		url: 'https://x.com',
		extraKey: 'kept',
	},
	body: '',
};

const incomplete: Row = {
	fileName: 'post-2.md',
	frontmatter: { title: 'Partial' }, // missing required fields -> NEEDS_VALUE -> NULL
	body: '',
};

const invalid: Row = {
	fileName: 'post-3.md',
	frontmatter: {
		title: 'Bad',
		status: 'bogus', // not in the enum -> INVALID, kept raw
		count: 1.5, // not an integer -> INVALID, kept raw
		score: 2,
		live: false,
		tags: ['x'],
		url: 'https://y.com',
	},
	body: '',
};

describe('schema script (DROP + CREATE, one execute_batch)', () => {
	test('drops then recreates: file PK, one nullable column per field by storage class, _extra JSON', () => {
		const { schema } = projectToSqlite(m, []);
		expect(schema).toBe(
			'DROP TABLE IF EXISTS "entries";\n' +
				'CREATE TABLE "entries" (' +
				'"file" TEXT PRIMARY KEY, ' +
				'"title" TEXT, ' +
				'"status" TEXT, ' +
				'"count" INTEGER, ' +
				'"score" REAL, ' +
				'"live" INTEGER, ' +
				'"tags" TEXT, ' +
				'"url" TEXT, ' +
				'"_extra" TEXT NOT NULL)',
		);
	});

	test('field identifiers with quotes/spaces are escaped, and stay nullable', () => {
		const weird = model({ 'a "b"': { type: 'string' } });
		const { schema } = projectToSqlite(weird, []);
		expect(schema).toContain('"a ""b""" TEXT');
		expect(schema).not.toContain('"a ""b""" TEXT NOT NULL');
	});
});

describe('insert template (one ? per column, bound positionally)', () => {
	test('lists every column in order with one placeholder each', () => {
		const { insert } = projectToSqlite(m, []);
		expect(insert).toBe(
			'INSERT INTO "entries" (' +
				'"file", "title", "status", "count", "score", "live", "tags", "url", "_extra"' +
				') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		);
		// name + 7 modeled fields + _extra = 9 placeholders.
		expect((insert.match(/\?/g) ?? []).length).toBe(9);
	});
});

describe('rows (every readable row, serialized by conformance state)', () => {
	const conformance = classifyRows(m.fields, [valid, incomplete]);
	const proj = projectToSqlite(m, conformance);

	test('valid AND incomplete rows both project, in folder order', () => {
		expect(proj.rows).toHaveLength(2);
		expect(proj.rows.map((r) => r[0])).toEqual(['post-1.md', 'post-2.md']);
	});

	test('an OK cell is serialized to its storage class', () => {
		const [file, title, status, count, score, live, tags, url, extra] =
			proj.rows[0]!;
		expect(file).toBe('post-1.md');
		expect(title).toBe('Hello');
		expect(status).toBe('draft');
		expect(count).toBe(3); // INTEGER stays a number
		expect(score).toBe(4.5); // REAL stays a number
		expect(live).toBe(1); // boolean -> 0/1
		expect(tags).toBe('["a","b"]'); // array -> JSON TEXT
		expect(url).toBe('https://x.com');
		expect(extra).toBe('{"extraKey":"kept"}'); // unmodeled keys -> _extra JSON
	});

	test('a missing required cell binds NULL (the draft is still a row)', () => {
		const [file, title, status, count, , , tags, url, extra] = proj.rows[1]!;
		expect(file).toBe('post-2.md');
		expect(title).toBe('Partial');
		expect(status).toBeNull();
		expect(count).toBeNull();
		expect(tags).toBeNull();
		expect(url).toBeNull();
		expect(extra).toBe('{}'); // no unmodeled keys
	});

	test('an out-of-domain cell keeps its raw value so the draft stays filterable', () => {
		const p = projectToSqlite(m, classifyRows(m.fields, [invalid]));
		const [file, title, status, count] = p.rows[0]!;
		expect(file).toBe('post-3.md');
		expect(title).toBe('Bad');
		expect(status).toBe('bogus'); // not in the enum, kept raw
		expect(count).toBe(1.5); // not an integer, kept raw
	});
});
