/**
 * Format tests: `formatExpected` over each expected shape, and `formatReport` over real violations
 * + summary. The report is grouped by location, computes the `invalid-type` expected phrase at the
 * edge from the carried field, and closes with a roll-up line.
 */

import { describe, expect, test } from 'bun:test';
import { formatExpected } from '../core/expected';
import { assess, type TableInput } from '../core/integrity';
import { readTable } from '../core/table';
import { summarize, toViolations } from '../core/violations';
import { formatReport } from './format';

type Entries = Parameters<typeof readTable>[0];

function loaded(
	name: string,
	contractText: string | undefined,
	entries: Entries,
): TableInput {
	return { name, status: 'readable', read: readTable(entries, contractText) };
}

describe('formatExpected', () => {
	test('scalar kinds render their phrase', () => {
		expect(formatExpected({ kind: 'string' })).toBe('string');
		expect(formatExpected({ kind: 'integer' })).toBe('integer');
		expect(formatExpected({ kind: 'reference' })).toBe('reference');
	});

	test('enum kinds list their members', () => {
		expect(formatExpected({ kind: 'select', values: ['draft', 'live'] })).toBe(
			'one of draft, live',
		);
		expect(formatExpected({ kind: 'multiSelect', values: ['a', 'b'] })).toBe(
			'array containing one of a, b',
		);
	});
});

describe('formatReport', () => {
	const pagesModel = JSON.stringify({
		fields: {
			title: { type: 'string' },
			status: { type: 'string', enum: ['draft', 'live'] },
		},
	});

	test('groups violations by location and computes the invalid expected at the edge', () => {
		const integrity = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\nstatus: 7\n---' },
			]),
		]);
		const text = formatReport(toViolations(integrity), summarize(integrity));

		// title is missing-required; status is invalid with the enum expected phrase.
		expect(text).toContain('pages/p1');
		expect(text).toContain('title  needs value');
		expect(text).toContain('invalid: got 7, expected one of draft, live');
		// the closing roll-up line
		expect(text).toContain('1 needs attention');
	});

	test('surfaces extras as notes, not failures', () => {
		const integrity = assess([
			loaded('pages', pagesModel, [
				{
					fileName: 'p1.md',
					content: '---\ntitle: Ok\nstatus: draft\nstray: kept\n---',
				},
			]),
		]);
		const text = formatReport(toViolations(integrity), summarize(integrity));

		expect(text).toContain('note: extra keys stray');
		expect(text).toContain('1 ready');
	});

	test('a clean vault reports only the ready roll-up', () => {
		const integrity = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Ok\nstatus: live\n---' },
			]),
		]);
		const text = formatReport(toViolations(integrity), summarize(integrity));

		expect(text).toBe('1 ready (1 table, 1 row)');
	});

	test('names every unreadable file and counts it in the roll-up', () => {
		const integrity = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'good.md', content: '---\ntitle: Good\nstatus: live\n---' },
				{ fileName: 'broken.md', content: '---\ntitle: [bad\n---' },
			]),
		]);
		const text = formatReport(toViolations(integrity), summarize(integrity));

		expect(text).toContain('pages/broken.md');
		expect(text).toContain("can't read: Frontmatter is not valid YAML");
		expect(text).toContain('1 unreadable file');
		expect(text).toContain('(1 table, 1 row)');
	});
});
