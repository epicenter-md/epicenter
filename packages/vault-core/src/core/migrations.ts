/**
 * Environment-agnostic migration primitives for vault-core.
 *
 * This module intentionally performs no IO and imports no node: modules.
 * Hosts must provide any filesystem/database access and drizzle-kit integration.
 *
 * Design:
 * - Core accepts already-parsed data structures (journals, step metadata) and
 *   provides pure planning helpers and progress event types.
 * - Execution is performed by host-injected strategies; core only defines shapes.
 */

import type { InferInsertModel } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DrizzleDb } from './db';

/** Drizzle migration journal entry (parsed from meta/_journal.json by the host). */
export type JournalEntry = {
	/** Drizzle migration tag, usually the filename without extension (e.g., 0001_add_posts) */
	tag: string;
	/** ISO timestamp or number; shape depends on drizzle-kit version */
	when?: unknown;
	/** Optional checksum/hash; presence depends on drizzle version */
	hash?: string;
};

/** Parsed Drizzle journal object (host-provided; core does not read files). */
export type MigrationJournal = {
	entries: JournalEntry[];
};

/**
 * A pure planning result representing the ordered set of tags needed to move
 * from the current tag (if any) to the target tag. Core does not include SQL
 * statements here; hosts generate SQL via drizzle-kit as needed.
 */
export type MigrationPlan = {
	/** Current DB version tag (if known). */
	from?: string;
	/** Target version tag (must exist in the journal). */
	to: string;
	/** Ordered list of tags to apply to reach the target. */
	tags: string[];
};

/**
 * Compute a forward-only plan from current -> target using journal ordering.
 * Pure function: no IO, no environment assumptions.
 */
export function planToVersion(
	journal: MigrationJournal,
	currentTag: string | undefined,
	targetTag: string,
): MigrationPlan {
	const order = new Map(journal.entries.map((e, i) => [e.tag, i] as const));

	const targetIdx = order.get(targetTag);
	if (targetIdx == null) {
		throw new Error(`Target migration tag not found in journal: ${targetTag}`);
	}

	const currentIdx = currentTag != null ? (order.get(currentTag) ?? -1) : -1;

	if (currentIdx > targetIdx) {
		// Downgrade paths are not supported by this planner; hosts can implement if needed.
		throw new Error(
			`Current tag (${currentTag}) is ahead of target tag (${targetTag}); downgrades are not supported in core planner.`,
		);
	}

	const forward = journal.entries
		.slice(currentIdx + 1, targetIdx + 1)
		.map((e) => e.tag);

	return { from: currentTag, to: targetTag, tags: forward };
}

/**
 * Progress event and reporter types for host-executed migrations.
 * These are emitted by host executors while running the planned steps/tags.
 */
export type ProgressEvent =
	| {
			type: 'start';
			totalSteps: number;
	  }
	| {
			type: 'step';
			index: number; // 0-based index in the overall plan
			tag: string; // current tag being applied
			progress?: number; // optional 0..1
			message?: string;
	  }
	| {
			type: 'complete';
	  }
	| {
			type: 'error';
			error: unknown;
	  };

/** Reporter callbacks; hosts pass an implementation to their executor. */
export type ProgressReporter = {
	onStart(event: Extract<ProgressEvent, { type: 'start' }>): void;
	onStep(event: Extract<ProgressEvent, { type: 'step' }>): void;
	onComplete(event: Extract<ProgressEvent, { type: 'complete' }>): void;
	onError(event: Extract<ProgressEvent, { type: 'error' }>): void;
};

/**
 * Host integration points (shapes only; no implementation in core):
 *
 * - MigrationPlanner: optional advanced planner that can consider multiple adapter
 *   version tuples, curated steps, or drizzle-kit diffs to assemble a cross-plugin plan.
 *   This is left opaque.
 *
 * - MigrationExecutor: applies a plan to the injected database and emits ProgressReporter events.
 *   Core does not require a specific DB type here to remain environment-agnostic.
 */
