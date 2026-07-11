/**
 * DISPOSABLE TYPE PROTOTYPE — greenfield workspace developer API, pass 3
 * (2026-07-11): schema epochs, distinct local/replica doors, and wire-honest
 * verbs. Types only; every function body is declared, nothing runs.
 *
 * This file exists to falsify the API shape with the compiler: `usage.ts`
 * next door must typecheck with usable inferred row types, and its
 * `@ts-expect-error` lines must actually error. Delete both files when the
 * production API lands.
 *
 * Decisions encoded here (evidence in REVIEW-2026-07-11.md pass 3):
 * - Opening is two doors, not one option: `openLocalWorkspace` (no actor,
 *   cursor, or outbox exist) and `openReplica` (a synchronized replica of the
 *   account database). Promotion is an explicit import into an open replica,
 *   never a reopen flag. `openWorkspace({ sync? })` is deleted: it hid a
 *   permanent durable-identity choice inside an optional field.
 * - Verbs are wire-honest: `put` (write every cell declared by this schema),
 *   `patch` (named cells of a live row), `remove` (terminal delete). They are
 *   the local images of `patchRow`-all-cells, `patchRow`-named-cells, and
 *   `deleteRow`. `create`/`update`/`upsert` die: exclusive creation is not a
 *   promise a distributed patchRow can keep, and the wire has no complete-row
 *   replacement operation, so neither verb told the truth.
 * - KV: get / set / clear. A KV schema must not admit `null` as a value —
 *   the wire encodes clear as `value: null`, so a nullable KV value would be
 *   indistinguishable from cleared. Model absence in the value or the default.
 * - Every write, single-verb or transact(), is exactly one atomic mutation:
 *   app-table changes + one outbox row + actor-sequence allocation in one
 *   local SQLite transaction (replica) or the app-table transaction alone
 *   (local workspace).
 * - Reads: get / list / has / count / observe per table, plus one SELECT-only
 *   `sql` escape hatch. Nonconforming accepted rows live in an internal
 *   quarantine table (provisional decision), so `sql` over application tables
 *   and `list` see ONE row population; `sql` stays an escape hatch because
 *   the query text is untyped, not because it reads a different dataset.
 * - Migrations: representation-only steps shape local SQLite eagerly at open.
 *   Every logical schema change mints a new exact schema EPOCH and carries the
 *   deterministic zero-or-one row/tombstone transform used at import time. A
 *   synchronized replica never migrates a shared database in place and never
 *   rewrites its outbox; a local-only workspace (single writer) applies the
 *   same transform eagerly in place.
 * - Epoch upgrade for a replica is the explicit `planEpochUpgrade` door,
 *   which produces the same reviewable import plan every database boundary
 *   uses.
 */

import type { Static, TSchema } from 'typebox';

// ─── field.* stand-ins ────────────────────────────────────────────────────────
// The real vocabulary lives in @epicenter/field; the prototype only needs the
// inference-relevant surface: a TSchema whose Static<> carries the value type.

export type FieldSchema<T> = TSchema & { static: T };

// ─── Table declaration ────────────────────────────────────────────────────────

export type Columns = Record<string, TSchema>;

export type RowOf<TCols extends Columns> = {
	[K in keyof TCols]: Static<TCols[K]>;
} & {};

/** Closed child-doc layouts. Normal app schemas never touch raw Yjs. */
export type DocLayout = 'plainText' | 'richText';

export type TableOptions<TCols extends Columns> = {
	/**
	 * Secondary indexes, derived to CREATE INDEX. Columns only; no UNIQUE:
	 * a unique constraint on a synchronized table would make the fold
	 * partial (two offline devices can both take the value and the server
	 * accepts both). Uniqueness beyond `id` is an application invariant
	 * enforced at the write API, never DDL.
	 */
	indexes?: readonly (keyof TCols & string)[][];
	/**
	 * Lazy collaborative bodies stored as separate Yjs documents. Identity is
	 * derived from (workspace id, table, row id, doc key) by the library.
	 */
	docs?: Record<string, DocLayout>;
};

export type TableDefinition<
	TCols extends Columns = Columns,
	TOpts extends TableOptions<TCols> = TableOptions<TCols>,
> = {
	columns: TCols;
	options: TOpts;
};

export declare function defineTable<
	const TCols extends Columns,
	const TOpts extends TableOptions<TCols> = Record<never, never>,
>(columns: TCols, options?: TOpts): TableDefinition<TCols, TOpts>;

// ─── KV declaration ───────────────────────────────────────────────────────────

/**
 * The schema must not admit `null` (runtime-rejected at definition time):
 * the wire encodes "cleared" as `value: null`, so a nullable KV value would
 * collide with clear. Absence semantics belong to the default factory.
 */
