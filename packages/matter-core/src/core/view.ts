/**
 * Declared editable views over a typed folder: the `views` array in `matter.json`,
 * parsed as data (never executable code), plus the pure decision logic behind the
 * board surface.
 *
 * A view is a different rendering of the SAME rows the grid shows, writing edits back
 * through the same `saveField` path, so everything here is a pure function: parse the
 * declared views against the contract's fields and group rows into board buckets. The
 * UI layers (later waves) stay thin because the decisions live here, under bun tests.
 *
 * Board is deliberately the ONLY view type today. Views are a family of typed-row
 * projections that earn persisted spec surface one renderer at a time (ADR-0101);
 * board goes first as the cheapest complete proof of an editable projection. A future
 * view type (calendar is the presumptive next) enters as a new additive union member,
 * spec'd against its real renderer.
 *
 * Degrade mirrors the contract's own philosophy: a malformed `views` entry is dropped
 * with a {@link ViewError} diagnostic and every valid view survives, the same way a
 * field outside the palette degrades to `untyped` without erroring the folder. The
 * shapes are CLOSED (an unknown key rejects the entry) so a typo'd key dies loudly at
 * the boundary instead of being silently ignored.
 */

import type { Kind } from '@epicenter/field';
import type { ContractField } from './contract';
import type { Row } from './parse';
import type { StemQuery } from './query';

/**
 * One declared view, discriminated by `type`. This is the parsed form of a `views`
 * entry in `matter.json`: pure data describing a rendering, never code. A single-member
 * union on purpose: new view types join here additively once their renderer exists
 * (ADR-0101).
 */
export type ViewSpec = {
	id: string;
	type: 'board';
	/** Display name for the view switcher; falls back to `id`. */
	title?: string;
	/** The field whose value places a row in a column (select, string, or reference kind). */
	groupBy: string;
	/** The declared column values, in display order. Omitted: derived from the data. */
	columns?: string[];
	/** Field names shown read-only on each card. */
	card?: string[];
	/** The view's default query, seeded when it opens: exactly the grid's {@link StemQuery},
	 *  because a view orders and filters its stems through the same mirror query the grid runs. */
	query?: StemQuery;
};

/** A `views` entry that could not be parsed: which view (id, or `views[i]` when the id itself is unreadable) and why. */
export type ViewError = {
	view: string;
	message: string;
};

/** Valid view ids are slug-safe: no separators, dots, or uppercase, so they are URL- and filename-inert. */
const VIEW_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The kinds a board can group by: closed-set or string-shaped values that name a column. */
const BOARD_GROUP_KINDS: ReadonlySet<Kind> = new Set([
	'select',
	'string',
	'reference',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === 'string')
	);
}

/** The first key the closed shape does not allow, or undefined when the entry is clean. */
function unknownKey(
	entry: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(entry).find((key) => !allowed.includes(key));
}

/**
 * Parse the raw `views` value from `matter.json` against the contract's typed fields.
 * Per-entry degrade: each malformed entry becomes one {@link ViewError} and is dropped;
 * every valid entry survives. `undefined` (no `views` key) is simply no views.
 */
export function parseViews(
	raw: unknown,
	fields: readonly ContractField[],
): { views: ViewSpec[]; errors: ViewError[] } {
	if (raw === undefined) return { views: [], errors: [] };
	if (!Array.isArray(raw)) {
		return {
			views: [],
			errors: [
				{ view: 'views', message: 'views must be an array of view objects' },
			],
		};
	}
	const entries: unknown[] = raw;
	const byName = new Map(fields.map((field) => [field.name, field]));

	const views: ViewSpec[] = [];
	const errors: ViewError[] = [];
	for (const [index, entry] of entries.entries()) {
		const label =
			isPlainObject(entry) && typeof entry.id === 'string'
				? entry.id
				: `views[${index}]`;
		const parsed = parseView(entry, byName);
		if ('error' in parsed) {
			errors.push({ view: label, message: parsed.error });
			continue;
		}
		if (views.some((view) => view.id === parsed.view.id)) {
			errors.push({
				view: label,
				message: `duplicate view id "${parsed.view.id}"`,
			});
			continue;
		}
		views.push(parsed.view);
	}
	return { views, errors };
}

type ParsedView = { view: ViewSpec } | { error: string };

function parseView(
	entry: unknown,
	fields: Map<string, ContractField>,
): ParsedView {
	if (!isPlainObject(entry)) return { error: 'a view must be a JSON object' };
	const { id, title, type } = entry;
	if (typeof id !== 'string' || !VIEW_ID.test(id)) {
		return {
			error:
				'a view id must be lowercase letters, digits, and hyphens, starting with a letter or digit',
		};
	}
	if (title !== undefined && typeof title !== 'string') {
		return { error: 'title must be a string' };
	}
	const base = { id, ...(title !== undefined && { title }) };
	switch (type) {
		case 'board':
			return parseBoard(entry, base, fields);
		default:
			return {
				error: `unknown view type ${JSON.stringify(type)}: expected "board"`,
			};
	}
}

type ViewBase = { id: string; title?: string };

