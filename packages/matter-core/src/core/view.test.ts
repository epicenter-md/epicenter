/**
 * Editable View Tests
 *
 * Verifies the pure logic behind declared views: parsing the `views` array from
 * `matter.json` against a contract's fields (valid entries survive, malformed
 * entries drop with one diagnostic each) and grouping rows into board buckets.
 * Board is the only view type today (ADR-0101); a future type re-enters as a new
 * union member with its own parse and grouping tests.
 *
 * Key behaviors:
 * - Per-entry degrade: one bad view never takes down its valid siblings.
 * - Closed shapes: a typo'd key on a view or query rejects that entry loudly.
 * - The nullish contract: absent and null both mean "no value" for buckets.
 *
 * See also:
 * - `contract.test.ts` for views riding on `validateContract` / `parseContract`.
 */

import { describe, expect, test } from 'bun:test';
import { validateContract } from './contract';
import type { Row } from './parse';
import { groupRowsByField, parseViews } from './view';

/** One contract with a field of every view-relevant kind, compiled once for all tests. */
function setup() {
	const built = validateContract({
		fields: {
			title: { type: 'string' },
			status: { enum: ['idea', 'drafting', 'posted'] },
			platform: { type: 'string' },
			page: { type: 'string', 'x-ref': 'pages' },
			publish_at: { type: 'string', format: 'date-time' },
			rating: { type: 'integer' },
		},
		optional: ['platform', 'page', 'publish_at', 'rating'],
	});
	if (built.error) throw new Error(built.error.message);
	return { fields: built.data.fields };
}

function row(fileName: string, frontmatter: Record<string, unknown>): Row {
	return { fileName, frontmatter, body: '' };
}

// ============================================================================
// parseViews
// ============================================================================