export type KvDefinition<S extends TSchema = TSchema> = {
	schema: S;
	defaultValue: () => Static<S>;
};

export declare function defineKv<S extends TSchema>(
	schema: S,
	defaultValue: () => Static<S>,
): KvDefinition<S>;

// ─── Migrations and schema epochs ─────────────────────────────────────────────

/**
 * Raw, schema-unaware handle passed to hand-authored representation migration
 * steps. Runs inside the one eager migration transaction at open. These steps
 * shape the local physical SQLite representation only; they never
 * change the logical schema epoch and never touch the outbox.
 */
export type MigrationTx = {
	sql(query: string, ...params: unknown[]): unknown[];
};

/** One logical row as the transform sees it: schema-blind cells. */
export type LogicalRowIn = {
	table: string;
	rowId: string;
	cells: Record<string, unknown>;
};

/**
 * A logical schema revision mints a new schema epoch. Runtime compatibility is
 * the digest of the complete canonical synchronized schema plus the ordered
 * authored semantic epoch lineage. Structural edits cannot accidentally retain
 * compatibility, and a meaning-only or transform edit forces a new identity by
 * minting a new authored component.
 *
 * The transform is deterministic and runs at IMPORT time against a frozen
 * canonical source snapshot frozen at server head H. Replica-private pending
 * intent is not part of the global baseline; after activation each replica
 * transforms its visible local state and imports the difference through the
 * ordinary planner. Pending outbox operations are never rewritten.
 *
 * One map owns identity for both rows and tombstones. It may use only source
 * (table, rowId), never mutable cells, and returns zero or one target identity.
 * One-to-many splits and many-to-one merges are refused in the first wave.
 */
export type EpochMigration = {
	/** Authored semantic id included in the NEW exact schema identity. */
	id: string;
	/**
	 * Map one source identity to zero or one target identity. Rows and tombstones
	 * both use this exact function; omission means identity.
	 */
	mapIdentity?(source: RowRef): RowRef | null;
	/** Transform cells after identity mapping; omission preserves all cells. */
	transformCells?(
		row: LogicalRowIn,
		target: RowRef,
	): Record<string, unknown>;
};

export type MigrationStep = {
	/** Hand-authored local representation shaping; logical schema is unchanged. */
	apply?: (tx: MigrationTx) => void;
	/** Required whenever the logical synchronized schema changes. */
	epoch?: EpochMigration;
};

// ─── Workspace declaration ────────────────────────────────────────────────────

export type TableDefinitions = Record<string, TableDefinition>;
export type KvDefinitions = Record<string, KvDefinition>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions = TableDefinitions,
	TKv extends KvDefinitions = KvDefinitions,
> = {
	id: string;
	name: string;
	/** Derived as 1 + migrations.length. */
	storageRevision: number;
	/** First authored component of the exact schema identity lineage. */
	epoch: string;
	tables: TTables;
	kv: TKv;
	migrations: readonly MigrationStep[];
};

export declare function defineWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions,
>(options: {
	id: string;
	name: string;
	/**
	 * First authored component of the schema epoch lineage. Runtime compatibility
	 * derives from the complete ordered lineage plus the canonical synchronized
	 * schema; every logical or transform change must append a new component.
	 */
	epoch: string;
	tables: TTables;
	kv?: TKv;
	/** Ordered steps to revisions 2, 3, ...; current revision is derived. */
	migrations?: readonly MigrationStep[];
}): WorkspaceDefinition<TTables, TKv>;

// ─── Read/write surfaces ──────────────────────────────────────────────────────

/**
 * Every table row carries a string-compatible `id`. The intersection keeps
 * branded id types intact (NoteId & string = NoteId) while satisfying the
 * `{ id: string }` bound the handles need.
 */
export type RowFor<TDef extends TableDefinition> = RowOf<TDef['columns']> & {
	id: string;
};

/** Read surface, available on the workspace and inside transactions. */
export type TableReads<TRow extends { id: string }> = {
	/** Point read; null when absent (absence is not an error). */
	get(id: TRow['id']): TRow | null;
	/** All conforming rows, optionally filtered/ordered via indexed columns. */
	list(options?: {
		where?: Partial<TRow>;
		orderBy?: keyof TRow & string;
		desc?: boolean;
		limit?: number;
	}): TRow[];
	has(id: TRow['id']): boolean;
	count(): number;
};

/**
 * Write surface. Each call outside transact() is its own atomic mutation.
 * The verbs are the local images of the two wire operations; none promises
 * more than patchRow/deleteRow can keep.
 */