export type MigrationPlanner = (...args: unknown[]) => MigrationPlan;

export type MigrationExecutor = (
	plan: MigrationPlan,
	report: ProgressReporter,
) => Promise<boolean>;

// ==============================
// Plan B: Inline migration (SQLite/libsql) execution helpers
// Design: keep core environment-agnostic; host supplies Drizzle internals via 'engine'.
// We skip validators on purpose and rely on 'squash' + differ to derive SQL.
// The implementation is commented out below but retained for potential future use.
// ==============================

// /** Supported sqlite-like dialects for inline diffing. */
// export type SqliteLikeDialect = 'sqlite' | 'libsql';

// /** Optional migration mode forwarded to differ; 'push' mirrors drizzle example semantics. */
// export type MigrationMode = 'migrate' | 'push';

// /** Resolver input/output shapes kept generic yet typed; avoid any. */
// export type TableResolverInput = {
// 	created?: unknown[];
// 	deleted?: unknown[];
// 	[k: string]: unknown;
// };
// export type TableResolverOutput = {
// 	created: unknown[];
// 	deleted: unknown[];
// 	moved: unknown[];
// 	renamed: unknown[];
// };

// export type ColumnResolverInput = {
// 	tableName?: unknown;
// 	schema?: unknown;
// 	created?: unknown[];
// 	deleted?: unknown[];
// 	[k: string]: unknown;
// };
// export type ColumnResolverOutput = {
// 	tableName?: unknown;
// 	schema?: unknown;
// 	created: unknown[];
// 	deleted: unknown[];
// 	renamed: unknown[];
// };

// export type ViewResolverInput = {
// 	created?: unknown[];
// 	deleted?: unknown[];
// 	[k: string]: unknown;
// };
// export type ViewResolverOutput = {
// 	created: unknown[];
// 	deleted: unknown[];
// 	moved: unknown[];
// 	renamed: unknown[];
// };

// /** A minimal set of resolvers used by sqlite/libsql snapshot diff functions. */
// export type SqliteResolvers = {
// 	tablesResolver: (
// 		input: TableResolverInput,
// 	) => Promise<TableResolverOutput> | TableResolverOutput;
// 	columnsResolver: (
// 		input: ColumnResolverInput,
// 	) => Promise<ColumnResolverOutput> | ColumnResolverOutput;
// 	viewsResolver: (
// 		input: ViewResolverInput,
// 	) => Promise<ViewResolverOutput> | ViewResolverOutput;
// 	/** Optional schemas resolver; not required by sqlite/libsql differ in current examples. */
// 	schemasResolver?: (
// 		input: TableResolverInput,
// 	) => Promise<TableResolverOutput> | TableResolverOutput;
// };

// /** Default, non-interactive resolvers: create-only for new, drop-only for deleted, no renames/moves. */
// export const defaultSqliteResolvers: SqliteResolvers = {
// 	tablesResolver(input: TableResolverInput) {
// Expect shape { created: T[], deleted: T[] }
// 		return {
// 			created: Array.isArray(input.created) ? input.created : [],
// 			deleted: Array.isArray(input.deleted) ? input.deleted : [],
// 			moved: [],
// 			renamed: [],
// 		};
// 	},
// 	columnsResolver(input: ColumnResolverInput) {
// Expect shape { tableName, created: T[], deleted: T[] }
// 		return {
// 			tableName: input.tableName,
// 			schema: input.schema,
// 			created: Array.isArray(input.created) ? input.created : [],
// 			deleted: Array.isArray(input.deleted) ? input.deleted : [],
// 			renamed: [],
// 		};
// 	},
// 	viewsResolver(input: ViewResolverInput) {
// Expect shape { created: T[], deleted: T[] }
// 		return {
// 			created: Array.isArray(input.created) ? input.created : [],
// 			deleted: Array.isArray(input.deleted) ? input.deleted : [],
// 			moved: [],
// 			renamed: [],
// 		};
// 	},
// };

