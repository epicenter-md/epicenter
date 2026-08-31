/**
 * Browse read-models over the local mirror: the entity list with counts, a page
 * of one entity's rows, and one row's detail with its verbatim blob. These are
 * the shapes the `app` SPA renders; the `query` verb is the arbitrary-SQL surface
 * beneath them, and `readBooksStatus` is the connection-and-freshness read beside
 * them. All three are read-only reads over the same SQLite mirror.
 *
 * Like `queryBooks`, each opens a fresh read-only handle per call (cheap, and it
 * never blocks or is blocked by a concurrent sync's write lock). The caller must
 * pass an `EntityDef` from the registry (`entityDef(name)`), never a raw table
 * name: the registry is the SQL-identifier boundary, so no request string reaches
 * a table name.
 */

import { type EntityStatus, openBooksDbReadonly } from '../db.ts';
import type { DbFile } from '../db-file.ts';
import type { EntityDef, GeneratedColumn } from '../entities.ts';

/** One entity in the browse list: its mirror counts plus the columns to render. */
export type EntitySummary = EntityStatus & {
	table: string;
	columns: GeneratedColumn[];
};

/** A page of one entity's rows: the rows plus the total for pagination. */
export type EntityRowsPage = {
	entity: string;
	columns: GeneratedColumn[];
	rows: Record<string, unknown>[];
	total: number;
	limit: number;
	offset: number;
};

/** One row's detail: bookkeeping, this entity's extracted columns, and the blob. */
export type EntityRowDetail = {
	entity: string;
	id: string;
	updatedAt: string | null;
	syncedAt: string | null;
	deleted: boolean;
	/** The extracted scalar columns for this entity, keyed by column name. */
	columns: Record<string, unknown>;
	/** The verbatim QuickBooks JSON blob, parsed. */
	raw: unknown;
};

/**
 * The entity list with per-entity row counts and the registry columns to render.
 * "Mirror not built yet" is a reported state (`mirrorBuilt: false`, empty list),
 * not an error, matching `readBooksStatus`.
 */
export function listEntities({
	mirror,
	defs,
}: {
	mirror: DbFile;
	defs: EntityDef[];
}): { mirrorBuilt: boolean; entities: EntitySummary[] } {
	const db = openBooksDbReadonly(mirror);
	if (db === null) return { mirrorBuilt: false, entities: [] };
	try {
		const entities = defs.map((def) => ({
			...db.entityStatus(def),
			table: def.table,
			columns: def.columns,
		}));
		return { mirrorBuilt: true, entities };
	} finally {
		db.close();
	}
}

/** A page of one entity's rows, newest first. Empty when the mirror is absent. */
export function pageEntityRows({
	mirror,
	def,
	limit,
	offset,
}: {
	mirror: DbFile;
	def: EntityDef;
	limit: number;
	offset: number;
}): EntityRowsPage {
	const db = openBooksDbReadonly(mirror);
	if (db === null) {
		return {
			entity: def.name,
			columns: def.columns,
			rows: [],
			total: 0,
			limit,
			offset,
		};
	}
	try {
		const { rows, total } = db.pageRows(def, { limit, offset });
		return {
			entity: def.name,
			columns: def.columns,
			rows,
			total,
			limit,
			offset,
		};
	} finally {
		db.close();
	}
}

/** One row's detail with its parsed blob, or `null` when the row is unknown. */
export function getEntityRow({
	mirror,
	def,
	id,
}: {
	mirror: DbFile;
	def: EntityDef;
	id: string;
}): EntityRowDetail | null {
	const db = openBooksDbReadonly(mirror);
	if (db === null) return null;
	try {
		const row = db.getRow(def, id);
		if (!row) return null;
		// Split the flat SQLite row into bookkeeping, the extracted columns, and the
		// parsed blob so the detail view can present each distinctly.
		const columns: Record<string, unknown> = {};
		for (const c of def.columns) columns[c.name] = row[c.name];
		let raw: unknown = null;
		if (typeof row.raw === 'string') {
			try {
				raw = JSON.parse(row.raw);
			} catch {
				raw = row.raw; // keep the unparseable string rather than dropping it
			}
		}
		return {
			entity: def.name,
			id: String(row.id),
			updatedAt: (row.updated_at as string | null) ?? null,
			syncedAt: (row.synced_at as string | null) ?? null,
			deleted: row.deleted === 1,
			columns,
			raw,
		};
	} finally {
		db.close();
	}
}
