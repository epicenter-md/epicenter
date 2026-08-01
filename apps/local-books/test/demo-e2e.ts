/**
 * Transcript demo: drive the real `local-books` CLI through the spec's slice 1-3
 * checkpoints against the mock QuickBooks server, running the literal goal
 * commands (including `sqlite3 <artifact> ...`). Not a unit test.
 *
 *   bun run test/demo-e2e.ts
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { booksMirror } from '../src/db.ts';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');
const DATA_DIR = '/tmp/local-books-demo';
rmSync(DATA_DIR, { recursive: true, force: true });

async function sh(
	cmd: string[],
	env: Record<string, string> = {},
): Promise<string> {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return (out + err).trimEnd();
}

function banner(label: string): void {
	console.log(`\n\x1b[1m━━ ${label} ━━\x1b[0m`);
}

const server = startMockQbServer();
const realmId = server.realmId;
const tokenFile = join(DATA_DIR, 'credentials.json');
const dbFile = booksMirror(DATA_DIR, realmId).path;

const env = {
	LOCAL_BOOKS_DIR: DATA_DIR,
	LOCAL_BOOKS_TOKEN_FILE: tokenFile,
	LOCAL_BOOKS_QB_API_BASE: server.apiBase,
	LOCAL_BOOKS_QB_TOKEN_URL: server.tokenUrl,
	LOCAL_BOOKS_QB_ENV: 'sandbox',
	// Narrow the mirrored set to one entity so the transcript stays readable.
	LOCAL_BOOKS_ENTITIES: 'Invoice',
};
const cli = (...args: string[]) =>
	sh([process.execPath, BIN, ...args, '--realm', realmId], env);
const sqlite = (sql: string) => sh(['sqlite3', dbFile, sql]);

// Seed a token-file entry (good for an hour) so we can run sync/status without
// the interactive browser hop. The mock accepts any bearer token.
async function main() {
	const { mkdirSync } = await import('node:fs');
	mkdirSync(DATA_DIR, { recursive: true });
	const now = Date.now();
	writeFileSync(
		tokenFile,
		JSON.stringify({
			[realmId]: JSON.stringify({
				realmId,
				environment: 'sandbox',
				accessToken: 'demo-access',
				refreshToken: 'demo-refresh',
				accessTokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
				refreshTokenExpiresAt: new Date(now + 8726400 * 1000).toISOString(),
				obtainedAt: new Date(now).toISOString(),
			}),
		}),
	);

	server.put('Invoice', makeInvoice('1001'));
	server.put('Invoice', makeInvoice('1002'));

	banner('Checkpoint 1 — status shows a valid, non-expired token');
	console.log(await cli('status'));

	banner('Checkpoint 2 — local-books sync --full');
	console.log(await cli('sync', '--full'));
	console.log(
		'\n$ sqlite3 books "SELECT count(*), min(json_valid(raw)) FROM invoices"',
	);
	console.log(
		await sqlite('SELECT count(*), min(json_valid(raw)) FROM invoices'),
	);
	console.log(
		'\n$ sqlite3 books "SELECT key, value FROM _meta WHERE key=\'cdc_cursor\'"',
	);
	const cursorBefore = await sqlite(
		"SELECT key, value FROM _meta WHERE key='cdc_cursor'",
	);
	console.log(cursorBefore);

	// Mutate the QuickBooks source after the full pull.
	await Bun.sleep(40);
	server.put('Invoice', makeInvoice('1002', { TotalAmt: 777 })); // update
	server.put('Invoice', makeInvoice('1003')); // new
	server.remove('Invoice', '1001'); // delete

	banner('Checkpoint 3 — second local-books sync (no --full) runs INCREMENTAL');
	console.log(await cli('sync'));
	console.log(
		'\n$ sqlite3 books "SELECT key, value FROM _meta WHERE key=\'cdc_cursor\'"  (cursor AFTER)',
	);
	console.log(
		await sqlite("SELECT key, value FROM _meta WHERE key='cdc_cursor'"),
	);
	console.log(
		'\n$ sqlite3 books "SELECT count(*) total, sum(deleted) soft_deleted FROM invoices"',
	);
	console.log(
		await sqlite(
			'SELECT count(*) AS total, sum(deleted) AS soft_deleted FROM invoices',
		),
	);
	console.log(
		'\n$ sqlite3 books "SELECT id, total_amt, deleted FROM invoices ORDER BY id"',
	);
	console.log(
		await sqlite('SELECT id, total_amt, deleted FROM invoices ORDER BY id'),
	);

	banner('No full re-pull: mock endpoint hit counts');
	console.log(`query endpoint hits (full pulls): ${server.hits.query}`);
	console.log(`cdc endpoint hits (incremental):  ${server.hits.cdc}`);

	banner('Final status');
	console.log(await cli('status'));

	server.stop();
}

await main();