export type TableWrites<TRow extends { id: string }> = {
	/**
	 * Write every cell declared by this exact schema. This is not replacement:
	 * the wire patches cells and has no row-replacement operation. There is no
	 * globally exclusive create in a distributed patchRow world; guard local
	 * double-submits with has() inside transact() when an app needs the check.
	 */
	put(row: TRow): void;
	/**
	 * Replace only the named cells of a live row. Local precondition: returns
	 * null when the row is absent or terminally deleted (the wire's
	 * create-on-unknown fold exists for import idempotency, not for the
	 * typed app surface).
	 */
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): TRow | null;
	/** Terminal delete: the id is permanently retired, never reused. */
	remove(id: TRow['id']): void;
};

export type TableHandle<TRow extends { id: string }> = TableReads<TRow> &
	TableWrites<TRow> & {
		/** Invalidation signal: fires with changed row ids after any commit
		 * (local write, remote pull, snapshot install, import apply alike). */
		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>) => void,
		): () => void;
	};

export type KvValue<TDef extends KvDefinition> = Static<TDef['schema']>;

export type KvHandle<TKv extends KvDefinitions> = {
	/** Declared default when unset or cleared. */
	get<K extends keyof TKv & string>(key: K): KvValue<TKv[K]>;
	set<K extends keyof TKv & string>(key: K, value: KvValue<TKv[K]>): void;
	/** Return to default. (Wire: value := null.) */
	clear(key: keyof TKv & string): void;
	observe(
		callback: (changedKeys: ReadonlySet<keyof TKv & string>) => void,
	): () => void;
};

// ─── Child documents ──────────────────────────────────────────────────────────

export type PlainTextHandle = {
	readonly kind: 'plainText';
	getText(): string;
	/** The underlying Y.Text for editor bindings. */
	yText: unknown;
	[Symbol.dispose](): void;
};

export type RichTextHandle = {
	readonly kind: 'richText';
	/** The underlying Y.XmlFragment for editor bindings. */
	yFragment: unknown;
	[Symbol.dispose](): void;
};

export type DocHandleFor<L extends DocLayout> = L extends 'plainText'
	? PlainTextHandle
	: RichTextHandle;

export type DocsFor<TDef extends TableDefinition> =
	TDef['options'] extends { docs: infer D extends Record<string, DocLayout> }
		? {
				[K in keyof D]: (
					rowId: RowFor<TDef>['id'],
				) => Promise<DocHandleFor<D[K]>>;
			}
		: Record<never, never>;

// ─── Transactions ─────────────────────────────────────────────────────────────

export type TxTables<TTables extends TableDefinitions> = {
	[K in keyof TTables]: TableReads<RowFor<TTables[K]>> &
		TableWrites<RowFor<TTables[K]>>;
};

export type Tx<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	tables: TxTables<TTables>;
	kv: Pick<KvHandle<TKv>, 'get' | 'set' | 'clear'>;
};

// ─── Boundary imports (one planner for every database boundary) ──────────────

export type RowRef = { table: string; rowId: string };

export type CellDiff = RowRef & {
	column: string;
	source: unknown;
	destination: unknown;
};

/** Child-document plan entry, gated by its row's fate in the plan. */
export type BodyPlanEntry = {
	ref: RowRef & { docKey: string };
	/**
	 * copy: destination doc absent. merge: shared Yjs history, update
	 * application is the automatic merge. review: unrelated histories —
	 * keep destination or merge histories (source-only replacement is
	 * refused until a document-reset contract exists).
	 */
	action: 'copy' | 'merge' | 'review';
};

/**
 * One reviewable plan for every explicit database boundary: local-to-account
 * promotion, restore, endpoint movement, physical-clone adoption, and epoch
 * upgrade. Unambiguous work applies without review; only genuine ambiguity
 * (both sides changed the same cell, or a source row the destination
 * terminally deleted) asks for a preference. Bodies ride the same plan as a
 * second row-gated lane: excluding a row suppresses its body.
 */
export type ImportPlan = {
	/** Source rows/cells absent from the destination: auto-applied. */
	additions: RowRef[];
	/** Identical on both sides: no-ops, counted for the summary. */
	identicalRows: number;
	/** Cells that differ: bulk preference applies; each is overridable. */
	conflicts: CellDiff[];
	/**
	 * Source rows the destination terminally deleted. The delete wins in the
	 * generic V1 planner. Restoring under a new id is an app-owned copy flow
	 * because generic field metadata cannot safely remap inbound references.
	 */
	deletedInDestination: RowRef[];
	/** Source tombstones carried into the destination as deleteRow. */
	tombstoneImports: RowRef[];
	/** Child documents, gated by their rows' fates. */
	bodies: BodyPlanEntry[];
	/**
	 * Non-empty blocks apply(): e.g. a transform mapped two source rows to
	 * one target id (injectivity preflight).
	 */
	errors: { ref: RowRef; reason: string }[];
	/**
	 * Applies as ordinary mutations. Revalidates the destination head first:
	 * cells that changed since planning are re-diffed, never silently
	 * overwritten. The source stays intact until the result is accepted.
	 */
	apply(choices?: {
		prefer?: 'source' | 'destination';
		overrides?: { diff: CellDiff; take: 'source' | 'destination' }[];
		excludeRows?: RowRef[];
	}): Promise<void>;
};

