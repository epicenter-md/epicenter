import fs from 'node:fs/promises';
import path from 'node:path';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { CompatibleDB } from './adapter';
import type { Importer } from './importer';

export type JournalEntry = {
	/** Drizzle migration tag, usually the filename without extension (e.g., 0001_add_posts) */
	tag: string;
	/** ISO timestamp or number; shape depends on drizzle-kit version */
	when?: unknown;
	/** Optional checksum/hash; presence depends on drizzle version */
	hash?: string;
};

export type MigrationJournal = {
	entries: JournalEntry[];
};

export type SqlStep = {
	tag: string; // matches journal tag
	direction: 'up' | 'down';
	file: string; // absolute path to .sql
};

export type MigrationPlan = {
	from?: string; // current DB version tag (if known)
	to: string; // target version tag
	steps: SqlStep[]; // ordered
};

/** Resolve the migrations directory for an importer. */
export function resolveMigrationsDir(importer: Importer): string {
	// Drizzle config usually sets `out` to a folder containing SQL files and meta/_journal.json
	// TODO: Ensure this is absolute; if relative, decide base (adapter package dir vs process.cwd()).
	const out = importer.drizzleConfig.out ?? '';
	if (!path.isAbsolute(out)) {
		// Fallback: treat relative to process.cwd(); callers can pre-resolve if needed
		return path.resolve(process.cwd(), out);
	}
	return out;
}

/** Read Drizzle's meta/_journal.json */
export async function readMigrationJournal(
	migrationsDir: string,
): Promise<MigrationJournal> {
	const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
	const raw = await fs.readFile(journalPath, 'utf8');
	const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
	return { entries: parsed.entries ?? [] };
}

/** List available SQL files and map to tags/directions. */
export async function listSqlSteps(migrationsDir: string): Promise<SqlStep[]> {
	const files = await fs.readdir(migrationsDir);
	const steps: SqlStep[] = [];
	for (const f of files) {
		if (!f.endsWith('.sql')) continue;
		const full = path.join(migrationsDir, f);
		// Heuristic: drizzle names like 0001_name.sql with two statements (up/down) or separate up/down files
		// TODO: Detect drizzle style; for now assume paired files 0001_name.sql contains both up and down separated by comments.
		// Placeholder: treat every .sql as an 'up' step (down not used in forward application).
		const tag = f.replace(/\.sql$/, '');
		steps.push({ tag, direction: 'up', file: full });
	}
	return steps;
}

/** Compute a forward-only plan from current -> target using journal ordering. */
export function planToVersion(
	journal: MigrationJournal,
	allSteps: SqlStep[],
	currentTag: string | undefined,
	targetTag: string,
): MigrationPlan {
	const order = new Map(journal.entries.map((e, i) => [e.tag, i] as const));
	if (!order.has(targetTag)) {
		throw new Error(`Target migration tag not found in journal: ${targetTag}`);
	}
	const currentIdx = currentTag != null ? (order.get(currentTag) ?? -1) : -1;
	const targetIdx = order.get(targetTag);
	if (targetIdx === undefined) {
		throw new Error(`Target migration tag not found in journal: ${targetTag}`);
	}
	const forward = journal.entries
		.slice(currentIdx + 1, targetIdx + 1)
		.map((e) => e.tag);
	const steps = forward
		.map((tag) => allSteps.find((s) => s.tag === tag && s.direction === 'up'))
		.filter((s): s is SqlStep => !!s);
	return { from: currentTag, to: targetTag, steps };
}

/** Drop all tables owned by the importer (best-effort). */
export async function dropAdapterTables(
	db: CompatibleDB,
	importer: Importer,
): Promise<void> {
	// TODO: Use Drizzle metadata to get table names reliably; for now, list keys from schema object.
	const schema = (importer.adapter.schema ?? {}) as Record<string, SQLiteTable>;
	// TODO: Acquire a raw SQL runner; Drizzle's libsql adapter doesn't expose raw execution directly here.
	const runSql = getSqlRunner(db);
	for (const [name] of Object.entries(schema)) {
		// TODO: Quote name properly for SQLite identifiers
		await runSql(`DROP TABLE IF EXISTS "${name}";`);
	}
}

/** Inspect Drizzle migrations table for current version tag (implementation TBD). */
export async function getCurrentDbMigrationTag(
	db: CompatibleDB,
	importer: Importer,
): Promise<string | undefined> {
	// TODO: Query importer.drizzleConfig.migrations?.table (default likely 'drizzle_migrations') to get last applied tag/name.
	// This requires a query API or raw SQL; wire up a small query once the DB flavor is known.
	throw new Error('Not implemented: getCurrentDbMigrationTag');
}

/** Apply a sequence of SQL files in order. */
export async function applySqlPlan(
	db: CompatibleDB,
	importer: Importer,
	plan: MigrationPlan,
) {
	const runSql = getSqlRunner(db);
	for (const step of plan.steps) {
		const sql = await fs.readFile(step.file, 'utf8');
		// TODO: If a single file contains both up/down, split by sentinel comments.
		// Importer-specific handling can occur here (e.g., feature flags, schema qualifiers)
		void importer; // placeholder to acknowledge importer until used
		await runSql(sql);
	}
}

/** Mark a migration tag as applied in the Drizzle migrations table (implementation TBD). */
export async function markApplied(
	db: CompatibleDB,
	importer: Importer,
	toTag: string,
) {
	// TODO: Insert into migrations table or update state consistent with drizzle-orm expectations.
	throw new Error('Not implemented: markApplied');
}

/** Obtain a raw SQL runner from a CompatibleDB. Placeholder until concrete DBs are wired. */
export function getSqlRunner(
	_db: CompatibleDB,
): (sql: string) => Promise<void> {
	// TODO: For libsql: keep a handle to the underlying client and call client.execute(sql)
	// TODO: For better-sqlite3: use db.exec(sql)
	return async (_sql: string) => {
		throw new Error('Not implemented: raw SQL execution for migrations');
	};
}
