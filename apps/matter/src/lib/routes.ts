/**
 * The app's URL grammar in one place. Every link, redirect, and `goto` builds its path here
 * instead of hand-writing `/vault/${id}`, so the route shape has a single owner: change it once
 * and the compiler finds every caller. Pure and stateless (the sidebar LIST is `open-vaults`', the
 * active vault is the URL's, the active table is the URL's too via `?table=`), so this is
 * functions, not a store. Callers pass these strings straight to `goto`, `<a href>`, or `redirect`.
 */

import type { ViewSpec } from '@epicenter/matter-core';

/** The query-param key the active table is addressed by. Read and write share it, so they agree. */
export const TABLE_PARAM = 'table';

/** The query-param key the table-scoped projection is addressed by. Absent means the table grid. */
export const VIEW_PARAM = 'view';

/** The query-param key the vault-wide panel is addressed by. */
export const PANEL_PARAM = 'panel';

/** A vault-wide panel that eclipses the table pane. */
export type VaultPanel = 'sql' | 'db';

export type RouteTableView =
	| { mode: 'typed'; contract: { views: readonly ViewSpec[] } }
	| { mode: 'untyped' };

export type VaultSurface =
	| { kind: 'grid' }
	| { kind: 'projection'; projection: ViewSpec }
	| { kind: 'panel'; panel: VaultPanel };

function isVaultPanel(panel: string | null): panel is VaultPanel {
	return panel === 'sql' || panel === 'db';
}

function query(params: Record<string, string | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) search.set(key, value);
	}
	return `?${search.toString()}`;
}

export function resolveVaultSurface(
	searchParams: URLSearchParams,
	tableView: RouteTableView | undefined,
): VaultSurface {
	const panel = searchParams.get(PANEL_PARAM);
	if (isVaultPanel(panel)) return { kind: 'panel', panel };

	const viewId = searchParams.get(VIEW_PARAM);
	if (viewId === null || tableView?.mode !== 'typed') return { kind: 'grid' };

	const projection = tableView.contract.views.find(
		(view) => view.id === viewId,
	);
	return projection ? { kind: 'projection', projection } : { kind: 'grid' };
}

/**
 * The `goto` options every switcher pairs with `routes.table`/`projection`/`panel`. A table or view
 * switch is a render selection, not navigation: `replaceState` so each click does not stack a history
 * entry, `keepFocus`/`noScroll` so the switcher stays put and the pane does not jump. One owner so the
 * vault shell and the table pane cannot drift.
 */
export const SWITCH_NAV = {
	replaceState: true,
	keepFocus: true,
	noScroll: true,
} as const;

export const routes = {
	/** The onboarding index, shown only when no vault is open. */
	home: () => '/',
	/** An open vault, addressed by its opaque persisted id. */
	vault: (id: string) => `/vault/${id}`,
	/**
	 * Select a table within the active vault. A relative query (no id), so switching tables stays
	 * on the same vault route without rebuilding its id or remounting its watcher. Clears `?view`
	 * and `?panel`, so picking a table returns to that table's grid.
	 */
	table: (name: string) => `?${TABLE_PARAM}=${encodeURIComponent(name)}`,
	/** Select a table-scoped projection. Keeps the table axis explicit. */
	projection: (table: string, view: string) =>
		query({ [TABLE_PARAM]: table, [VIEW_PARAM]: view }),
	/** Select a vault-wide panel. Keeps the table axis explicit when a table is active. */
	panel: (panel: VaultPanel, table?: string) =>
		query({ [TABLE_PARAM]: table, [PANEL_PARAM]: panel }),
};
