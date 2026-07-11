/**
 * Projection tests: `toViolations`, `summarize`, and `tierOf` as pure selectors over a real
 * `assess` result. Every vault is built from in-memory `readTable` reads, so conformance and
 * reference resolution are on the live path and the selectors read genuine assessed cells.
 *
 * The load-bearing claims under test:
 *   - every violation kind projects, and the healthy states (`ok`, `missing-optional`, `resolved`)
 *     project to NOTHING (the proof the list is a projection of the cells, not all of them);
 *   - `missing-target` is deduped to once per column while `dangling` stays per offending row;
 *   - `invalid-type` carries the field so `describeExpected` runs at the edge;
 *   - table-load failures (`unreadable`, `invalid-contract`) are summary/exit concerns, never
 *     violations; `untyped` is a valid untyped table, never a failure.
 */

import { describe, expect, test } from 'bun:test';
import { describeExpected } from './expected';
import { assess, type TableInput } from './integrity';
import { readTable } from './table';
import { summarize, toViolations, type Violation } from './violations';

type Entries = Parameters<typeof readTable>[0];

function loaded(
	name: string,
	contractText: string | undefined,
	entries: Entries,
): TableInput {
	return { name, status: 'readable', read: readTable(entries, contractText) };
}

// `title` required, `subtitle` optional: enough for ok / missing-required / missing-optional / invalid.
const pagesModel = JSON.stringify({
	fields: { title: { type: 'string' }, subtitle: { type: 'string' } },
	optional: ['subtitle'],
});

// `page` references `pages`; required by default: enough for resolved / dangling / missing-target.
const adaptationsModel = JSON.stringify({
	fields: {
		title: { type: 'string' },
		page: { type: 'string', 'x-ref': 'pages' },
	},
});

// A `select` field: the one kind whose expected value carries its enum members.
const statusModel = JSON.stringify({
	fields: { status: { type: 'string', enum: ['draft', 'live'] } },
});

function kinds(violations: readonly Violation[]): string[] {
	return violations.map((v) => v.kind);
}

describe('toViolations: every kind projects', () => {
	test('a missing required cell is a missing-required violation', () => {
		const violations = toViolations(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'p1.md', content: '---\n---' },
				]),
			]),
		);

		expect(violations).toEqual([
			{ kind: 'missing-required', table: 'pages', row: 'p1', field: 'title' },
		]);
	});

	test('an out-of-domain value is an invalid-type violation carrying raw and the field', () => {
		const violations = toViolations(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'p1.md', content: '---\ntitle: 123\n---' },
				]),
			]),
		);

		expect(violations).toHaveLength(1);
		const [violation] = violations;
		if (violation?.kind !== 'invalid-type')
			throw new Error('expected invalid-type');
		expect(violation.table).toBe('pages');
		expect(violation.row).toBe('p1');
		expect(violation.raw).toBe(123);
		// The field rides on the violation; "what was expected" is computed at the edge from it.
		expect(violation.field.name).toBe('title');
	});

	test('a present pointer that names no row in a loaded target is a dangling-reference', () => {
		const violations = toViolations(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
				]),
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\ntitle: A\npage: ghost\n---' },
				]),
			]),
		);

		expect(violations).toEqual([
			{
				kind: 'dangling-reference',
				table: 'adaptations',
				row: 'a1',
				field: 'page',
				value: 'ghost',
				target: 'pages',
			},
		]);
	});

	test('a reference whose target table is absent is a missing-target', () => {
		const violations = toViolations(
			assess([
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\ntitle: A\npage: somewhere\n---' },
				]),
			]),
		);

		expect(violations).toEqual([
			{
				kind: 'missing-target',
				table: 'adaptations',
				field: 'page',
				target: 'pages',
			},
		]);
	});
});

