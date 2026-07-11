/**
 * Exit-code tests: the three tiers derived from a {@link Summary}. Fatal (2) for a table or
 * Markdown file that could not load, problems (1) for data that needs attention, clean (0)
 * otherwise. `untyped` is valid, so an untyped-only vault exits 0.
 */

import { describe, expect, test } from 'bun:test';
import { assess, type TableInput } from '../core/integrity';
import { readTable } from '../core/table';
import { summarize, toViolations } from '../core/violations';
import { exitCodeFor } from './exit-code';

type Entries = Parameters<typeof readTable>[0];

function loaded(
	name: string,
	contractText: string | undefined,
	entries: Entries,
): TableInput {
	return { name, status: 'readable', read: readTable(entries, contractText) };
}

const pagesModel = JSON.stringify({ fields: { title: { type: 'string' } } });
const adaptationsModel = JSON.stringify({
	fields: { page: { type: 'string', 'x-ref': 'pages' } },
});

// The whole-vault verdict: every violation counts as a failure (no scope filtering).
function exitCode(tables: TableInput[]): 0 | 1 | 2 {
	const integrity = assess(tables);
	return exitCodeFor(summarize(integrity), toViolations(integrity));
}

describe('exitCodeFor', () => {
	test('0 when every row is healthy', () => {
		expect(
			exitCode([
				loaded('pages', pagesModel, [
					{ fileName: 'p1.md', content: '---\ntitle: Ok\n---' },
				]),
			]),
		).toBe(0);
	});

	test('0 for an untyped-only vault: untyped is valid', () => {
		expect(
			exitCode([
				loaded('notes', undefined, [
					{ fileName: 'n1.md', content: '---\ntag: idea\n---' },
				]),
			]),
		).toBe(0);
	});

	test('1 when a row needs attention', () => {
		expect(
			exitCode([
				loaded('pages', pagesModel, [
					{ fileName: 'p1.md', content: '---\n---' },
				]),
			]),
		).toBe(1);
	});

	test('1 when a reference does not resolve', () => {
		expect(
			exitCode([
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\npage: ghost\n---' },
				]),
			]),
		).toBe(1);
	});

	test('2 when a folder is unreadable', () => {
		expect(
			exitCode([
				{ name: 'pages', status: 'unreadable', message: 'permission denied' },
			]),
		).toBe(2);
	});

	test('2 when a matter.json is an invalid contract', () => {
		expect(
			exitCode([
				loaded('bad', '{ not valid json', [
					{ fileName: 'b1.md', content: '---\ntitle: X\n---' },
				]),
			]),
		).toBe(2);
	});

	test('2 when a Markdown file cannot become a row', () => {
		expect(
			exitCode([
				loaded('pages', pagesModel, [
					{ fileName: 'good.md', content: '---\ntitle: Good\n---' },
					{ fileName: 'broken.md', content: '---\ntitle: [bad\n---' },
				]),
			]),
		).toBe(2);
	});

	test('a fatal outranks mere attention', () => {
		expect(
			exitCode([
				{ name: 'pages', status: 'unreadable', message: 'permission denied' },
				loaded('adaptations', adaptationsModel, [
					{ fileName: 'a1.md', content: '---\npage: ghost\n---' },
				]),
			]),
		).toBe(2);
	});
});