describe('parseViews (declared views against the contract)', () => {
	test('a board entry parses with its optional keys', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[
				{
					id: 'pipeline',
					type: 'board',
					title: 'Pipeline',
					groupBy: 'status',
					columns: ['idea', 'drafting', 'posted'],
					card: ['title', 'platform'],
					query: { sort: { column: 'publish_at', dir: 'asc' } },
				},
			],
			fields,
		);
		expect(errors).toEqual([]);
		expect(views).toEqual([
			{
				id: 'pipeline',
				type: 'board',
				title: 'Pipeline',
				groupBy: 'status',
				columns: ['idea', 'drafting', 'posted'],
				card: ['title', 'platform'],
				query: { sort: { column: 'publish_at', dir: 'asc' } },
			},
		]);
	});

	test('no views key means no views and no errors', () => {
		const { fields } = setup();
		expect(parseViews(undefined, fields)).toEqual({ views: [], errors: [] });
	});

	test('a non-array views value is one error and no views', () => {
		const { fields } = setup();
		const { views, errors } = parseViews({ pipeline: {} }, fields);
		expect(views).toEqual([]);
		expect(errors).toEqual([
			{ view: 'views', message: 'views must be an array of view objects' },
		]);
	});

	test('a malformed entry drops with an error; valid siblings survive', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[
				{ id: 'pipeline', type: 'board', groupBy: 'status' },
				{ id: 'broken', type: 'board', groupBy: 'nope' },
				{ id: 'by-platform', type: 'board', groupBy: 'platform' },
			],
			fields,
		);
		expect(views.map((view) => view.id)).toEqual(['pipeline', 'by-platform']);
		expect(errors).toEqual([
			{
				view: 'broken',
				message: 'groupBy field "nope" is not in this contract',
			},
		]);
	});

	test('a view id must be slug-safe', () => {
		const { fields } = setup();
		for (const id of ['Pipeline', 'has space', '-lead', 'dots.bad', '']) {
			const { views, errors } = parseViews(
				[{ id, type: 'board', groupBy: 'status' }],
				fields,
			);
			expect(views).toEqual([]);
			expect(errors).toHaveLength(1);
		}
	});

	test('a duplicate id drops the second entry', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[
				{ id: 'pipeline', type: 'board', groupBy: 'status' },
				{ id: 'pipeline', type: 'board', groupBy: 'platform' },
			],
			fields,
		);
		expect(views.map((view) => view.groupBy)).toEqual(['status']);
		expect(errors).toEqual([
			{ view: 'pipeline', message: 'duplicate view id "pipeline"' },
		]);
	});

	test('a non-object entry and an unknown type each drop with an error', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			['pipeline', { id: 'gallery', type: 'gallery' }],
			fields,
		);
		expect(views).toEqual([]);
		expect(errors.map((error) => error.view)).toEqual(['views[0]', 'gallery']);
		expect(errors[1]?.message).toContain('"gallery"');
	});

	test('board groupBy accepts select, string, and reference kinds', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[
				{ id: 'by-status', type: 'board', groupBy: 'status' },
				{ id: 'by-platform', type: 'board', groupBy: 'platform' },
				{ id: 'by-page', type: 'board', groupBy: 'page' },
			],
			fields,
		);
		expect(errors).toEqual([]);
		expect(views).toHaveLength(3);
	});

	test('board groupBy rejects non-groupable kinds with the kind named', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[{ id: 'by-rating', type: 'board', groupBy: 'rating' }],
			fields,
		);
		expect(views).toEqual([]);
		expect(errors[0]?.message).toBe(
			'groupBy field "rating" has kind integer; a board groups by a select, string, or reference field',
		);
	});

	test('card fields must name contract fields', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[{ id: 'b', type: 'board', groupBy: 'status', card: ['title', 'nope'] }],
			fields,
		);
		expect(views).toEqual([]);
		expect(errors.map((error) => error.message)).toEqual([
			'card field "nope" is not in this contract',
		]);
	});

	test("a typo'd key on a view rejects the entry (closed shape)", () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[{ id: 'pipeline', type: 'board', groupBy: 'status', colums: ['idea'] }],
			fields,
		);
		expect(views).toEqual([]);
		expect(errors).toEqual([
			{ view: 'pipeline', message: 'unknown key "colums" on a board view' },
		]);
	});

	test('an empty query object normalizes away: view.query present means a real default', () => {
		const { fields } = setup();
		const { views, errors } = parseViews(
			[{ id: 'pipeline', type: 'board', groupBy: 'status', query: {} }],
			fields,
		);
		expect(errors).toEqual([]);
		expect(views).toEqual([
			{ id: 'pipeline', type: 'board', groupBy: 'status' },
		]);
	});

	test('query shape is validated: dir, sort keys, and unknown keys', () => {
		const { fields } = setup();
		const bad = [
			{ query: { sort: { column: 'title', dir: 'up' } } },
			{ query: { sort: { column: 'title', dir: 'asc', extra: 1 } } },
			{ query: { orderBy: 'title asc' } },
			{ query: 'title asc' },
		];
		for (const { query } of bad) {
			const { views, errors } = parseViews(
				[{ id: 'pipeline', type: 'board', groupBy: 'status', query }],
				fields,
			);
			expect(views).toEqual([]);
			expect(errors).toHaveLength(1);
		}
	});
});

// ============================================================================
// groupRowsByField
// ============================================================================

describe('groupRowsByField (board buckets)', () => {
	test('declared columns come first in order, present even when empty', () => {
		const rows = [
			row('a.md', { status: 'posted' }),
			row('b.md', { status: 'idea' }),
		];
		expect(
			groupRowsByField(rows, 'status', ['idea', 'drafting', 'posted']),
		).toEqual([
			{ value: 'idea', rows: [rows[1]!] },
			{ value: 'drafting', rows: [] },
			{ value: 'posted', rows: [rows[0]!] },
		]);
	});

	test('a value outside the declared columns gets its own trailing bucket', () => {
		const rows = [
			row('a.md', { status: 'idea' }),
			row('b.md', { status: 'archived' }),
			row('c.md', { status: 7 }),
		];
		const buckets = groupRowsByField(rows, 'status', ['idea']);
		expect(buckets.map((bucket) => bucket.value)).toEqual([
			'idea',
			'archived',
			'7',
		]);
	});

	test('absent and null values land in a trailing Unassigned (null) bucket', () => {
		const rows = [
			row('a.md', { status: 'idea' }),
			row('b.md', {}),
			row('c.md', { status: null }),
		];
		const buckets = groupRowsByField(rows, 'status', ['idea']);
		expect(buckets).toEqual([
			{ value: 'idea', rows: [rows[0]!] },
			{ value: null, rows: [rows[1]!, rows[2]!] },
		]);
	});

	test('no Unassigned bucket when every row is assigned', () => {
		const rows = [row('a.md', { status: 'idea' })];
		expect(
			groupRowsByField(rows, 'status', ['idea']).map((bucket) => bucket.value),
		).toEqual(['idea']);
	});
});