describe('toViolations: healthy states never project', () => {
	test('ok, missing-optional, and resolved produce no violations', () => {
		const violations = toViolations(
			assess([
				loaded('pages', pagesModel, [
					// title ok, subtitle missing-optional
					{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
				]),
				loaded('adaptations', adaptationsModel, [
					// title ok, page resolved
					{
						fileName: 'a1.md',
						content: '---\ntitle: A\npage: become-the-source\n---',
					},
				]),
			]),
		);

		expect(violations).toEqual([]);
	});
});

describe('toViolations: dedup and granularity', () => {
	test('missing-target is reported once per column, not once per row', () => {
		const violations = toViolations(
			assess([
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\ntitle: A\npage: one\n---' },
					{ fileName: 'a2.md', content: '---\ntitle: B\npage: two\n---' },
					{ fileName: 'a3.md', content: '---\ntitle: C\npage: three\n---' },
				]),
			]),
		);

		expect(violations).toEqual([
			{
				kind: 'missing-target',
				table: 'adaptations',
				field: 'page',
				target: 'pages',
			},
		]);
	});

	test('dangling references stay per offending row', () => {
		const violations = toViolations(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
				]),
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\ntitle: A\npage: ghost-one\n---' },
					{ fileName: 'a2.md', content: '---\ntitle: B\npage: ghost-two\n---' },
				]),
			]),
		);

		expect(kinds(violations)).toEqual([
			'dangling-reference',
			'dangling-reference',
		]);
		expect(
			violations.map((v) => (v.kind === 'dangling-reference' ? v.row : '')),
		).toEqual(['a1', 'a2']);
	});
});

describe('toViolations: table-load failures are not violations', () => {
	test('unreadable and invalid-contract tables contribute no violations', () => {
		const violations = toViolations(
			assess([
				{ name: 'pages', status: 'unreadable', message: 'permission denied' },
				loaded('bad', '{ not valid json', [
					{ fileName: 'b1.md', content: '---\ntitle: X\n---' },
				]),
			]),
		);

		expect(violations).toEqual([]);
	});
});

describe('invalid-type expected is computed at the edge', () => {
	test('describeExpected over the carried field recovers the select enum', () => {
		const violations = toViolations(
			assess([
				loaded('posts', statusModel, [
					{ fileName: 'x.md', content: '---\nstatus: 7\n---' },
				]),
			]),
		);

		const [violation] = violations;
		if (violation?.kind !== 'invalid-type')
			throw new Error('expected invalid-type');
		expect(describeExpected(violation.field)).toEqual({
			kind: 'select',
			values: ['draft', 'live'],
		});
	});
});

