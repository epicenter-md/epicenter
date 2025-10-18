#!/usr/bin/env bun

/**
 * Minimal CLI to import a Reddit export ZIP into a local LibSQL database.
 * Commands:
 *   - import [--file <zip>] [--db <dbPath>]
 *   - serve  [--db <dbPath>]   (stub)
 *
 * Defaults:
 *   --file defaults to ./export_rocket_scientist2_20250811.zip (cwd)
 *   --db   defaults to ./.data/reddit.db (cwd)
 *
 * DATABASE_URL (optional):
 *   If set, overrides the db URL entirely (e.g., libsql://..., file:/abs/path.db).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import type { Adapter } from '@repo/vault-core';
import { Vault } from '@repo/vault-core';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// -------------------------------------------------------------
type CLIArgs = {
	_: string[]; // positional
	file?: string;
	db?: string;
};

function parseArgs(argv: string[]): CLIArgs {
	const out: CLIArgs = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--file') {
			out.file = argv[++i];
		} else if (a.startsWith('--file=')) {
			out.file = a.slice('--file='.length);
		} else if (a === '--db') {
			out.db = argv[++i];
		} else if (a.startsWith('--db=')) {
			out.db = a.slice('--db='.length);
		} else if (!a.startsWith('-')) {
			out._.push(a);
		}
	}
	return out;
}

// -------------------------------------------------------------
// Paths helpers
// -------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..'); // apps/demo-mcp/src -> repo root

function resolveZipPath(p?: string): string {
	const candidate = p ?? './export_rocket_scientist2_20250811.zip';
	return path.resolve(process.cwd(), candidate);
}

function resolveDbFile(p?: string): string {
	const candidate = p ?? './.data/reddit.db';
	return path.resolve(process.cwd(), candidate);
}

// Note: migrations folder is resolved per-adapter below

// -------------------------------------------------------------
// DB helpers
// -------------------------------------------------------------
async function ensureDirExists(filePath: string) {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
}

function toDbUrl(dbFileAbs: string): string {
	// If DATABASE_URL is set, just use it.
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	// Otherwise, use a libsql file URL
	// libsql supports file: scheme for local files
	return `file:${dbFileAbs}`;
}

// -------------------------------------------------------------
// Import command
// -------------------------------------------------------------
async function cmdImport(args: CLIArgs, adapterID: string) {
	const zipPath = resolveZipPath(args.file);
	const dbFile = resolveDbFile(args.db);
	const dbUrl = toDbUrl(dbFile);

	// Prepare DB and run migrations
	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);
	// Cast libsql drizzle DB to the generic BaseSQLiteDatabase shape expected by Vault
	const db = rawDb;

	// Read input once (adapters may ignore if not applicable)
	const data = await fs.readFile(zipPath);
	const blob = new Blob([new Uint8Array(data)], { type: 'application/zip' });

	// Build adapter instances, ensuring migrations path is absolute per adapter package
	let adapter: Adapter | undefined;

	// This is just patch code, don't look too closely!
	const keys = await fs.readdir(
		path.resolve(repoRoot, 'packages/vault-core/src/adapters'),
	);
	for (const key of keys) {
		const modulePath = import.meta.resolve(
			`../../../packages/vault-core/src/adapters/${key}`,
		);
		const mod = (await import(modulePath)) as Record<string, unknown>;
		for (const func of Object.values(mod)) {
			if (typeof func !== 'function') continue;
			const a = func();

			// TODO
			if (a && typeof a === 'object' && 'id' in a && a.id === adapterID) {
				adapter = a as Adapter;
			}
		}
	}

	if (!adapter) throw new Error(`Could not find adapter for key ${adapterID}`);

	// Initialize Vault (runs migrations implicitly)
	const vault = await Vault.create({
		adapters: [adapter],
		database: db,
		migrateFunc: migrate,
	});

	const summary = await vault.importBlob(blob, adapterID);
	for (const r of summary.reports) {
		console.log(`\n=== Adapter: ${r.adapter} ===`);
		printCounts(r.counts);
	}
	console.log(`\nAll adapters complete. DB path: ${dbFile}`);

	vault.getCurrentLayout();
}

function printCounts(parsedOrCounts: Record<string, unknown>) {
	const entries: [string, number][] = Object.entries(parsedOrCounts).map(
		([k, v]) => [
			k,
			typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0,
		],
	);
	const maxKey = Math.max(...entries.map(([k]) => k.length), 10);
	for (const [k, n] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		console.log(`${k.padEnd(maxKey, ' ')} : ${n}`);
	}
}

// -------------------------------------------------------------
// Serve command (stub)
// -------------------------------------------------------------
async function cmdServe(args: CLIArgs) {
	const dbFile = resolveDbFile(args.db);
	const dbUrl = toDbUrl(dbFile);

	console.log('Serve is not implemented in this minimal demo.');
	console.log(
		'Intended behavior: start an MCP server sourced by the adapter and DB.',
	);
	console.log(`DB path: ${dbFile}`);
	console.log(`DB URL:  ${dbUrl}`);
	console.log('Exiting.');
}

// -------------------------------------------------------------
// Entrypoint
// -------------------------------------------------------------
async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);

	const command = args._.at(0) ?? 'import';
	switch (command) {
		case 'import':
			{
				const adapter = args._[1];
				await cmdImport(args, adapter);
			}
			break;
		case 'serve':
			await cmdServe(args);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			console.error('Usage:');
			console.error(
				'  bun run src/cli.ts import <adapter> [--file <zip>] [--db <dbPath>]',
			);
			console.error('  bun run src/cli.ts serve  [--db <dbPath>]');
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
