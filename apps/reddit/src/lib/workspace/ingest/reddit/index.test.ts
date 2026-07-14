/**
 * Reddit Import Pipeline Tests
 *
 * Verifies that supported CSVs become plain transformed arrays and metadata,
 * while malformed rows are skipped and reported without a database lifecycle.
 *
 * Key behaviors:
 * - Valid rows are returned in their named table arrays
 * - Account statistics and preferences are returned as metadata
 * - Invalid rows are skipped and represented exactly in import stats
 */

import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { importRedditExport } from './index.js';

function createZip(entries: Record<string, string>): Blob {
	const files: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(entries)) {
		files[name] = new TextEncoder().encode(content);
	}
	return new Blob([zipSync(files)]);
}

test('returns transformed table rows and account metadata', async () => {
	const zip = createZip({
		'post_votes.csv': [
			'id,permalink,direction',
			'1,/r/a,up',
			'2,/r/b,down',
		].join('\n'),
		'statistics.csv': 'statistic,value\nkarma,42\naccount_age,10 years',
		'user_preferences.csv': 'preference,value\ntheme,dark',
	});

	const result = await importRedditExport(zip);

	expect(result.tables.postVotes).toEqual([
		{ id: '1', permalink: '/r/a', direction: 'up' },
		{ id: '2', permalink: '/r/b', direction: 'down' },
	]);
	expect(result.metadata).toEqual({
		statistics: { karma: '42', account_age: '10 years' },
		preferences: { theme: 'dark' },
	});
	expect(result.stats.tables.postVotes).toBe(2);
	expect(result.stats.metadata).toBe(2);
	expect(result.stats.totalRows).toBe(4);
	expect(result.stats.errors).toEqual([]);
	expect(result.stats.skipped).toBe(0);
});

test('skips malformed rows and reports their exact source position', async () => {
	const zip = createZip({
		'post_votes.csv': [
			'id,permalink,direction',
			'1,/r/a,up',
			'2,/r/b,sideways',
			'3,/r/c,down',
		].join('\n'),
	});

	const result = await importRedditExport(zip);

	expect(result.tables.postVotes).toEqual([
		{ id: '1', permalink: '/r/a', direction: 'up' },
		{ id: '3', permalink: '/r/c', direction: 'down' },
	]);
	expect(result.stats.tables.postVotes).toBe(2);
	expect(result.stats.totalRows).toBe(2);
	expect(result.stats.skipped).toBe(1);
	expect(result.stats.errors).toHaveLength(1);
	expect(result.stats.errors[0]).toMatchObject({
		table: 'postVotes',
		rowIndex: 1,
	});
	expect(result.stats.errors[0]?.error).toContain('direction');
});

test('returns empty arrays and null metadata when supported files are absent', async () => {
	const result = await importRedditExport(
		createZip({ 'post_votes.csv': 'id,permalink,direction\n' }),
	);

	expect(result.tables.postVotes).toEqual([]);
	expect(result.tables.posts).toEqual([]);
	expect(result.metadata).toEqual({ statistics: null, preferences: null });
	expect(result.stats.totalRows).toBe(0);
	expect(result.stats.metadata).toBe(0);
	expect(result.stats.errors).toEqual([]);
	expect(result.stats.skipped).toBe(0);
});