// /** Result contract returned by drizzle snapshot differs that we use. */
// export type SqlDiffResult = {
// 	sqlStatements: string[];
// drizzle may also include auxiliary outputs, we keep them if present
// 	statements?: unknown;
// 	_meta?: unknown;
// };

// /** Function signature of sqlite snapshot differ (applySqliteSnapshotsDiff). */
// export type ApplySqliteSnapshotsDiff = (
// 	squashedPrev: unknown,
// 	squashedCur: unknown,
// 	tablesResolver: (
// 		input: TableResolverInput,
// 	) => Promise<TableResolverOutput> | TableResolverOutput,
// 	columnsResolver: (
// 		input: ColumnResolverInput,
// 	) => Promise<ColumnResolverOutput> | ColumnResolverOutput,
// 	viewsResolver: (
// 		input: ViewResolverInput,
// 	) => Promise<ViewResolverOutput> | ViewResolverOutput,
// 	validatedPrev: unknown,
// 	validatedCur: unknown,
// 	mode?: 'push',
// ) => Promise<SqlDiffResult> | SqlDiffResult;

// /** Function signature of libsql snapshot differ (applyLibSQLSnapshotsDiff). */
// export type ApplyLibSQLSnapshotsDiff = ApplySqliteSnapshotsDiff;

// /** Function signature of sqlite squasher (squashSqliteScheme). */
// export type SquashSqliteScheme = (snapshot: unknown, mode?: 'push') => unknown;

// /** Drizzle-engine functions needed to run sqlite/libsql diffs. Host provides these concretions. */
// export type SqliteEngine = {
// 	squashSqliteScheme: SquashSqliteScheme;
// 	applySqliteSnapshotsDiff?: ApplySqliteSnapshotsDiff;
// 	applyLibSQLSnapshotsDiff?: ApplyLibSQLSnapshotsDiff;
// };

// /** Options for SQL generation helpers. */
// export type GenerateSqlOptions = {
// 	mode?: MigrationMode;
// 	resolvers?: Partial<SqliteResolvers>;
// 	engine: SqliteEngine;
// };

// /** Merge user resolvers over defaults (shallow). */
// function mergeResolvers(
// 	base: SqliteResolvers,
// 	partial?: Partial<SqliteResolvers>,
// ): SqliteResolvers {
// 	if (!partial) return base;
// 	return {
// 		tablesResolver: partial.tablesResolver ?? base.tablesResolver,
// 		columnsResolver: partial.columnsResolver ?? base.columnsResolver,
// 		viewsResolver: partial.viewsResolver ?? base.viewsResolver,
// 		schemasResolver: partial.schemasResolver ?? base.schemasResolver,
// 	};
// }

// /**
//  * Pure SQL generator for SQLite using provided drizzle-engine internals.
//  * prev/cur are raw snapshots; we skip validators and only squash.
//  */
// export async function generateSqlForSqlite(
// 	prev: unknown,
// 	cur: unknown,
// 	opts: GenerateSqlOptions,
// ): Promise<string[]> {
// 	const { engine } = opts;
// 	if (!engine.squashSqliteScheme || !engine.applySqliteSnapshotsDiff) {
// 		throw new Error(
// 			'SQLite differ not available: ensure engine.squashSqliteScheme and engine.applySqliteSnapshotsDiff are provided',
// 		);
// 	}
// 	const modePush = opts.mode === 'push' ? 'push' : undefined;
// 	const resolvers = mergeResolvers(defaultSqliteResolvers, opts.resolvers);

// 	const squashedPrev = engine.squashSqliteScheme(prev, modePush);
// 	const squashedCur = engine.squashSqliteScheme(cur, modePush);

// 	const { sqlStatements } = await engine.applySqliteSnapshotsDiff(
// 		squashedPrev,
// 		squashedCur,
// 		resolvers.tablesResolver,
// 		resolvers.columnsResolver,
// 		resolvers.viewsResolver,
// We pass raw snapshots through as "validated" to avoid pulling validators
// 		prev,
// 		cur,
// 		modePush,
// 	);

