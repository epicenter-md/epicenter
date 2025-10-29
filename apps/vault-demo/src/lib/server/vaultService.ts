import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createVault } from '@repo/vault-core';
import { entityIndexAdapter } from '@repo/vault-core/adapters/entity-index';
import { exampleNotesAdapter } from '@repo/vault-core/adapters/example-notes';
import { redditAdapter } from '@repo/vault-core/adapters/reddit';
import { jsonFormat } from '@repo/vault-core/codecs';
import { drizzle } from 'drizzle-orm/bun-sqlite';

// Ensure data directory and DB path exist (stable across CWDs)
// Priority:
// 1) VAULT_DB_PATH (explicit override)
// 2) If CWD is apps/vault-demo -> use ".data/vault.sqlite"
// 3) Otherwise (running from monorepo root) -> "apps/vault-demo/.data/vault.sqlite"
const VAULT_DB_PATH = process.env.VAULT_DB_PATH;
const cwd = process.cwd().replace(/\\/g, '/');
const isAppCwd =
	cwd.endsWith('/apps/vault-demo') || cwd.includes('/apps/vault-demo/');
const computedDir = isAppCwd
	? path.resolve(cwd, '.data')
	: path.resolve(cwd, 'apps/vault-demo/.data');
const dataDir = VAULT_DB_PATH ? path.dirname(VAULT_DB_PATH) : computedDir;
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = VAULT_DB_PATH ?? path.join(dataDir, 'vault.sqlite');
// Optional debug breadcrumb to confirm which file is used
if (
	(process.env.VAULT_DEBUG ?? '').toLowerCase().includes('migrations') ||
	['1', 'true', 'all'].includes((process.env.VAULT_DEBUG ?? '').toLowerCase())
) {
	console.info('[vault-demo:vaultService] using sqlite dbPath=', dbPath);
}

export function getVault() {
	const sqlite = new Database(dbPath, { create: true, readwrite: true });
	const db = drizzle(sqlite);
	const v = createVault({
		database: db,
		adapters: [redditAdapter(), entityIndexAdapter(), exampleNotesAdapter()],
	});
	return v;
}

// Helper to compute table row counts for each adapter/table
export async function getTableCounts() {
	const { db, tables } = getVault().getQueryInterface();

	const result: Record<string, Record<string, number>> = {};
	for (const [adapterId, schema] of Object.entries(tables)) {
		result[adapterId] = {};
		for (const [tableName, table] of Object.entries(schema)) {
			try {
				const rows = await db.select().from(table);
				result[adapterId][tableName] = Array.isArray(rows) ? rows.length : 0;
			} catch {
				// Skip non-table exports if any exist
			}
		}
	}
	return result;
}

// Re-export codec for convenience in remote functions
export { jsonFormat };
