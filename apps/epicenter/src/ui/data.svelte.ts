/**
 * The raw view's state: which namespace is selected, and the last answer.
 *
 * Selecting a namespace is the mode, not a filter (ADR-0209). A table name is
 * unqualified only inside one interpretation, and two applications may both
 * declare `notes`, so `SELECT * FROM notes` means nothing until one is picked.
 * `undefined` is therefore a real selection, "Everything raw", rather than a
 * missing one: it is the only view that spans applications, and what it shows
 * is the honest storage shape with its JSON and its tombstones.
 *
 * The selection travels with every query because the surface is stateless: the
 * host opens a connection per statement rather than holding one whose selected
 * Lens could drift out from under this.
 */

import type { InspectNamespace } from '../inspect.ts';
import { INSPECT_QUERY_ROUTE, INSPECT_ROUTE } from '../routes.ts';
import type { InspectQueryResponse, InspectResponse } from '../server.ts';

/** What a person sees before they have typed anything, for one selection. */
function openingQuery(namespace: InspectNamespace | undefined): string {
	if (namespace === undefined) {
		return 'SELECT namespace, table_name, row_id, presence\nFROM _epicenter_rows';
	}
	const first = namespace.tables[0];
	// A namespace whose Lens declares no table is possible and answers nothing
	// useful, so it opens on the statement that at least runs.
	return first === undefined ? 'SELECT 1' : `SELECT * FROM ${first.name}`;
}

export function createDataBrowser() {
	let namespaces = $state<InspectNamespace[]>([]);
	// The namespace string, or undefined for "Everything raw".
	let selected = $state<string | undefined>(undefined);
	let sql = $state(openingQuery(undefined));
	let rows = $state<Record<string, unknown>[]>([]);
	let truncated = $state(false);
	let failure = $state<string | null>(null);
	let running = $state(false);

	async function load(): Promise<void> {
		const response = await fetch(INSPECT_ROUTE.url(location.origin));
		if (!response.ok) {
			throw new Error(`Epicenter answered ${response.status}.`);
		}
		namespaces = ((await response.json()) as InspectResponse).namespaces;
	}

	async function run(): Promise<void> {
		running = true;
		try {
			const response = await fetch(INSPECT_QUERY_ROUTE.url(location.origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ namespace: selected, sql }),
			});
			const answer = (await response.json()) as InspectQueryResponse;
			if (answer.error !== undefined) {
				// SQLite's own sentence. A syntax error, an unknown table, and an
				// attempted write all land here, and the engine says which better
				// than a taxonomy would.
				failure = answer.error;
				rows = [];
				truncated = false;
				return;
			}
			failure = null;
			rows = answer.rows as Record<string, unknown>[];
			truncated = answer.truncated;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			running = false;
		}
	}

	return {
		get namespaces() {
			return namespaces;
		},
		get selected() {
			return selected;
		},
		get sql() {
			return sql;
		},
		set sql(next: string) {
			sql = next;
		},
		get rows() {
			return rows;
		},
		/** The columns of the last answer, in the order the statement produced. */
		get columns() {
			return Object.keys(rows[0] ?? {});
		},
		get truncated() {
			return truncated;
		},
		get failure() {
			return failure;
		},
		get running() {
			return running;
		},
		load,
		run,
		/** Pick a namespace, or `undefined` for everything raw, and show it. */
		select(namespace: string | undefined) {
			selected = namespace;
			sql = openingQuery(
				namespaces.find((candidate) => candidate.namespace === namespace),
			);
			void run();
		},
		/**
		 * Show one table of the namespace already selected.
		 *
		 * Not a second mode: the interpretation is whatever `select` last chose,
		 * and this only replaces the statement, the same way typing would.
		 */
		selectTable(table: string) {
			sql = `SELECT * FROM ${table}`;
			void run();
		},
	};
}