/**
 * Anything that can act as a logical snapshot source. Both workspace kinds
 * qualify through their export capability; the planner needs no more.
 */
export type WorkspaceSource = {
	exportSnapshot(): Promise<Uint8Array>;
};

/**
 * A logical snapshot source. The source stays intact and read-only until the
 * destination has durably accepted the applied plan.
 */
export type LogicalSource =
	| { kind: 'file'; path: string }
	| { kind: 'export'; bytes: Uint8Array }
	| { kind: 'workspace'; workspace: WorkspaceSource };

// ─── Workspace handles ────────────────────────────────────────────────────────

export type WorkspaceData<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	tables: { [K in keyof TTables]: TableHandle<RowFor<TTables[K]>> };
	kv: KvHandle<TKv>;
	docs: { [K in keyof TTables]: DocsFor<TTables[K]> };

	/**
	 * The one write boundary: everything inside commits as ONE atomic
	 * mutation (single-verb table/kv calls are one-op instances of this).
	 */
	transact(fn: (tx: Tx<TTables, TKv>) => void): void;

	/**
	 * SELECT-only escape hatch over the local replica. Rejects non-read
	 * statements at prepare time; `schema` validates and types each result
	 * row. Application tables hold only conforming rows (nonconforming
	 * accepted rows are quarantined internally), so this and list() see one
	 * row population. It remains fallible: the query text itself is untyped
	 * and unvalidated against the schema.
	 */
	sql<S extends TSchema>(
		query: string,
		params: readonly unknown[],
		schema: S,
	): Static<S>[];
	/** Conservative invalidation: re-run when any named table changes. */
	observeSql(
		tables: readonly (keyof TTables & string)[],
		run: () => void,
	): () => void;

	/** Reviewable logical import from another compatible database. */
	planImport(source: LogicalSource): Promise<ImportPlan>;

	/** Logical export: stable row ids and content; never replica identity. */
	exportSnapshot(): Promise<Uint8Array>;

	[Symbol.asyncDispose](): Promise<void>;
};

/** A database that never synchronizes: no actor, cursor, or outbox exist. */
export type LocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = WorkspaceData<TTables, TKv> & {
	readonly kind: 'local';
};

/** One synchronized replica of the account database for this epoch. */
export type Replica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = WorkspaceData<TTables, TKv> & {
	readonly kind: 'replica';
};

export type StorageAdapter = { readonly kind: 'opfs' | 'bun' | 'memory' };
export type SyncConnection = { readonly baseUrl: string };

/**
 * Open a database that will never synchronize. No actor identity, cursor, or
 * outbox exist. A breaking revision in the definition transforms the local
 * database eagerly in place — safe because a local workspace has exactly one
 * writer, which is the concurrency the shared-database epoch flow exists to
 * avoid.
 */
export declare function openLocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: { storage: StorageAdapter },
): Promise<LocalWorkspace<TTables, TKv>>;

/**
 * Open (or bootstrap) this device's replica of the account database in the
 * definition's CURRENT schema epoch. Rejects with a typed error when the
 * local store belongs to a superseded epoch (route through planEpochUpgrade)
 * or to a different database incarnation (route through planImport as a new
 * replica). Never silently reuses a cursor or outbox across either boundary.
 *
 * Promoting a previously local database is: openReplica, then
 * planImport({ kind: 'workspace', workspace: local }), then retire the local
 * copy after the imported mutations are accepted. There is no reopen flag.
 */
export declare function openReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: { storage: StorageAdapter; sync: SyncConnection },
): Promise<Replica<TTables, TKv>>;

/**
 * Explicit epoch-upgrade door for a replica whose local data lives in a
 * superseded epoch. The server-owned transition freezes the old canonical head
 * H, builds a leased PREPARING incarnation from that canonical snapshot, and
 * activates it only after the baseline is sealed. The caller's private pending
 * overlay never enters the global baseline. After activation this function
 * composes the definition's epoch transforms over the caller's visible local
 * state and returns the ordinary boundary-import plan for its private
 * difference. The old replica stays readable and exportable until acceptance;
 * its outbox is never rewritten.
 */
export declare function planEpochUpgrade<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: { storage: StorageAdapter; sync: SyncConnection },
): Promise<ImportPlan>;
