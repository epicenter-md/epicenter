import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { booksMirror } from '../src/db.ts';
import { tempDir } from './helpers.ts';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');

/** Seed a token-file entry good for an hour (mock accepts any bearer). */
function seedTokenFile(file: string, realmId: string): void {
	const now = Date.now();
	const token = {
		realmId,
		environment: 'sandbox',
		accessToken: 'seed-access',
		refreshToken: 'seed-refresh',
		accessTokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
		refreshTokenExpiresAt: new Date(now + 8726400 * 1000).toISOString(),
		obtainedAt: new Date(now).toISOString(),
	};
	writeFileSync(
		file,
		JSON.stringify({ [realmId]: JSON.stringify(token) }, null, 2),
	);
}

async function runCli(args: string[], env: Record<string, string>) {
	const proc = Bun.spawn([process.execPath, BIN, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

test('CLI: `sync --full` then `sync` runs incremental, advances the cursor, no re-pull', async () => {
	const server = startMockQbServer();
	const tmp = tempDir();
	const tokenFile = join(tmp.dir, 'credentials.json');
	seedTokenFile(tokenFile, server.realmId);
	const env = {
		LOCAL_BOOKS_DIR: tmp.dir,
		LOCAL_BOOKS_TOKEN_FILE: tokenFile,
		LOCAL_BOOKS_QB_API_BASE: server.apiBase,
		LOCAL_BOOKS_QB_TOKEN_URL: server.tokenUrl,
		LOCAL_BOOKS_QB_ENV: 'sandbox',
		// Narrow the realm set to one entity so the e2e stays a single query / cdc.
		LOCAL_BOOKS_ENTITIES: 'Invoice',
	};
	// Opened as a plain SQLite file, the way an agent pointed at the artifact
	// would: the fingerprinted filename is the only thing that changed for them.
	const dbFile = booksMirror(tmp.dir, server.realmId).path;

	// The realm cursor is one high-water mark for the company, stored in _meta.
	const realmCursor = (db: Database): string =>
		(
			db.query("SELECT value FROM _meta WHERE key='cdc_cursor'").get() as {
				value: string;
			}
		).value;

	server.put('Invoice', makeInvoice('1'));
	server.put('Invoice', makeInvoice('2'));

	// Checkpoint 2: full pull (the realm pass, forced FULL).
	const full = await runCli(['sync', '--full', '--realm', server.realmId], env);
	expect(full.exitCode).toBe(0);
	expect(full.stdout).toContain('FULL');

	const read1 = new Database(dbFile, { readonly: true });
	const counts = read1
		.query('SELECT count(*) AS n, min(json_valid(raw)) AS v FROM invoices')
		.get() as { n: number; v: number };
	const cursor1 = realmCursor(read1);
	read1.close();
	expect(counts.n).toBe(2);
	expect(counts.v).toBe(1);
	expect(cursor1).toBeTruthy();

	// Mutate the source after the full pull (small gap so timestamps clear the cursor).
	await Bun.sleep(30);
	server.put('Invoice', makeInvoice('2', { TotalAmt: 555 }));
	server.put('Invoice', makeInvoice('3'));

	// Checkpoint 3: incremental (the realm pass picks INCREMENTAL from the cursor).
	const inc = await runCli(['sync', '--realm', server.realmId], env);
	expect(inc.exitCode).toBe(0);
	expect(inc.stdout).toContain('INCREMENTAL');

	const read2 = new Database(dbFile, { readonly: true });
	const after = read2.query('SELECT count(*) AS n FROM invoices').get() as {
		n: number;
	};
	const cursor2 = realmCursor(read2);
	read2.close();
	expect(after.n).toBe(3);
	expect(Date.parse(cursor2)).toBeGreaterThan(Date.parse(cursor1));

	// The proof that incremental did NOT re-pull: one query (full) + one cdc (incremental).
	expect(server.hits.query).toBe(1);
	expect(server.hits.cdc).toBe(1);

	server.stop();
	tmp.cleanup();
});
