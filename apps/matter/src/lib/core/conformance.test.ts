import { describe, expect, test } from 'bun:test';
import { classifyRow, classifyRows } from './conformance';
import { validateModel } from './model';
import type { Row } from './parse';

function fields(defs: Record<string, Record<string, unknown>>) {
	const { data, error } = validateModel({ fields: defs });
	if (error) throw new Error(error.message);
	return data.fields;
}

describe('classifyRow (per-cell conformance, everything required)', () => {
	const cols = fields({
		title: { type: 'string' },
		url: { type: 'string', format: 'uri' },
		rating: { type: 'integer' },
	});

	test('a present valid value is OK; the row is valid when every cell is OK', () => {
		const row: Row = {
			fileName: 'a.md',
			frontmatter: { title: 'Hello', url: 'https://x.com', rating: 5 },
			body: '',
		};
		const c = classifyRow(cols, row);
		expect(c.cells.map((x) => x.state)).toEqual(['OK', 'OK', 'OK']);
		expect(c.rowValid).toBe(true);
	});

	test('an absent required field is NEEDS_VALUE (invalid)', () => {
		const row: Row = {
			fileName: 'b.md',
			frontmatter: { title: 'Hi' },
			body: '',
		};
		const c = classifyRow(cols, row);
		expect(c.cells.map((x) => x.state)).toEqual([
			'OK',
			'NEEDS_VALUE',
			'NEEDS_VALUE',
		]);
		expect(c.rowValid).toBe(false);
	});

	test('a present value failing its schema is INVALID', () => {
		const row: Row = {
			fileName: 'c.md',
			frontmatter: { title: 'Hi', url: 'not a url', rating: 'high' },
			body: '',
		};
		const c = classifyRow(cols, row);
		expect(c.cells.map((x) => x.state)).toEqual(['OK', 'INVALID', 'INVALID']);
		expect(c.rowValid).toBe(false);
	});

	// The tested nullish contract: a bare `title:` parses to null, an omitted
	// `title` is absent; both classify identically (NEEDS_VALUE, since required).
	test('absent key and explicit null are the SAME empty', () => {
		const absent: Row = { fileName: 'd.md', frontmatter: {}, body: '' };
		const nul: Row = {
			fileName: 'e.md',
			frontmatter: { title: null },
			body: '',
		};
		expect(classifyRow(cols, absent).cells[0]?.state).toBe('NEEDS_VALUE');
		expect(classifyRow(cols, nul).cells[0]?.state).toBe('NEEDS_VALUE');
	});

	// "Must have content" is a value constraint, not a model flag: minLength rejects
	// the empty string, so a blank string fails as INVALID rather than passing OK.
	test('an empty string is OK for a plain string, INVALID under minLength', () => {
		const plain = fields({ title: { type: 'string' } });
		const must = fields({ title: { type: 'string', minLength: 1 } });
		const row: Row = { fileName: 'f.md', frontmatter: { title: '' }, body: '' };
		expect(classifyRow(plain, row).cells[0]?.state).toBe('OK');
		expect(classifyRow(must, row).cells[0]?.state).toBe('INVALID');
	});

	test('extras are collected and never affect validity', () => {
		const row: Row = {
			fileName: 'h.md',
			frontmatter: {
				title: 'Hi',
				url: 'https://x.com',
				rating: 1,
				wild: 'extra',
				n: 9,
			},
			body: '',
		};
		const c = classifyRow(cols, row);
		expect(c.extras).toEqual([
			{ key: 'wild', value: 'extra' },
			{ key: 'n', value: 9 },
		]);
		expect(c.rowValid).toBe(true); // extras present, row still valid
	});

	test('an unmodeled field surfaces as an extra, not a field', () => {
		// `note` is a nullable wrapper, outside the palette, so it is not a field.
		const withUnmodeled = fields({
			title: { type: 'string' },
			note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
		});
		expect(withUnmodeled.map((c) => c.name)).toEqual(['title']);
		const row: Row = {
			fileName: 'i.md',
			frontmatter: { title: 'Hi', note: 'hello' },
			body: '',
		};
		const c = classifyRow(withUnmodeled, row);
		expect(c.cells.map((x) => x.field.name)).toEqual(['title']);
		expect(c.extras).toEqual([{ key: 'note', value: 'hello' }]);
	});
});

describe('classifyRows', () => {
	test('classifies every row against the precompiled fields', () => {
		const cols = fields({ title: { type: 'string' } });
		const rows: Row[] = [
			{ fileName: 'a.md', frontmatter: { title: 'A' }, body: '' },
			{ fileName: 'b.md', frontmatter: {}, body: '' },
		];
		const conformance = classifyRows(cols, rows);
		expect(conformance.map((c) => c.rowValid)).toEqual([true, false]);
	});
});
