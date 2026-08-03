import type { Database } from 'bun:sqlite';
import { type Mirror, mirrorAt } from '@epicenter/sqlite/bun-mirror';
import {
	type ColumnType,
	type EntityDef,
	isDeleted,
	lastUpdatedTime,
	type QbObject,
	type SqlIdent,
	sqlIdent,
} from './entities.ts';
import { companyDir } from './paths.ts';

/**
 * The local mirror: one SQLite artifact per company. Holds an entity table per
 * QB type plus `_meta`, a key/value store that carries the realm's sync state.
 *
 * CDC is a high-water-mark protocol: `changedSince` is a single timestamp for a
 * multi-entity call. So the mirror keeps ONE cursor for the whole company, not
 * one per entity, stored in `_meta` (`cdc_cursor`, `last_full_pull_at`,
 * `last_synced_at`). "Has this entity had its first full pull?" is answered by
 * whether its table exists, so there is no per-entity sync-state table: the
 * tables themselves are the initialization latch. The cursor advances in the
 * same transaction as the rows it accounts for (see `ingest`), so
 * ingest-and-advance is atomic and crash-safe.
 *
 * The realm owns its identity through the directory
 * (`<dataDir>/companies/<realmId>/`), not a stored column, so the db need not
 * know which company it holds. Inside that directory the artifact is named by
 * `MIRROR_VERSION` (ADR-0197), so nothing about the stored shape is stamped
 * inside the file and nothing is ever dropped on open.
 */

/**
 * One column of a declared table: the SQLite name and affinity, an optional
 * trailing constraint, and the `json_extract` path when the column is a
 * projection of `raw` rather than a stored value.
 *
 * `constraint` is a raw SQL fragment, which is safe because this file is the
 * only author of one and the set is closed. `name` is branded by `sqlIdent`, and
 * `generated` is built from path segments the registry already validated, so the
 * whole declaration is interpolable into DDL without re-checking.
 */
type ColumnDeclaration = {
	name: SqlIdent;
	type: ColumnType;
	constraint: string | null;
	generated: string | null;
};

type TableDeclaration = { table: SqlIdent; columns: ColumnDeclaration[] };

/** A stored (non-generated) column. */
function stored(
	name: string,
	type: ColumnType,
	constraint: string | null = null,
): ColumnDeclaration {
	return { name: sqlIdent(name), type, constraint, generated: null };
}

/** The bookkeeping columns every entity table carries, in DDL order. */
const ROW_COLUMNS: ColumnDeclaration[] = [
	stored('id', 'TEXT', 'PRIMARY KEY'),
	stored('raw', 'TEXT', 'NOT NULL'),
	stored('updated_at', 'TEXT'),
	stored('synced_at', 'TEXT', 'NOT NULL'),
	stored('deleted', 'INTEGER', 'NOT NULL DEFAULT 0'),
];

/** The key/value table holding the realm's one CDC cursor. */
const META_TABLE: TableDeclaration = {
	table: sqlIdent('_meta'),
	columns: [stored('key', 'TEXT', 'PRIMARY KEY'), stored('value', 'TEXT')],
};

/**
 * One entity's table: the bookkeeping columns plus this entity's extracted
 * scalars, each a VIRTUAL projection of `raw`, so the blob stays the single
 * source of truth and a missing field is `json_extract`'s null for free.
 */
function declareEntityTable(def: EntityDef): TableDeclaration {
	return {
		table: def.table,
		columns: [
			...ROW_COLUMNS,
			...def.columns.map((c) => ({
				name: c.name,
				type: c.type,
				constraint: null,
				generated: `$.${c.path.join('.')}`,
			})),
		],
	};
}

/**
 * The version of the corpus contract this build stores, and the whole of the
 * artifact's identity on disk: `books.v<MIRROR_VERSION>.db` (ADR-0197). It is
 * not the app's release version and it is not a migration target. Nothing reads
 * a lower version, and nothing rewrites one.
 *
 * Bump it when this build would store something a previous build did not: an
 * added, removed, or retyped column; a changed meaning for what a stored column
 * holds; or a change to which QuickBooks entities `entities.ts` can mirror,
 * since that is what a full pull covers. That last one is why editing the
 * registry is not free: adding one entity is a new corpus, so it is a new
 * artifact and one full re-pull of the company.
 *
 * Do not bump it for an index, a read-time projection, a comment, or an app
 * release. None of those change what is on disk, and each bump costs a rebuild.
 */
