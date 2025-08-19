#!/usr/bin/env bun

/**
 * Minimal CLI for the Reddit demo adapter.
 *
 * Commands:
 *   - import <adapter>     [--file <zip>] [--db <dbPath>]
 *   - export-fs <adapter>  [--db <dbPath>] [--repo <dir>]  (Markdown only)
 *   - import-fs <adapter>  [--db <dbPath>] [--repo <dir>]  (Markdown only)
 *   - serve                [--db <dbPath>]                 (stub)
 *
 * Defaults (if not provided):
 *   --file  ./export_rocket_scientist2_20250811.zip   (relative to cwd)
 *   --db    ./.data/reddit.db                         (relative to cwd)
 *   --repo  .                                         (current working directory)
 *
 * Environment:
 *   DATABASE_URL (optional) overrides the db URL entirely (e.g., libsql://..., file:/abs/path.db).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import type { Importer } from '@repo/vault-core';
import {
	defaultConvention,
	LocalFileStore,
	markdownFormat,
	VaultService,
} from '@repo/vault-core';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// -------------------------------------------------------------
type CLIArgs = {
	_: string[]; // positional
	file?: string;
	db?: string;
	repo?: string;
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
		} else if (a === '--repo') {
			out.repo = argv[++i];
		} else if (a.startsWith('--repo=')) {
			out.repo = a.slice('--repo='.length);
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

function getBinPath(): string {
	const rel = path.relative(process.cwd(), __filename);
	return rel || __filename;
}

function printHelp(): void {
	const bin = getBinPath();
	console.log(
		`Usage:\n  bun run ${bin} <command> [options]\n\nCommands:\n  import <adapter>       Import a Reddit export ZIP into the database\n  export-fs <adapter>    Export DB rows to Markdown files under vault/<adapter>/...\n  import-fs <adapter>    Import Markdown files from vault/<adapter>/... into the DB\n  serve                  Start stub server (not implemented)\n\nOptions:\n  --file <zip>           Path to Reddit export ZIP (import only)\n  --db <path>            Path to SQLite DB file (default: ./.data/reddit.db or DATABASE_URL)\n  --repo <dir>           Repo root for plaintext I/O (default: .)\n  -h, --help             Show this help\n\nNotes:\n  - Files are Markdown only, written under vault/<adapter>/<table>/<pk...>.md\n  - DATABASE_URL, if set, overrides --db entirely.\n`,
	);
}

function resolveZipPath(p?: string): string {
	const candidate = p ?? './export_rocket_scientist2_20250811.zip';
	return path.resolve(process.cwd(), candidate);
}

function resolveDbFile(p?: string): string {
	const candidate = p ?? './.data/reddit.db';
	return path.resolve(process.cwd(), candidate);
}

function resolveRepoDir(p?: string): string {
	const candidate = p ?? '.';
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
	let importer: Importer | undefined;

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
				importer = a as Importer;
			}
		}
	}

	if (!importer) throw new Error(`Could not find adapter for key ${adapterID}`);

	// Initialize VaultService (runs migrations implicitly)
	const service = await VaultService.create({
		importers: [importer],
		database: db,
		migrateFunc: migrate,
	});

	const res = await service.importBlob(blob, adapterID);
	const counts = countRecords(res.parsed);
	console.log(`\n=== Adapter: ${res.importer} ===`);
	printCounts(counts);
	console.log(`\nImport complete. DB path: ${dbFile}`);
}

// -------------------------------------------------------------
// Export DB -> Files (Markdown only)
// -------------------------------------------------------------
async function cmdExportFs(args: CLIArgs, adapterID: string) {
	const dbFile = resolveDbFile(args.db);
	const dbUrl = toDbUrl(dbFile);
	const repoDir = resolveRepoDir(args.repo);

	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);
	const db = rawDb;

	let importer: Importer | undefined;
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
			if (a && typeof a === 'object' && 'id' in a && a.id === adapterID) {
				importer = a as Importer;
			}
		}
	}
	if (!importer) throw new Error(`Could not find adapter for key ${adapterID}`);

	const service = await VaultService.create({
		importers: [importer],
		database: db,
		migrateFunc: migrate,
		codec: markdownFormat,
		conventions: defaultConvention(),
	});

	const store = new LocalFileStore(repoDir);
	const result = await service.export(adapterID, store);
	const n = Object.keys(result.files).length;
	console.log(`Exported ${n} files to ${repoDir}/vault/${adapterID}`);
}

// -------------------------------------------------------------
// Import Files -> DB (Markdown only)
// -------------------------------------------------------------
async function cmdImportFs(args: CLIArgs, adapterID: string) {
	const dbFile = resolveDbFile(args.db);
	const dbUrl = toDbUrl(dbFile);
	const repoDir = resolveRepoDir(args.repo);

	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);
	const db = rawDb;

	let importer: Importer | undefined;
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
			if (a && typeof a === 'object' && 'id' in a && a.id === adapterID) {
				importer = a as Importer;
			}
		}
	}
	if (!importer) throw new Error(`Could not find adapter for key ${adapterID}`);

	const service = await VaultService.create({
		importers: [importer],
		database: db,
		migrateFunc: migrate,
		codec: markdownFormat,
		conventions: defaultConvention(),
	});

	const store = new LocalFileStore(repoDir);
	await service.import(adapterID, store);
	console.log(
		`Imported files from ${repoDir}/vault/${adapterID} into DB ${dbFile}`,
	);
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

function countRecords(parsed: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (parsed && typeof parsed === 'object') {
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			out[k] = Array.isArray(v) ? v.length : 0;
		}
	}
	return out;
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

	// Global help
	if (argv.includes('--help') || argv.includes('-h') || args._[0] === 'help') {
		printHelp();
		return;
	}

	const command = args._[0] ?? 'import';
	switch (command) {
		case 'import':
			{
				// Default to 'reddit' for this demo if adapter not provided
				const adapter = args._[1] ?? 'reddit';
				await cmdImport(args, adapter);
			}
			break;
		case 'export-fs':
			{
				const adapter = args._[1] ?? 'reddit';
				await cmdExportFs(args, adapter);
			}
			break;
		case 'import-fs':
			{
				const adapter = args._[1] ?? 'reddit';
				await cmdImportFs(args, adapter);
			}
			break;
		case 'serve':
			await cmdServe(args);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