// 	return sqlStatements ?? [];
// }

// /**
//  * Pure SQL generator for libSQL using provided drizzle-engine internals.
//  * prev/cur are raw snapshots; we skip validators and only squash.
//  */
// export async function generateSqlForLibsql(
// 	prev: unknown,
// 	cur: unknown,
// 	opts: GenerateSqlOptions,
// ): Promise<string[]> {
// 	const { engine } = opts;
// 	if (!engine.squashSqliteScheme || !engine.applyLibSQLSnapshotsDiff) {
// 		throw new Error(
// 			'libSQL differ not available: ensure engine.squashSqliteScheme and engine.applyLibSQLSnapshotsDiff are provided',
// 		);
// 	}
// 	const modePush = opts.mode === 'push' ? 'push' : undefined;
// 	const resolvers = mergeResolvers(defaultSqliteResolvers, opts.resolvers);

// 	const squashedPrev = engine.squashSqliteScheme(prev, modePush);
// 	const squashedCur = engine.squashSqliteScheme(cur, modePush);

// 	const { sqlStatements } = await engine.applyLibSQLSnapshotsDiff(
// 		squashedPrev,
// 		squashedCur,
// 		resolvers.tablesResolver,
// 		resolvers.columnsResolver,
// 		resolvers.viewsResolver,
// We pass raw snapshots through as "validated" to avoid pulling validators
// 		prev,
// 		cur,
// 		modePush,
// 	);

// 	return sqlStatements ?? [];
// }

// /** Execution helper: sequentially run statements using provided executor. */
// export async function executeSqlStatements(
// 	statements: string[],
// 	execute: (sql: string) => Promise<void>,
// ): Promise<void> {
// 	for (const sql of statements) {
// Execute in order; SQLite DDL may auto-commit, so we avoid wrapping in a single tx here.
// 		await execute(sql);
// 	}
// }

// /** Snapshot provider per tag used by the orchestrator. */
// export type SnapshotProvider = (
// 	tag: string,
// ) => { prev: unknown; cur: unknown } | Promise<{ prev: unknown; cur: unknown }>;

// /** Orchestrator options for running a plan end-to-end. */
// export type RunInlineOptions = {
// 	dialect: SqliteLikeDialect;
// 	mode?: MigrationMode;
// 	engine: SqliteEngine;
// 	validate?: boolean; // reserved for future; unused because validators are skipped by design
// 	/** If true and 'execute' provided, statements are applied; otherwise dry-run returns statements only. */
// 	apply?: boolean;
// 	/** Execution callback for applying SQL; required when apply is true. */
// 	execute?: (sql: string) => Promise<void>;
// 	/** Optional progress reporter from this module. */
// 	reporter?: ProgressReporter;
// };

// /** Orchestrate plan execution: generate per-tag SQL and optionally apply via execute callback. */
// export async function runPlannedMigrationsInline(
// 	plan: MigrationPlan,
// 	getSnapshotsByTag: SnapshotProvider,
// 	options: RunInlineOptions,
// ): Promise<{ byTag: Record<string, string[]> }> {
// 	const { dialect, mode, engine, apply, execute, reporter } = options;

// 	if (apply && !execute) {
// 		throw new Error('apply is true but no execute callback was provided');
// 	}

// 	reporter?.onStart({ type: 'start', totalSteps: plan.tags.length });

// 	const byTag: Record<string, string[]> = {};
// 	for (let i = 0; i < plan.tags.length; i++) {
// 		const tag = plan.tags[i];

// 		try {
// 			const pair = await getSnapshotsByTag(tag);
// 			const prev = pair.prev;
// 			const cur = pair.cur;

// 			let statements: string[];
// 			if (dialect === 'sqlite') {
// 				statements = await generateSqlForSqlite(prev, cur, { mode, engine });
// 			} else if (dialect === 'libsql') {
// 				statements = await generateSqlForLibsql(prev, cur, { mode, engine });
// 			} else {
// 				throw new Error(
// 					`Unsupported dialect for inline migrations: ${dialect}`,
// 				);
// 			}

