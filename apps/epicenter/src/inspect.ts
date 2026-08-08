/**
 * The raw view's data surface: namespaces to list, and one statement to run.
 *
 * ADR-0209. Epicenter's own job is showing the data raw, and `openInspection`
 * (ADR-0162) has existed since it was written with nothing reaching it. This is
 * what reaches it.
 *
 * A connection per statement, not one held open. Selecting a Lens is connection
 * state, so a shared connection would let one request's namespace decide another
 * request's answer, and the fix would be a lock around a thing that costs
 * milliseconds to open. The sidebar's selection therefore travels with the
 * query, which is also what makes the surface stateless.
 *
 * Read-only is the connection's own doing: `openInspection` opens the replica
 * with `readonly: true`, so a submitted `INSERT` fails in SQLite rather than in
 * a check here.
 */

import {
	type InspectionError,
	type InspectionResult,
	openInspection,
} from '@epicenter/data/legacy/inspection';
import type { Lens, TableDefinition } from '@epicenter/lens';
import type { Result } from 'wellcrafted/result';

export type HostLens = Lens<Record<string, TableDefinition>>;

/** One namespace as the sidebar lists it. */
export type InspectNamespace = {
	namespace: string;
	/**
	 * What the Lens calls this namespace, when it says. Absent is normal and the
	 * surface shows the namespace itself, which is always correct.
	 */
	title?: string;
	tables: { name: string; fields: string[] }[];
};

export type InspectSource = {
	/** The replica file, which inspection opens read-only on its own handle. */
	replicaPath: string;
	/** Every Lens this host can interpret. One Lens is one namespace. */
	lenses: readonly HostLens[];
};

/**
 * What a person can pick in the sidebar.
 *
 * Tables travel because you cannot query a table you have no way to name, and
 * their field names travel with them because they are exactly the columns
 * `selectLens` will produce, so the sidebar can say what a table holds before
 * anyone has run anything against it.
 */
export function listInspectNamespaces(
	lenses: readonly HostLens[],
): InspectNamespace[] {
	return lenses
		.map((lens) => ({
			namespace: lens.namespace,
			...(lens.title === undefined ? {} : { title: lens.title }),
			tables: Object.entries(lens.tables)
				.map(([name, definition]) => ({
					name,
					fields: Object.keys(definition.fields),
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		}))
		.sort((left, right) => left.namespace.localeCompare(right.namespace));
}

/**
 * Run one statement, inside one namespace's interpretation or in none.
 *
 * `namespace: undefined` is "Everything raw": no Lens is selected, so the
 * friendly tables do not exist and `_epicenter_rows` is what answers. That is
 * the honest shape, tombstones and JSON included, and it is the only thing that
 * spans applications (ADR-0209).
 *
 * A namespace no Lens declares is refused rather than quietly falling back to
 * raw, because a `SELECT * FROM notes` that silently found no interpretation
 * would report "no such table" for a table that exists.
 */
export function runInspectQuery({
	source,
	namespace,
	sql,
}: {
	source: InspectSource;
	namespace?: string | undefined;
	sql: string;
}): Result<InspectionResult, InspectionError | { message: string }> {
	const lens =
		namespace === undefined
			? undefined
			: source.lenses.find((candidate) => candidate.namespace === namespace);
	if (namespace !== undefined && lens === undefined) {
		return {
			data: null,
			error: { message: `No Lens declares the namespace '${namespace}'.` },
		};
	}

	const opened = openInspection({ path: source.replicaPath });
	if (opened.error !== null) return opened;

	const inspection = opened.data;
	try {
		if (lens !== undefined) {
			const selected = inspection.selectLens(lens);
			if (selected.error !== null) return selected;
		}
		return inspection.query(sql);
	} finally {
		inspection.close();
	}
}
