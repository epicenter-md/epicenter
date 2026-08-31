/**
 * The headline flow end to end through the binary: seed a small company in the
 * mock QuickBooks server, `local-books sync --full` it into the local copy, then
 * `local-books query` to grill it. Proves "upload your books and grill them"
 * works through the real sync pipeline, not just a hand-seeded mirror.
 */

import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempRoot } from './helpers.ts';
import { startMockQbServer } from './mock-qb-server.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');

/** Seed a token-file entry good for an hour (the mock accepts any bearer). */
function seedTokenFile(file: string, realmId: string): void {
	const now = Date.now();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			[realmId]: JSON.stringify({
				realmId,
				environment: 'sandbox',
				accessToken: 'seed-access',
				refreshToken: 'seed-refresh',
				accessTokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
				refreshTokenExpiresAt: new Date(now + 8726400 * 1000).toISOString(),
				obtainedAt: new Date(now).toISOString(),
			}),
		}),
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

test('sync --full then query: grill the mirror the pipeline produced', async () => {
	const server = startMockQbServer();
	const tmp = tempRoot();
	const tokenFile = join(tmp.appDir, 'credentials.json');
	seedTokenFile(tokenFile, server.realmId);
	const env = {
		EPICENTER_DATA_DIR: tmp.root,
		LOCAL_BOOKS_TOKEN_FILE: tokenFile,
		LOCAL_BOOKS_QB_API_BASE: server.apiBase,
		LOCAL_BOOKS_QB_TOKEN_URL: server.tokenUrl,
		LOCAL_BOOKS_QB_ENV: 'sandbox',
		LOCAL_BOOKS_ENTITIES: 'Invoice,Purchase',
	};

	// Two open invoices ($12k owed) and two expenses ($600 of software).
	server.put('Invoice', {
		Id: '1',
		DocNumber: 'INV-1',
		TxnDate: '2026-01-12',
		TotalAmt: 8000,
		Balance: 8000,
		CustomerRef: { value: '1', name: 'Acme' },
	});
	server.put('Invoice', {
		Id: '2',
		DocNumber: 'INV-2',
		TxnDate: '2026-02-12',
		TotalAmt: 4000,
		Balance: 4000,
		CustomerRef: { value: '1', name: 'Acme' },
	});
	server.put('Purchase', {
		Id: '7',
		TxnDate: '2026-01-08',
		TotalAmt: 600,
		Line: [
			{
				Id: '1',
				Amount: 600,
				DetailType: 'AccountBasedExpenseLineDetail',
				AccountBasedExpenseLineDetail: {
					AccountRef: { value: '61', name: 'Software & Subscriptions' },
				},
			},
		],
	});

	const sync = await runCli(['sync', '--full', '--realm', server.realmId], env);
	expect(sync.exitCode).toBe(0);

	// Grill 1: total open A/R.
	const ar = await runCli(
		[
			'query',
			'--realm',
			server.realmId,
			'SELECT SUM(balance) AS owed FROM invoices WHERE deleted = 0 AND balance > 0',
		],
		env,
	);
	expect(ar.exitCode).toBe(0);
	expect(JSON.parse(ar.stdout)).toEqual([{ owed: 12000 }]);

	// Grill 2: spend by category, drilling into raw Line[] with json_each.
	const spend = await runCli(
		[
			'query',
			'--realm',
			server.realmId,
			`SELECT json_extract(line.value, '$.AccountBasedExpenseLineDetail.AccountRef.name') AS category,
			        SUM(json_extract(line.value, '$.Amount')) AS spent
			 FROM purchases p, json_each(p.raw, '$.Line') line
			 WHERE p.deleted = 0 GROUP BY category`,
		],
		env,
	);
	expect(spend.exitCode).toBe(0);
	expect(JSON.parse(spend.stdout)).toEqual([
		{ category: 'Software & Subscriptions', spent: 600 },
	]);

	server.stop();
	tmp.cleanup();
});