// 			byTag[tag] = statements;

// 			if (apply && execute && statements.length > 0) {
// 				for (const [idx, sql] of statements.entries()) {
// 					reporter?.onStep({
// 						type: 'step',
// 						index: i,
// 						tag,
// 						progress: statements.length > 0 ? (idx + 1) / statements.length : 1,
// 						message: `Applying statement ${idx + 1} of ${statements.length}`,
// 					});
// 					await execute(sql);
// 				}
// 			} else {
// 				reporter?.onStep({
// 					type: 'step',
// 					index: i,
// 					tag,
// 					progress: 1,
// 					message: `Generated ${statements.length} statements (dry run)`,
// 				});
// 			}
// 		} catch (error) {
// 			reporter?.onError({ type: 'error', error });
// 			throw error;
// 		}
// 	}

// 	reporter?.onComplete({ type: 'complete' });

// 	return { byTag };
// }

// ==============================
// Plan A: adapter versions, vault-managed ledger, startup SQL, and data transform chain
// ==============================

/** Vault-managed migration tables: SQL schema strings hosts can execute. */
export const VAULT_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS vault_migrations (
  adapter_id TEXT PRIMARY KEY,
  current_tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const VAULT_MIGRATION_JOURNAL_SQL = `
CREATE TABLE IF NOT EXISTS vault_migration_journal (
  adapter_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, tag)
);
`;

const VAULT_MIGRATIONS_TABLE = 'vault_migrations';
const VAULT_MIGRATION_JOURNAL_TABLE = 'vault_migration_journal';

export async function ensureVaultLedgerTables(db: DrizzleDb): Promise<void> {
	await db.run(sql.raw(VAULT_MIGRATIONS_SQL));
	await db.run(sql.raw(VAULT_MIGRATION_JOURNAL_SQL));
}

export async function getVaultLedgerTag(
	db: DrizzleDb,
	adapterId: string,
): Promise<string | undefined> {
	await ensureVaultLedgerTables(db);
	const row = await db.get<{ current_tag: string | null }>(
		sql`SELECT current_tag FROM ${sql.raw(VAULT_MIGRATIONS_TABLE)} WHERE adapter_id = ${adapterId}`,
	);
	return row?.current_tag ?? undefined;
}

async function setVaultLedgerTag(
	db: DrizzleDb,
	adapterId: string,
	tag: string,
): Promise<void> {
	await ensureVaultLedgerTables(db);
	const timestamp = Date.now();
	await db.run(
		sql`INSERT INTO ${sql.raw(VAULT_MIGRATIONS_TABLE)} (adapter_id, current_tag, updated_at)
VALUES (${adapterId}, ${tag}, ${timestamp})
ON CONFLICT(adapter_id) DO UPDATE SET current_tag = excluded.current_tag, updated_at = excluded.updated_at`,
	);
}

async function appendVaultLedgerJournal(
	db: DrizzleDb,
	adapterId: string,
	tag: string,
): Promise<void> {
	await ensureVaultLedgerTables(db);
	const timestamp = Date.now();
	await db.run(
		sql`INSERT INTO ${sql.raw(VAULT_MIGRATION_JOURNAL_TABLE)} (adapter_id, tag, applied_at)
VALUES (${adapterId}, ${tag}, ${timestamp})
ON CONFLICT(adapter_id, tag) DO NOTHING`,
	);
}

/** Build a pseudo-journal from a versions tuple to reuse planToVersion. */
export function buildJournalFromVersions<
	TVersions extends readonly VersionDef<Tag4>[],
>(versions: TVersions): MigrationJournal {
	return {
		entries: versions.map((v) => ({ tag: v.tag })),
	};
}

/** Split a monolithic SQL string into executable statements. */
function splitSqlText(text: string): string[] {
	// Prefer explicit drizzle 'statement-breakpoint' markers if present
	if (text.includes('--> statement-breakpoint')) {
		return text
			.split(/-->\s*statement-breakpoint\s*/g)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	// Fallback: split on semicolons at end of statements
	return text
		.split(/;\s*(?:\r?\n|$)/g)
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => (s.endsWith(';') ? s : `${s};`));
}

/**
 * Startup SQL migration runner for a single adapter.
 * Forward-only: computes steps from the ledger's current tag to the latest version.
 */
export async function runStartupSqlMigrations<
	TId extends string,
	TVersions extends readonly VersionDef<Tag4>[],
>(
	adapterId: TId,
	versions: TVersions,
	db: DrizzleDb,
	reporter?: ProgressReporter,
): Promise<{ applied: string[] }> {
	if (!versions || versions.length === 0) {
		return { applied: [] };
	}

	await ensureVaultLedgerTables(db);

	const target = getLatestTag(versions);
	const current = await getVaultLedgerTag(db, adapterId);
	const plan = planToVersion(
		buildJournalFromVersions(versions),
		current,
		target,
	);

	reporter?.onStart({ type: 'start', totalSteps: plan.tags.length });

	const applied: string[] = [];

	for (let i = 0; i < plan.tags.length; i++) {
		const tag = plan.tags[i];
		const ve = versions.find((v) => v.tag === tag);
		if (!ve) {
			const error = new Error(`Version entry not found for tag ${tag}`);
			reporter?.onError({ type: 'error', error });
			throw error;
		}

		const statements = ve.sql.flatMap((chunk) => splitSqlText(chunk));

		if (statements.length === 0) {
			reporter?.onStep({
				type: 'step',
				index: i,
				tag,
				progress: 1,
				message: 'No SQL statements for this version',
			});
		} else {
			for (const [idx, statement] of statements.entries()) {
				reporter?.onStep({
					type: 'step',
					index: i,
					tag,
					progress: (idx + 1) / statements.length,
					message: `Applying statement ${idx + 1} of ${statements.length}`,
				});
				await db.run(sql.raw(statement));
			}
		}

		await appendVaultLedgerJournal(db, adapterId, tag);
		await setVaultLedgerTag(db, adapterId, tag);
		applied.push(tag);
	}

	reporter?.onComplete({ type: 'complete' });

	return { applied };
}

/** Additional metadata supplied to individual transform functions for better DX. */
export type DataTransformContext = {
	/** Target tag that the transform will produce. */
	toTag: Tag4;
	/** Source tag feeding into this transform (previous tag or dataset tag). */
	fromTag?: string;
	/** Optional initial source tag provided by the caller. */
	sourceTag?: string;
	/** Final tag the chain is targeting. */
	targetTag: Tag4;
	/** Zero-based index of this step in the plan. */
	index: number;
	/** Total number of steps in the current transform plan. */
	total: number;
	/** Whether this step is the final transform in the chain. */
	isLast: boolean;
	/** Ordered list of target tags that will be applied (excludes the baseline). */
	plan: readonly Tag4[];
	/** Full adapter versions tuple for additional context. */
	versions: readonly VersionDef<Tag4>[];
};

/** A data transform converts JSON shaped as version A to JSON shaped as version B (adapter-specific). */
export type DataTransform = (
	input: unknown,
	context: DataTransformContext,
) => unknown | Promise<unknown>;

/**
 * Registry of per-version transforms:
 * Map of toTag => transform that expects input of previous tag and produces output of toTag.
 * Example: { '0001': t_0000_to_0001, '0002': t_0001_to_0002 }
 */
export type TransformRegistry<TTag extends Tag4 = Tag4> = Record<
	TTag,
	DataTransform
>;

/** Convenience alias for versions tuples to derive required transform keys. */
export type TransformRegistryForVersions<
	TVersions extends readonly VersionDef<Tag4>[],
> = TransformRegistry<RequiredTransformTags<TVersions>>;

/** Determine the forward tag list using the versions tuple, from sourceTag (exclusive) to targetTag (inclusive). */
export function computeForwardTagsFromVersions<
	TVersions extends readonly VersionDef<Tag4>[],
>(
	versions: TVersions,
	sourceTag: string | undefined,
	targetTag: string,
): string[] {
	const j = buildJournalFromVersions(versions);
	return planToVersion(j, sourceTag, targetTag).tags;
}

/**
 * Run the data transform chain from sourceTag -> latest version.
 * The registry must contain a transform for each target tag in the forward plan.
 */
export async function runDataTransformChain<
	TID extends string,
	TVersions extends readonly VersionDef<Tag4>[],
	TSchema extends Record<string, SQLiteTable>,
>(
	versions: TVersions,
	registry: TransformRegistryForVersions<TVersions>,
	input: {
		[Key in keyof TSchema]: InferInsertModel<TSchema[Key]>[];
	},
	// If undefined, starts from the baseline (first version in the tuple)
	sourceTag: string | undefined,
	targetTag?: string,
	reporter?: ProgressReporter,
): Promise<unknown> {
	const plannedTarget = (targetTag ?? getLatestTag(versions)) as Tag4;
	const tags = computeForwardTagsFromVersions(
		versions,
		sourceTag,
		plannedTarget,
	);
	const plannedTags = tags.map((tag) => tag as Tag4);
	const previousTagByTarget = new Map<Tag4, string | undefined>();
	for (let i = 0; i < versions.length; i++) {
		const currentTag = versions[i]?.tag as Tag4;
		const prev = versions[i - 1]?.tag;
		previousTagByTarget.set(currentTag, prev);
	}

	reporter?.onStart({ type: 'start', totalSteps: tags.length });

	let acc: unknown = input;
	type RequiredTags = RequiredTransformTags<TVersions>;
	for (let i = 0; i < plannedTags.length; i++) {
		const toTag = plannedTags[i];
		const fn = registry[toTag as RequiredTags];
		if (!fn) {
			const err = new Error(`Missing transform for target tag ${toTag}`);
			reporter?.onError({ type: 'error', error: err });
			throw err;
		}
		const fromTag =
			i === 0
				? (sourceTag ?? previousTagByTarget.get(toTag))
				: plannedTags[i - 1];
		acc = await fn(acc, {
			toTag,
			fromTag,
			sourceTag,
			targetTag: plannedTarget,
			index: i,
			total: plannedTags.length,
			isLast: i === plannedTags.length - 1,
			plan: plannedTags,
			versions,
		});
		reporter?.onStep({
			type: 'step',
			index: i,
			tag: toTag,
			progress: 1,
			message: `Transformed to ${toTag}`,
		});
	}

	reporter?.onComplete({ type: 'complete' });
	return acc;
}

function getLatestTag<TVersions extends readonly VersionDef<Tag4>[]>(
	versions: TVersions,
): TVersions[number]['tag'] {
	return versions
		.map((v) => [v.tag, Number.parseInt(v.tag, 10)] as const)
		.sort((a, b) => a[1] - b[1])[0][0];
}

// ==============================
// Version tuple type-safety helpers (authoring-time)
// ==============================

/** Single decimal digit literal. */
export type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** Four-digit tag, e.g. '0000', '0001'. */
export type Tag4 = `${Digit}${Digit}${Digit}${Digit}`;

/** Version definition for adapter-managed migrations (stricter than runtime). */
export type VersionDef<TTag extends Tag4> = {
	/** Four-digit version tag (e.g., '0001'). Must be unique within the tuple. */
	tag: TTag;
	/** Inline array of statements (preferred for environment-agnostic bundles) */
	sql: string[];
};

/** Tuple utilities */
type LastOfTuple<T extends readonly unknown[]> = T extends readonly [
	...infer _,
	infer L,
]
	? L
	: never;

type FirstOfTuple<T extends readonly unknown[]> = T extends readonly [
	infer F,
	...unknown[],
]
	? F
	: never;

/** Extract the union of tags from a version tuple. */
export type VersionTags<TVersions extends readonly VersionDef<Tag4>[]> =
	TVersions[number]['tag'];

/** First tag from versions tuple. */
export type FirstTag<TVersions extends readonly VersionDef<Tag4>[]> =
	FirstOfTuple<TVersions> extends VersionDef<Tag4>
		? FirstOfTuple<TVersions>['tag']
		: never;

/** Tag tuple derived from a VersionDef tuple. */
export type VersionTagTuple<TVersions extends readonly VersionDef<Tag4>[]> = {
	[K in keyof TVersions]: TVersions[K] extends VersionDef<
		infer TTag extends Tag4
	>
		? TTag
		: never;
};

/** Tuple of required forward transform tags (all tags except the first/baseline). */
export type RequiredTransformTagTuple<
	TVersions extends readonly VersionDef<Tag4>[],
> = TVersions extends readonly [VersionDef<Tag4>, ...infer Rest]
	? Rest extends readonly VersionDef<Tag4>[]
		? {
				[K in keyof Rest]: Rest[K] extends VersionDef<infer Tag extends Tag4>
					? Tag
					: never;
			}
		: []
	: [];

/**
 * Compute the tags that require data transforms:
 * all version tags except the first (baseline).
 */
export type RequiredTransformTags<
	TVersions extends readonly VersionDef<Tag4>[],
> = RequiredTransformTagTuple<TVersions>[number];

/**
 * Authoring-time transform registry keyed by the required transform tags.
 * Example:
 *   const transforms: TransformRegistryForVersions<typeof versions> =
 *     { '0001': fn, '0002': fn };
 */

/**
 * Helper to define a transform registry with compile-time keys.
 * Provide the union of tags you must cover:
 *   const transforms = defineTransformRegistry({ '0001': fn, '0002': fn });
 *
 * Each transform receives a {@link DataTransformContext} describing the plan,
 * which enables richer DX (branching, instrumentation, etc.).
 */
export function defineTransformRegistry<
	TRegistry extends Partial<Record<Tag4, DataTransform>>,
>(registry: TRegistry): TRegistry {
	return registry;
}

/** Validate transformed data using an injected validator (e.g., drizzle-arktype). Returns morphed value. */
export type DataValidator = (value: unknown) => unknown | Promise<unknown>;

/** Run chain then validate; returns morphed/validated data if no exception is thrown. */
export async function transformAndValidate<
	TID extends string,
	TVersions extends readonly VersionDef<Tag4>[],
	TSchema extends Record<string, SQLiteTable>,
>(
	versions: TVersions,
	registry: TransformRegistryForVersions<TVersions>,
	input: {
		[Key in keyof TSchema]: InferInsertModel<TSchema[Key]>[];
	},
	sourceTag: string | undefined,
	validator?: DataValidator,
	targetTag?: string,
	reporter?: ProgressReporter,
): Promise<unknown> {
	const transformed = await runDataTransformChain(
		versions,
		registry,
		input,
		sourceTag,
		targetTag,
		reporter,
	);
	const validated = validator ? await validator(transformed) : transformed;
	return validated;
}

/**
 * Helper to define a versions tuple without needing "as const" at call sites.
 * Preserves literal tag types across the tuple.
 *
 * Example:
 *   const versions = defineVersions(
 *     { tag: '0000', sqlText: 'CREATE TABLE ...;' },
 *     { tag: '0001', sqlText: '' },
 *   );
 */
export function defineVersions<TVersions extends readonly VersionDef<Tag4>[]>(
	...versions: TVersions
): TVersions {
	return versions;
}

/**
 * Derive the union of adapter table names from any shape that exposes a "schema" record.
 * This avoids coupling to the Adapter type while allowing type-safe table-name usage in hosts.
 *
 * Example:
 *   type Tables = AdapterTableNames<typeof adapter>;
 *   // Tables is the union of keys of adapter.schema (as strings)
 */
export type AdapterTableNames<A> = A extends { schema: Record<string, unknown> }
	? Extract<keyof A['schema'], string>
	: never;