const MIRROR_VERSION = 1;

/** The mirror as materialized for one company: `<dataDir>/companies/<realmId>/`. */
export function booksMirror(dataDir: string, realmId: string): Mirror {
	return mirrorAt({
		name: 'books',
		version: MIRROR_VERSION,
		directory: companyDir(dataDir, realmId),
	});
}

/** `CREATE TABLE IF NOT EXISTS` for one declared table. */
function createTableSql({ table, columns }: TableDeclaration): string {
	const defs = columns.map((c) => {
		const constraint = c.constraint ? ` ${c.constraint}` : '';
		const generated = c.generated
			? ` GENERATED ALWAYS AS (json_extract(raw, '${c.generated}')) VIRTUAL`
			: '';
		return `${c.name} ${c.type}${constraint}${generated}`;
	});
	return `CREATE TABLE IF NOT EXISTS ${table} (\n\t${defs.join(',\n\t')}\n);`;
}

/**
 * The whole company's CDC position, the single high-water mark. `cdcCursor` is
 * the `changedSince` the next incremental pass passes; `lastFullPullAt` drives
 * the staleness backstop; `lastSyncedAt` is informational. Any field is null
 * before the first sync writes it.
 */
export type RealmState = {
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row destined for an entity table, keyed by QB `id`: the blob plus the
 * timestamp the mirror orders writes by. Built inside `ingest` from a QB object;
 * the destiny (upsert vs soft-delete) is the array it lands in, not the type. The
 * extracted columns are generated from `raw`, so no row carries them.
 */
type MirrorRow = {
	id: string;
	raw: string;
	updatedAt: string | null;
};

/** One entity's slice of an ingest batch: its def and the QB objects to fold in. */
export type IngestEntry = { def: EntityDef; objects: QbObject[] };

/** The partition counts an ingest produced, keyed by QB entity name. */
export type IngestCounts = Record<
	string,
	{ upserted: number; deleted: number }
>;

export type EntityStatus = {
	entity: string;
	rows: number;
	deleted: number;
	/** Whether this entity has been full-pulled (its table exists). */
	initialized: boolean;
};

export type BooksDb = ReturnType<typeof booksDb>;

/**
 * Open the company's current mirror artifact for writing, creating it if absent,
 * and declare `_meta` on it. Nothing here inspects, migrates, or drops what it
 * finds: a different corpus contract is a different filename, so an artifact
 * this opens is always one a build of this version wrote (ADR-0197).
 */
export function openBooksDb(mirror: Mirror): BooksDb {
	const db = mirror.open();
	db.run(createTableSql(META_TABLE));
	return booksDb(db);
}

/**
 * The same reads against a read-only handle on the current artifact, or `null`
 * when the company has no current materialization yet. "Not built" is a state a
 * caller reports, not an error, and never a file this conjures. The connection
 * rejects every write statement, so `ingest` on this handle throws by
 * construction.
 */
export function openBooksDbReadonly(mirror: Mirror): BooksDb | null {
	const db = mirror.openReadonly();
	return db === null ? null : booksDb(db);
}

// The registry (`entities.ts`) is the SQL-identifier boundary: it validates and
// brands every table name, generated-column name (`SqlIdent`), and path segment
// (`JsonPathSegment`) when it is built, so this module interpolates registry
// values into SQL without re-checking them.
function booksDb(db: Database) {
	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	// `db.query()` caches the compiled statement by SQL text, so the per-table
	// statements below are prepared once and reused on repeat calls without a
	// hand-rolled cache.

	function ensureEntityTable(def: EntityDef): void {
		// Table existence is the per-entity init latch (ADR-0064), so entity tables
		// are created on first ingest rather than at open. The DDL comes from the
		// registry `MIRROR_VERSION` describes, so a table can never be created in a
		// shape the filename does not promise. The index is applied here and
		// deliberately outside that promise: it holds no mirror facts, so adding one
		// must not force a re-pull.
		db.run(createTableSql(declareEntityTable(def)));
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_${def.table}_updated_at ON ${def.table}(updated_at);`,
		);
	}

	function upsertStmtFor(def: EntityDef) {
		const table = def.table;
		// Monotonic upsert: a row only ever moves forward. The DO UPDATE applies only
		// when the incoming object is at least as new as the stored one (by QB
		// LastUpdatedTime), so a stale write cannot regress the mirror, e.g.
		// recategorize folding its own response back after a concurrent sync already
		// ingested a newer bookkeeper edit. A missing timestamp on either side falls
		// back to last-writer-wins (nothing to order on). The extracted columns are
		// generated from `raw`, so the upsert writes only the blob and its bookkeeping.
		return db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET
			   raw = excluded.raw,
			   updated_at = excluded.updated_at,
			   synced_at = excluded.synced_at,
			   deleted = 0
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
	}

	function deleteStmtFor(def: EntityDef) {
		const table = def.table;
		// On conflict, only flip the flag + timestamps and keep the existing blob (a
		// CDC delete payload is just a stub); the generated columns keep projecting
		// that preserved blob, so the last-known scalars survive. Same monotonic guard
		// as the upsert: a stale delete cannot override a newer live update.
		return db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   deleted = 1,
			   synced_at = excluded.synced_at,
			   updated_at = excluded.updated_at
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
	}

	function tableExists(name: string): boolean {
		const row = db
			.query<{ n: number }, [string]>(
				`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
			)
			.get(name);
		return (row?.n ?? 0) > 0;
	}

	function readRealmState(): RealmState {
		return {
			cdcCursor: getMetaStmt.get('cdc_cursor')?.value ?? null,
			lastFullPullAt: getMetaStmt.get('last_full_pull_at')?.value ?? null,
			lastSyncedAt: getMetaStmt.get('last_synced_at')?.value ?? null,
		};
	}

	return {
		/** Escape hatch for ad-hoc queries (tests, diagnostics). */
		raw: db,

		/**
		 * The mirror's one write door: fold one or more entities' QB objects into
		 * their tables, optionally advancing the realm cursor, all in ONE
		 * transaction. Live objects upsert, `status: "Deleted"` objects soft-delete,
		 * both monotonically (a stale write never regresses a row).
		 *
		 * The incremental sync passes every entity's CDC changes plus the new
		 * `realmState` here, so applying the whole batch and advancing the single
		 * cursor commit together (whole-batch atomic; a crash rolls back to the prior
		 * cursor and the next run re-pulls the window, which is idempotent). A
		 * per-entity full pull and the recategorize write-back pass one entry and no
		 * `realmState` (the cursor advances at the end of the full pass instead). The
		 * transaction is IMMEDIATE so the write lock is taken up front and a
		 * concurrent writer waits (busy_timeout) rather than racing into a
		 * mid-transaction lock failure. Returns the partition counts per entity.
		 *
		 * `ensureEntityTable` runs for every entry, so the caller must not pass an
		 * entity that has not been full-pulled into a CDC batch: CDC carries only
		 * changes since the cursor, so a fresh table would silently miss history.
		 * The sync engine guards this by backfilling uninitialized entities first.
		 */
		ingest(
			entries: IngestEntry[],
			{ syncedAt, realmState }: { syncedAt: string; realmState?: RealmState },
		): IngestCounts {
			const prepared = entries.map(({ def, objects }) => {
				ensureEntityTable(def);
				const upserts: MirrorRow[] = [];
				const deletes: MirrorRow[] = [];
				for (const obj of objects) {
					const id = obj.Id != null ? String(obj.Id) : null;
					if (!id) continue; // skip malformed objects with no Id
					const row: MirrorRow = {
						id,
						raw: JSON.stringify(obj),
						updatedAt: lastUpdatedTime(obj),
					};
					(isDeleted(obj) ? deletes : upserts).push(row);
				}
				return {
					def,
					upsert: upsertStmtFor(def),
					markDeleted: deleteStmtFor(def),
					upserts,
					deletes,
				};
			});

			const counts: IngestCounts = {};
			for (const p of prepared) {
				counts[p.def.name] = {
					upserted: p.upserts.length,
					deleted: p.deletes.length,
				};
			}

			const tx = db.transaction(() => {
				for (const p of prepared) {
					for (const row of p.upserts) {
						p.upsert.run(row.id, row.raw, row.updatedAt, syncedAt);
					}
					for (const row of p.deletes) {
						p.markDeleted.run(row.id, row.raw, row.updatedAt, syncedAt);
					}
				}
				if (realmState) {
					setMetaStmt.run('cdc_cursor', realmState.cdcCursor);
					setMetaStmt.run('last_full_pull_at', realmState.lastFullPullAt);
					setMetaStmt.run('last_synced_at', realmState.lastSyncedAt);
				}
			});
			tx.immediate();

			return counts;
		},

		/**
		 * Read one live row's verbatim QB blob by id, or `null` if the entity table
		 * does not exist yet, the row is unknown, or it is soft-deleted. The read
		 * counterpart to `ingest`: callers reach a mirror row without hand-writing SQL
		 * against a table name. (`queryBooks` keeps its own read-only connection for
		 * arbitrary queries; this serves the write-capable handle the recategorize
		 * write-back already holds.)
		 */
		getLiveRaw(def: EntityDef, id: string): string | null {
			if (!tableExists(def.table)) return null;
			const row = db
				.query<{ raw: string }, [string]>(
					`SELECT raw FROM ${def.table} WHERE id = ? AND deleted = 0`,
				)
				.get(id);
			return row?.raw ?? null;
		},

		readRealmState,

		/**
		 * A page of an entity's rows, newest first, for the browse surface. Returns
		 * the id, the bookkeeping columns, and this entity's extracted scalar columns
		 * (not `raw`, which is heavy and only the detail view needs), plus the total
		 * row count so a caller can page. An entity with no table yet is empty, not an
		 * error. The column list is built from the registry def, so every name is a
		 * static identifier; SQLite sorts NULL `updated_at` last under DESC, so
		 * never-dated rows fall to the bottom.
		 */
		pageRows(
			def: EntityDef,
			{ limit, offset }: { limit: number; offset: number },
		): { rows: Record<string, unknown>[]; total: number } {
			const table = def.table;
			if (!tableExists(def.table)) return { rows: [], total: 0 };
			const total =
				db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
					?.n ?? 0;
			const cols = [
				'id',
				'updated_at',
				'synced_at',
				'deleted',
				...def.columns.map((c) => c.name),
			].join(', ');
			const rows = db
				.query(
					`SELECT ${cols} FROM ${table} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
				)
				.all(limit, offset) as Record<string, unknown>[];
			return { rows, total };
		},

		/**
		 * One row by id with its verbatim `raw` blob, for the detail view. Unlike
		 * `getLiveRaw`, this returns soft-deleted rows too (the mirror still holds the
		 * last-known blob), so the UI can show a removed record. `null` when the table
		 * or the row does not exist.
		 */
		getRow(def: EntityDef, id: string): Record<string, unknown> | null {
			if (!tableExists(def.table)) return null;
			const row = db.query(`SELECT * FROM ${def.table} WHERE id = ?`).get(id);
			return (row as Record<string, unknown>) ?? null;
		},

		/** Whether this entity has had its first full pull, i.e. its table exists. */
		isInitialized(def: EntityDef): boolean {
			return tableExists(def.table);
		},

		entityStatus(def: EntityDef): EntityStatus {
			const table = def.table;
			if (!tableExists(def.table)) {
				return {
					entity: def.name,
					rows: 0,
					deleted: 0,
					initialized: false,
				};
			}
			const rows = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
				.get();
			const deleted = db
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM ${table} WHERE deleted = 1`,
				)
				.get();
			return {
				entity: def.name,
				rows: rows?.n ?? 0,
				deleted: deleted?.n ?? 0,
				initialized: true,
			};
		},

		close(): void {
			db.close();
		},
	};
}
