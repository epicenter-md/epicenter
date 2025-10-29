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
 *   --file                                            (relative to cwd)
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
import type { Adapter } from '@repo/vault-core';
import { createVault, defaultConvention } from '@repo/vault-core';
import { markdownFormat } from '@repo/vault-core/codecs';
import { drizzle } from 'drizzle-orm/libsql';

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
		`Usage:\n  bun run ${bin} <command> [options]\n\nCommands:\n  import <adapter>       Import a Reddit export ZIP into the database\n  export-fs <adapter>    Export DB rows to Markdown files under vault/<adapter>/...\n  import-fs <adapter>    Import Markdown files from vault/<adapter>/... into the DB\n\nOptions:\n  --file <zip>           Path to Reddit export ZIP (import only)\n  --db <path>            Path to SQLite DB file (default: ./.data/reddit.db or DATABASE_URL)\n  --repo <dir>           Repo root for plaintext I/O (default: .)\n  -h, --help             Show this help\n\nNotes:\n  - Files are Markdown only, written under vault/<adapter>/<table>/<pk...>.md\n  - DATABASE_URL, if set, overrides --db entirely.\n`,
	);
}

function resolveZipPath(p: string): string {
	const candidate = p ?? './export_rocket_scientist2_20250811.zip';
	return path.resolve(process.cwd(), candidate);
}

function resolveDbFile(p: string): string {
	const candidate = p;
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
// Helpers to work with new core API
// -------------------------------------------------------------
async function findAdapter(adapterID: string): Promise<Adapter> {
	const adaptersDir = path.resolve(
		repoRoot,
		'packages/vault-core/src/adapters',
	);
	const keys = await fs.readdir(adaptersDir);
	for (const key of keys) {
		const modulePath = import.meta.resolve(
			`../../../packages/vault-core/src/adapters/${key}`,
		);
		const mod = (await import(modulePath)) as Record<string, unknown>;
		for (const func of Object.values(mod)) {
			if (typeof func !== 'function') continue;
			try {
				const a = func();
				if (a && typeof a === 'object' && 'id' in a && a.id === adapterID) {
					return a as Adapter;
				}
			} catch {
				// ignore factory functions that require params or throw
			}
		}
	}
	throw new Error(`Could not find adapter for key ${adapterID}`);
}

async function writeFilesToRepo(
	repoDir: string,
	files: Map<string, File>,
): Promise<number> {
	let count = 0;
	for (const [relPath, file] of files) {
		const absPath = path.resolve(repoDir, relPath);
		await ensureDirExists(absPath);
		const text = await file.text();
		await fs.writeFile(absPath, text, 'utf8');
		count++;
	}
	return count;
}

async function collectFilesFromRepo(
	repoDir: string,
): Promise<Map<string, File>> {
	const root = path.resolve(repoDir, 'vault');
	const out = new Map<string, File>();

	async function walk(dir: string) {
		let entries: Array<import('node:fs').Dirent>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				const relFromRepo = path
					.relative(repoDir, full)
					.split(path.sep)
					.join('/');
				const text = await fs.readFile(full, 'utf8');
				const f = new File([text], entry.name, { type: 'text/plain' });
				out.set(relFromRepo, f);
			}
		}
	}

	await walk(root);
	return out;
}

// -------------------------------------------------------------
// Import command (ZIP ingest via adapter ingestor)
// -------------------------------------------------------------
async function cmdImport(args: CLIArgs, adapterID: string) {
	const { file, db } = args;
	if (!file) throw new Error('--file is required for import command');
	if (!db) throw new Error('--db is required for import command');

	const zipPath = resolveZipPath(file);
	const dbFile = resolveDbFile(db);
	const dbUrl = toDbUrl(dbFile);

	// Prepare DB
	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);

	// Read ZIP and wrap in File for bun runtime
	const data = await fs.readFile(zipPath);
	const blob = new Blob([new Uint8Array(data)], { type: 'application/zip' });
	const zipFile = new File([blob], path.basename(zipPath), {
		type: 'application/zip',
	});

	// Resolve adapter and create vault
	const adapter = await findAdapter(adapterID);
	const vault = createVault({
		adapters: [adapter],
		// @ts-expect-error works but slight type mismatch
		database: rawDb,
	});

	// Ingest data through adapter's ingestor
	await vault.ingestData({ adapter, file: zipFile });

	console.log(
		`\nIngest complete for adapter '${adapterID}'. DB path: ${dbFile}`,
	);
}

// -------------------------------------------------------------
// Export DB -> Files (Markdown only)
// -------------------------------------------------------------
async function cmdExportFs(args: CLIArgs, adapterID: string) {
	const { db } = args;
	if (!db) throw new Error('--db is required for export-fs command');

	const dbFile = resolveDbFile(db);
	const dbUrl = toDbUrl(dbFile);
	const repoDir = resolveRepoDir(args.repo);

	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);

	// Resolve adapter and create vault
	const adapter = await findAdapter(adapterID);
	const vault = createVault({
		adapters: [adapter],
		// @ts-expect-error works but slight type mismatch
		database: rawDb,
	});

	// Export files as Map<string, File> using markdown codec and default conventions
	const files = await vault.exportData({
		adapterIDs: [adapterID],
		codec: markdownFormat,
		conventions: defaultConvention(),
	});

	const n = await writeFilesToRepo(repoDir, files);
	console.log(`Exported ${n} files to ${repoDir}/vault/${adapterID}`);
}

// -------------------------------------------------------------
// Import Files -> DB (Markdown only)
// -------------------------------------------------------------
async function cmdImportFs(args: CLIArgs, adapterID: string) {
	const { db } = args;
	if (!db) throw new Error('--db is required for import-fs command');

	const dbFile = resolveDbFile(db);
	const dbUrl = toDbUrl(dbFile);
	const repoDir = resolveRepoDir(args.repo);

	await ensureDirExists(dbFile);
	const client = createClient({ url: dbUrl });
	const rawDb = drizzle(client);

	// Resolve adapter and create vault
	const adapter = await findAdapter(adapterID);
	const vault = createVault({
		adapters: [adapter],
		// @ts-expect-error works but slight type mismatch
		database: rawDb,
	});

	// Read files under repoDir/vault and import via markdown codec
	const files = await collectFilesFromRepo(repoDir);
	await vault.importData({
		files,
		codec: markdownFormat,
	});

	console.log(
		`Imported files from ${repoDir}/vault/${adapterID} into DB ${dbFile}`,
	);
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
