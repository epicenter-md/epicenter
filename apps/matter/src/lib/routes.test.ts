/**
 * Vault Route Resolver Tests
 *
 * Verifies the pure URL grammar for Matter's vault route: `?panel` selects
 * vault-wide panels, `?view` selects projections from the active typed table, and
 * grid remains the fallback. This keeps panel ids from occupying the table
 * projection namespace.
 *
 * Key behaviors:
 * - `?panel=sql|db` resolves only vault-wide panels.
 * - `?view=<id>` resolves only against the active typed table's views.
 * - Unknown or inapplicable route params fall back to the grid.
 */

import { expect, test } from 'bun:test';
import type { ViewSpec } from '@epicenter/matter-core';
import {
	PANEL_PARAM,
	resolveVaultSurface,
	routes,
	TABLE_PARAM,
	VIEW_PARAM,
} from './routes';

const pipeline: ViewSpec = {
	id: 'pipeline',
	type: 'board',
	groupBy: 'status',
};

const sqlProjection: ViewSpec = {
	id: 'sql',
	type: 'board',
	groupBy: 'status',
};

function params(query: string): URLSearchParams {
	return new URLSearchParams(query);
}

function typedTable(views: readonly ViewSpec[] = [pipeline]) {
	return { mode: 'typed', contract: { views } } as const;
}

const untypedTable = { mode: 'untyped' } as const;

test('?panel=sql resolves panel', () => {
	expect(
		resolveVaultSurface(params(`${PANEL_PARAM}=sql`), typedTable()),
	).toEqual({
		kind: 'panel',
		panel: 'sql',
	});
});

test('unknown ?panel does not resolve panel', () => {
	expect(
		resolveVaultSurface(params(`${PANEL_PARAM}=unknown`), typedTable()),
	).toEqual({ kind: 'grid' });
});

test('known table view resolves projection', () => {
	expect(
		resolveVaultSurface(params(`${VIEW_PARAM}=pipeline`), typedTable()),
	).toEqual({ kind: 'projection', projection: pipeline });
});

test('unknown ?view resolves grid', () => {
	expect(
		resolveVaultSurface(params(`${VIEW_PARAM}=missing`), typedTable()),
	).toEqual({
		kind: 'grid',
	});
});

test('untyped table plus ?view resolves grid', () => {
	expect(
		resolveVaultSurface(params(`${VIEW_PARAM}=pipeline`), untypedTable),
	).toEqual({ kind: 'grid' });
});

test('board id sql does not collide with ?panel=sql', () => {
	expect(
		resolveVaultSurface(
			params(`${VIEW_PARAM}=sql`),
			typedTable([sqlProjection]),
		),
	).toEqual({ kind: 'projection', projection: sqlProjection });
	expect(
		resolveVaultSurface(
			params(`${PANEL_PARAM}=sql&${VIEW_PARAM}=sql`),
			typedTable([sqlProjection]),
		),
	).toEqual({ kind: 'panel', panel: 'sql' });
});

test('absent ?view resolves grid', () => {
	expect(resolveVaultSurface(params(''), typedTable())).toEqual({
		kind: 'grid',
	});
});

test('table helper clears projection and panel params', () => {
	expect(routes.table('tasks')).toBe(`?${TABLE_PARAM}=tasks`);
});

test('projection helper keeps table and sets ?view', () => {
	expect(routes.projection('tasks', 'pipeline')).toBe(
		`?${TABLE_PARAM}=tasks&${VIEW_PARAM}=pipeline`,
	);
});

test('panel helper sets ?panel and keeps table when present', () => {
	expect(routes.panel('db', 'tasks')).toBe(
		`?${TABLE_PARAM}=tasks&${PANEL_PARAM}=db`,
	);
	expect(routes.panel('sql')).toBe(`?${PANEL_PARAM}=sql`);
});