function parseBoard(
	entry: Record<string, unknown>,
	base: ViewBase,
	fields: Map<string, ContractField>,
): ParsedView {
	const stray = unknownKey(entry, [
		'id',
		'type',
		'title',
		'groupBy',
		'columns',
		'card',
		'query',
	]);
	if (stray !== undefined) {
		return { error: `unknown key "${stray}" on a board view` };
	}
	const { groupBy, columns } = entry;
	if (typeof groupBy !== 'string') {
		return { error: 'a board needs a groupBy field name' };
	}
	const field = fields.get(groupBy);
	if (!field) {
		return { error: `groupBy field "${groupBy}" is not in this contract` };
	}
	if (!BOARD_GROUP_KINDS.has(field.kind)) {
		return {
			error: `groupBy field "${groupBy}" has kind ${field.kind}; a board groups by a select, string, or reference field`,
		};
	}
	if (columns !== undefined && !isStringArray(columns)) {
		return { error: 'columns must be an array of strings' };
	}
	const card = parseCard(entry.card, fields);
	if ('error' in card) return { error: card.error };
	const query = parseQuery(entry.query);
	if ('error' in query) return { error: query.error };
	return {
		view: {
			...base,
			type: 'board',
			groupBy,
			...(columns !== undefined && { columns }),
			...(card.card !== undefined && { card: card.card }),
			...(query.query !== undefined && { query: query.query }),
		},
	};
}

/** The card list is read-only field names on a board card; every name must be a typed field. */
function parseCard(
	card: unknown,
	fields: Map<string, ContractField>,
): { card?: string[] } | { error: string } {
	if (card === undefined) return {};
	if (!isStringArray(card)) {
		return { error: 'card must be an array of field names' };
	}
	const missing = card.find((name) => !fields.has(name));
	if (missing !== undefined) {
		return { error: `card field "${missing}" is not in this contract` };
	}
	return { card };
}

type ParsedQuery = { query?: StemQuery } | { error: string };

/**
 * Shape-checks a view's default query. Column names in `sort` (and the raw `where`
 * fragment) are deliberately NOT resolved against the contract: the queryable
 * vocabulary (`stem`, the field columns, `_extra`, `body`) is owned by the SQLite
 * projection, and a bad name degrades the way the grid's own bad `where` does, as a
 * query-time error against the read-only mirror.
 */
function parseQuery(raw: unknown): ParsedQuery {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) return { error: 'query must be an object' };
	const stray = unknownKey(raw, ['where', 'match', 'sort']);
	if (stray !== undefined) {
		return { error: `unknown key "${stray}" in a view query` };
	}
	const { where, match, sort } = raw;
	if (where !== undefined && typeof where !== 'string') {
		return { error: 'query.where must be a string' };
	}
	if (match !== undefined && typeof match !== 'string') {
		return { error: 'query.match must be a string' };
	}
	let parsedSort: StemQuery['sort'];
	if (sort !== undefined) {
		if (!isPlainObject(sort)) {
			return { error: 'query.sort must be a { column, dir } object' };
		}
		const straySort = unknownKey(sort, ['column', 'dir']);
		if (straySort !== undefined) {
			return { error: `unknown key "${straySort}" in query.sort` };
		}
		if (typeof sort.column !== 'string') {
			return { error: 'query.sort.column must be a column name' };
		}
		if (sort.dir !== 'asc' && sort.dir !== 'desc') {
			return { error: 'query.sort.dir must be "asc" or "desc"' };
		}
		parsedSort = { column: sort.column, dir: sort.dir };
	}
	// An empty query object declares nothing; normalize it away so `view.query`
	// present always means there is a default query to seed.
	if (where === undefined && match === undefined && parsedSort === undefined) {
		return {};
	}
	return {
		query: {
			...(where !== undefined && { where }),
			...(match !== undefined && { match }),
			...(parsedSort !== undefined && { sort: parsedSort }),
		},
	};
}

/**
 * One board column and the rows in it. `value` is the `groupBy` frontmatter value the
 * column holds; `null` is the Unassigned bucket (rows whose cell is absent or null,
 * per the nullish contract). A bucket's `value` is also its drop identity: a card
 * dropped onto it writes that value via `saveField` (`null` clears the field, per the
 * nullish contract: delete the key, never write null). Whether the value is ALLOWED
 * (an out-of-enum stray bucket) is the caller's `field.check` guard before writing.
 */
export type BoardBucket = {
	value: string | null;
	rows: Row[];
};

/**
 * Group rows into board buckets by one frontmatter field. The declared `columns` come
 * first, in declared order, each present even when empty (a board renders empty
 * columns). A present value OUTSIDE the declared columns gets its own trailing bucket
 * (first-seen order) so out-of-enum data stays visible instead of vanishing, the same
 * way untyped fields surface raw. Rows with no value (absent or null) land in a
 * trailing Unassigned bucket (`value: null`), present only when non-empty.
 */
export function groupRowsByField(
	rows: readonly Row[],
	groupBy: string,
	columns: readonly string[],
): BoardBucket[] {
	const buckets = new Map<string, Row[]>();
	for (const column of columns) {
		if (!buckets.has(column)) buckets.set(column, []);
	}
	const unassigned: Row[] = [];
	for (const row of rows) {
		const value = row.frontmatter[groupBy];
		if (value == null) {
			unassigned.push(row);
			continue;
		}
		// A non-string value (a number in a status field) is still assigned; show it as its
		// own stray bucket rather than hiding it under Unassigned.
		const key = typeof value === 'string' ? value : String(value);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(row);
		else buckets.set(key, [row]);
	}
	const grouped: BoardBucket[] = [...buckets].map(([value, bucketRows]) => ({
		value,
		rows: bucketRows,
	}));
	if (unassigned.length > 0) grouped.push({ value: null, rows: unassigned });
	return grouped;
}
