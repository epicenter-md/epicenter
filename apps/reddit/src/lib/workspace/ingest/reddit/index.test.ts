/**
 * Reddit Import Pipeline Tests
 *
 * Verifies end-to-end import behavior including row-level error recovery.
 * Uses a real workspace client with in-memory Y.Doc.
 *
 * Key behaviors:
 * - One bad row doesn't abort the entire import. Valid rows still land
 * - Errors are collected with table name, row index, and validation message
 * - Stats include both imported count and skipped count
 */

import { describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { importRedditExport } from './index.js';
import { createRedditImport } from './workspace.js';

/** Create a mock Reddit export ZIP from filename → CSV text entries */
function createZip(entries: Record<string, string>): Blob {
	const files: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(entries)) {
		files[name] = new TextEncoder().encode(content);
	}
	return new Blob([zipSync(files) as BlobPart]);
}

function setup() {
	const workspace = createRedditImport();
	return { workspace };
}

// ============================================================================
// Row-Level Error Recovery (Phase 2)
// ============================================================================

describe('row-level error recovery', () => {
	test('valid rows imported, malformed row skipped and reported', async () => {
		// post_votes schema requires direction to be 'up' | 'down' | 'none' | 'removed'
		// Row 2 has an invalid direction "sideways" which fails validation
		const zip = createZip({
			'post_votes.csv': [
				'id,permalink,direction',
				'1,/r/a,up',
				'2,/r/b,sideways',
				'3,/r/c,down',
			].join('\n'),
		});

		const { workspace } = setup();
		const stats = await importRedditExport(zip, workspace);

		expect(stats.tables.postVotes).toBe(2);
		expect(stats.skipped).toBeGreaterThanOrEqual(1);
		expect(stats.errors.length).toBeGreaterThanOrEqual(1);
		expect(stats.errors[0]).toMatchObject({
			table: 'postVotes',
			rowIndex: 1,
		});
	});

	test('all rows invalid results in zero imported and all errors collected', async () => {
		const zip = createZip({
			'post_votes.csv': [
				'id,permalink,direction',
				'1,/r/a,sideways',
				'2,/r/b,diagonal',
			].join('\n'),
		});

		const { workspace } = setup();
		const stats = await importRedditExport(zip, workspace);

		expect(stats.tables.postVotes).toBe(0);
		expect(stats.errors).toHaveLength(2);
		expect(stats.skipped).toBe(2);
	});

	test('empty CSV produces zero rows and zero errors', async () => {
		const zip = createZip({
			'post_votes.csv': 'id,permalink,direction\n',
		});

		const { workspace } = setup();
		const stats = await importRedditExport(zip, workspace);

		expect(stats.tables.postVotes).toBe(0);
		expect(stats.errors).toHaveLength(0);
	});
});
