import { describe, expect, test } from 'bun:test';
import { readTable } from './table';

describe('readTable', () => {
	test('splits readable rows from unreadable files and lists raw columns', () => {
		const result = readTable([
			{ fileName: 'a.md', content: '---\ntitle: A\nrating: 5\n---\nbody' },
			{ fileName: 'b.md', content: '---\ntitle: B\n---\nbody' },
			{ fileName: 'broken.md', content: '---\ntitle: [unclosed\n---\nbody' },
			{
				fileName: 'conflict.md',
				content:
					'---\ntitle: Conflict\n<<<<<<< HEAD\nstatus: a\n=======\nstatus: b\n>>>>>>> z\n---\nbody',
			},
			{
				fileName: 'body-conflict.md',
				content: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n',
			},
			{ fileName: 'raw.md', content: '# no frontmatter' },
		]);

		expect(result.rows.map((r) => r.fileName)).toEqual([
			'a.md',
			'b.md',
			'body-conflict.md',
			'raw.md',
		]);
		expect(result.unreadable.map((u) => [u.fileName, u.error.name])).toEqual([
			['broken.md', 'InvalidYaml'],
			['conflict.md', 'ConflictMarkers'],
		]);
		// No contract supplied: a raw untyped view, columns ordered by frequency then
		// first-seen, no type inference.
		expect(result.view.mode).toBe('untyped');
		if (result.view.mode !== 'untyped') throw new Error('expected untyped');
		expect(result.view.columns).toEqual(['title', 'rating']);
	});

	test('a valid matter.json produces a typed view with per-cell conformance', () => {
		const contract = JSON.stringify({
			fields: {
				title: { type: 'string' },
				rating: { type: 'integer' },
			},
		});
		const result = readTable(
			[
				{ fileName: 'a.md', content: '---\ntitle: A\nrating: 5\n---\nbody' },
				{ fileName: 'b.md', content: '---\ntitle: B\n---\nbody' }, // rating absent -> MISSING_REQUIRED
				{
					fileName: 'c.md',
					content: '---\ntitle: C\nrating: "high"\n---\nbody',
				}, // INVALID
			],
			contract,
		);

		expect(result.view.mode).toBe('typed');
		if (result.view.mode !== 'typed') throw new Error('expected typed');
		const valid = result.view.conformance.map((c) => c.rowValid);
		expect(valid).toEqual([true, false, false]);
	});

	test('optional typed fields can be absent or null without invalidating a row', () => {
		const contract = JSON.stringify({
			fields: {
				title: { type: 'string' },
				reviewBy: { type: 'string', format: 'date' },
			},
			optional: ['reviewBy'],
		});
		const result = readTable(
			[
				{ fileName: 'a.md', content: '---\ntitle: A\n---\nbody' },
				{ fileName: 'b.md', content: '---\ntitle: B\nreviewBy:\n---\nbody' },
			],
			contract,
		);

		expect(result.view.mode).toBe('typed');
		if (result.view.mode !== 'typed') throw new Error('expected typed');
		expect(result.view.conformance.map((c) => c.rowValid)).toEqual([
			true,
			true,
		]);
		expect(
			result.view.conformance.map((c) => c.cells.map((cell) => cell.state)),
		).toEqual([
			['OK', 'MISSING_OPTIONAL'],
			['OK', 'MISSING_OPTIONAL'],
		]);
	});

	test('a junk matter.json degrades to the raw view with a diagnostic', () => {
		const result = readTable(
			[{ fileName: 'a.md', content: '---\ntitle: A\n---\nbody' }],
			'{ not json',
		);
		expect(result.view.mode).toBe('untyped');
		if (result.view.mode !== 'untyped') throw new Error('expected untyped');
		expect(result.view.contractError?.name).toBe('InvalidJson');
	});
});