describe('summarize', () => {
	test('counts ready, attention, and per-field states over typed tables', () => {
		const summary = summarize(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'good.md', content: '---\ntitle: Ok\n---' }, // ready
					{ fileName: 'bad.md', content: '---\n---' }, // missing-required
				]),
			]),
		);

		const table = summary.tables[0];
		if (table?.status !== 'typed') throw new Error('expected typed');
		expect(table.rows).toBe(2);
		expect(table.ready).toBe(1);
		expect(table.needsAttention).toBe(1);

		const title = table.fields.find((f) => f.field === 'title');
		expect(title).toEqual({
			field: 'title',
			ok: 1,
			empty: 0,
			needsValue: 1,
			invalid: 0,
			unresolved: 0,
		});
		const subtitle = table.fields.find((f) => f.field === 'subtitle');
		expect(subtitle?.empty).toBe(2); // optional, absent in both rows

		expect(summary.totals).toMatchObject({
			tables: 1,
			rows: 2,
			ready: 1,
			needsAttention: 1,
			unreadableTables: 0,
			unreadableFiles: 0,
			invalidContract: 0,
			untyped: 0,
		});
	});

	test('a resolved reference counts as ok and keeps its row ready', () => {
		const summary = summarize(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
				]),
				loaded('adaptations', adaptationsModel, [
					{
						fileName: 'a1.md',
						content: '---\ntitle: A\npage: become-the-source\n---',
					},
				]),
			]),
		);

		const adaptations = summary.tables.find((t) => t.name === 'adaptations');
		if (adaptations?.status !== 'typed') throw new Error('expected typed');
		expect(adaptations.ready).toBe(1);
		expect(adaptations.needsAttention).toBe(0);
		expect(adaptations.fields.find((f) => f.field === 'page')?.ok).toBe(1);
	});

	test('a dangling reference makes its row need attention', () => {
		const summary = summarize(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
				]),
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\ntitle: A\npage: ghost\n---' },
				]),
			]),
		);

		const adaptations = summary.tables.find((t) => t.name === 'adaptations');
		if (adaptations?.status !== 'typed') throw new Error('expected typed');
		expect(adaptations.needsAttention).toBe(1);
		expect(adaptations.fields.find((f) => f.field === 'page')?.unresolved).toBe(
			1,
		);
	});

	test('a missing-target is structural, not a per-row attention item', () => {
		// pages absent: adaptations.page is missing-target. The row needs no edit to fix it (the
		// fix is vault-level), so it stays ready even though the column is unresolved.
		const summary = summarize(
			assess([
				loaded('adaptations', adaptationsModel, [
					{
						fileName: 'a1.md',
						content: '---\ntitle: A\npage: become-the-source\n---',
					},
				]),
			]),
		);

		const adaptations = summary.tables.find((t) => t.name === 'adaptations');
		if (adaptations?.status !== 'typed') throw new Error('expected typed');
		expect(adaptations.ready).toBe(1);
		expect(adaptations.needsAttention).toBe(0);
		expect(adaptations.fields.find((f) => f.field === 'page')?.unresolved).toBe(
			1,
		);
	});

	test('unreadable and invalid-contract tables surface in the summary as fatals', () => {
		const summary = summarize(
			assess([
				{ name: 'pages', status: 'unreadable', message: 'permission denied' },
				loaded('bad', '{ not valid json', [
					{ fileName: 'b1.md', content: '---\ntitle: X\n---' },
				]),
			]),
		);

		expect(summary.tables.map((t) => t.status)).toEqual([
			'unreadable',
			'invalid-contract',
		]);
		expect(summary.totals.unreadableTables).toBe(1);
		expect(summary.totals.invalidContract).toBe(1);
	});

	test('unreadable files stay named and count separately from unreadable tables', () => {
		const summary = summarize(
			assess([
				loaded('pages', pagesModel, [
					{ fileName: 'good.md', content: '---\ntitle: Good\n---' },
					{ fileName: 'broken.md', content: '---\ntitle: [bad\n---' },
				]),
			]),
		);

		expect(summary.unreadableFiles).toEqual([
			{
				table: 'pages',
				fileName: 'broken.md',
				message: expect.stringContaining('Frontmatter is not valid YAML'),
			},
		]);
		expect(summary.totals.unreadableFiles).toBe(1);
		expect(summary.totals.unreadableTables).toBe(0);
		expect(summary.totals.rows).toBe(1);
	});

	test('an untyped table counts as untyped, valid, never a failure', () => {
		const summary = summarize(
			assess([
				loaded('notes', undefined, [
					{ fileName: 'n1.md', content: '---\ntag: idea\n---' },
				]),
			]),
		);

		const table = summary.tables[0];
		expect(table?.status).toBe('untyped');
		expect(summary.totals.untyped).toBe(1);
		expect(summary.totals.needsAttention).toBe(0);
		expect(summary.totals.unreadableTables).toBe(0);
		expect(summary.totals.unreadableFiles).toBe(0);
		expect(summary.totals.invalidContract).toBe(0);
	});

	test('extra frontmatter keys surface as notes, never as violations', () => {
		const integrity = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Ok\nstray: kept\n---' },
			]),
		]);

		expect(toViolations(integrity)).toEqual([]);
		expect(summarize(integrity).extras).toEqual([
			{ table: 'pages', row: 'p1', keys: ['stray'] },
		]);
	});
});
