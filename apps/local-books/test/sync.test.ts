import { expect, test } from 'bun:test';
import { parseInterval } from '../src/cli.ts';
import type { AppConfig } from '../src/config.ts';
import { booksMirror, openBooksDb } from '../src/db.ts';
import { createQbClient } from '../src/qb-client.ts';
import { repairEntities, runSyncLoop, syncRealm } from '../src/sync.ts';
import { createTokenManager } from '../src/token-manager.ts';
import { type TokenSet, tokenSetFromGrant } from '../src/tokens.ts';
import {
	createMemoryTokenStore,
	makeConfig,
	sampleGrant,
	tempDir,
} from './helpers.ts';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

/** A minimal QuickBooks Customer fixture (a name list the transactions reference). */
const customer = (id: string, over: Record<string, unknown> = {}) => ({
	Id: id,
	DisplayName: 'Acme',
	Active: true,
	Balance: 0,
	...over,
});

/** Wire the real engine (db + client + token manager + sync) to the mock. */
function setup(configOver: Partial<AppConfig> = {}) {
	let clock = Date.parse('2026-06-21T00:00:00.000Z');
	const now = () => clock;
	const advance = (ms = 5000) => {
		clock += ms;
	};

	const server = startMockQbServer({ now });
	const config = makeConfig({
		apiBase: server.apiBase,
		tokenUrl: server.tokenUrl,
		realmOverride: server.realmId,
		entities: ['Invoice'],
		...configOver,
	});
	const store = createMemoryTokenStore();
	const token = tokenSetFromGrant(sampleGrant, {
		realmId: server.realmId,
		environment: 'sandbox',
		now: clock,
	}).data as TokenSet;
	const tokens = createTokenManager({ config, store, token, now });
	const client = createQbClient({ config, realmId: server.realmId, tokens });
	const tmp = tempDir();
	const db = openBooksDb(booksMirror(tmp.dir, server.realmId));

	const teardown = () => {
		db.close();
		server.stop();
		tmp.cleanup();
	};
	return {
		server,
		config,
		db,
		deps: { db, client, config, now },
		advance,
		teardown,
	};
}

const one = <T>(db: ReturnType<typeof openBooksDb>, sql: string): T =>
	db.raw.query(sql).get() as T;

test('full pull seeds the mirror with valid JSON and the realm cursor', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Invoice', makeInvoice('2'));
	ctx.server.put('Invoice', makeInvoice('3'));

	const out = await syncRealm(ctx.deps, { forceFull: true });
	expect(out.mode).toBe('FULL');
	const inv = out.entities.find((e) => e.entity === 'Invoice');
	expect(inv?.upserted).toBe(3);
	expect(inv?.deleted).toBe(0);

	// The literal goal check: rows present, raw is valid JSON.
	const counts = one<{ n: number; v: number }>(
		ctx.db,
		'SELECT count(*) AS n, min(json_valid(raw)) AS v FROM invoices',
	);
	expect(counts.n).toBe(3);
	expect(counts.v).toBe(1);

	// The realm cursor is populated and equals the full pull's cursor.
	const realm = ctx.db.readRealmState();
	expect(realm.cdcCursor).toBe(out.cursorAfter);
	expect(realm.lastFullPullAt).toBe(out.cursorAfter);

	ctx.teardown();
});

test('incremental upserts only changes, soft-deletes, advances the cursor, and never re-pulls', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Invoice', makeInvoice('2'));
	ctx.server.put('Invoice', makeInvoice('3'));

	const full = await syncRealm(ctx.deps, { forceFull: true });
	const cursorBefore = full.cursorAfter!;

	// Mutate the source after the full pull: update 2, add 4, delete 3.
	ctx.advance();
	ctx.server.put('Invoice', makeInvoice('2', { TotalAmt: 999 }));
	ctx.server.put('Invoice', makeInvoice('4'));
	ctx.server.remove('Invoice', '3');

	const inc = await syncRealm(ctx.deps, { forceFull: false });
	expect(inc.mode).toBe('INCREMENTAL');
	const invR = inc.entities.find((e) => e.entity === 'Invoice');
	expect(invR?.upserted).toBe(2); // invoice 2 (updated) + invoice 4 (new)
	expect(invR?.deleted).toBe(1); // invoice 3

	// Cursor advanced, not reset.
	expect(inc.cursorBefore).toBe(cursorBefore);
	expect(Date.parse(inc.cursorAfter!)).toBeGreaterThan(
		Date.parse(cursorBefore),
	);
	expect(ctx.db.readRealmState().cdcCursor).toBe(inc.cursorAfter);

	// No full re-pull: exactly one query (the full) and one cdc (the incremental).
	expect(ctx.server.hits.query).toBe(1);
	expect(ctx.server.hits.cdc).toBe(1);

	// Mirror reflects the changes.
	expect(
		one<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM invoices').n,
	).toBe(4);
	expect(
		one<{ n: number }>(
			ctx.db,
			'SELECT count(*) AS n FROM invoices WHERE deleted=1',
		).n,
	).toBe(1);

	// Updated row reflected in both the extracted column and the blob.
	const inv2 = one<{ total_amt: number; raw: string }>(
		ctx.db,
		"SELECT total_amt, raw FROM invoices WHERE id='2'",
	);
	expect(inv2.total_amt).toBe(999);
	expect(JSON.parse(inv2.raw).TotalAmt).toBe(999);

	// Soft-delete preserves the blob (not just the delete stub).
	const inv3 = one<{ deleted: number; doc_number: string; raw: string }>(
		ctx.db,
		"SELECT deleted, doc_number, raw FROM invoices WHERE id='3'",
	);
	expect(inv3.deleted).toBe(1);
	expect(inv3.doc_number).toBe('INV-3');
	expect(JSON.parse(inv3.raw).DocNumber).toBe('INV-3');

	ctx.teardown();
});

test('one batched CDC call covers every entity (not one call per entity)', async () => {
	const ctx = setup({ entities: ['Invoice', 'Customer'] });
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Customer', customer('c1'));

	await syncRealm(ctx.deps, { forceFull: true });
	// FULL is per-entity: each entity is its own query endpoint.
	expect(ctx.server.hits.query).toBe(2);

	ctx.advance();
	ctx.server.put('Invoice', makeInvoice('1', { TotalAmt: 999 }));
	ctx.server.put('Customer', customer('c1', { DisplayName: 'Renamed' }));

	const inc = await syncRealm(ctx.deps, { forceFull: false });
	expect(inc.mode).toBe('INCREMENTAL');
	// The collapse: two entities refreshed by ONE CDC call, not two.
	expect(ctx.server.hits.cdc).toBe(1);
	expect(inc.entities.find((e) => e.entity === 'Invoice')?.upserted).toBe(1);
	expect(inc.entities.find((e) => e.entity === 'Customer')?.upserted).toBe(1);

	ctx.teardown();
});

test('a newly added entity backfills only itself; the rest ride one CDC call', async () => {
	const ctx = setup({ entities: ['Invoice'] });
	// Seed both invoices and customers in the source at T0, BEFORE any cursor
	// exists. Only Invoice is configured, so the full pull mirrors only Invoice.
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Invoice', makeInvoice('2'));
	ctx.server.put('Customer', customer('c1'));
	ctx.server.put('Customer', customer('c2'));

	await syncRealm(ctx.deps, { forceFull: true });
	expect(ctx.server.hits.query).toBe(1); // just Invoice

	ctx.advance(); // the realm cursor (T0) is now in the past

	// Add Customer to the mirrored set and run an incremental pass.
	ctx.config.entities.push('Customer');
	const queryBefore = ctx.server.hits.query;
	const cdcBefore = ctx.server.hits.cdc;

	const inc = await syncRealm(ctx.deps, { forceFull: false });
	expect(inc.mode).toBe('INCREMENTAL');

	// Customer had no table, so it was backfilled (one query); Invoice rode CDC.
	expect(ctx.server.hits.query - queryBefore).toBe(1);
	expect(ctx.server.hits.cdc - cdcBefore).toBe(1);
	expect(inc.entities.find((e) => e.entity === 'Customer')?.backfilled).toBe(
		true,
	);

	// The proof it was a full backfill, not a CDC: c1/c2 were created BEFORE the
	// cursor, so a CDC since the cursor would return zero. The two rows can only
	// come from the full query that backfilling runs.
	expect(
		one<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM customers').n,
	).toBe(2);

	ctx.teardown();
});

test('--entity repair re-pulls a table without moving the realm cursor', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));

	const full = await syncRealm(ctx.deps, { forceFull: true });
	const cursorAfterFull = ctx.db.readRealmState().cdcCursor;
	expect(cursorAfterFull).toBe(full.cursorAfter);

	ctx.advance();
	ctx.server.put('Invoice', makeInvoice('2'));

	const repair = await repairEntities(ctx.deps, ['Invoice']);
	expect(repair.reason).toContain('repair');
	expect(repair.entities.find((e) => e.entity === 'Invoice')?.backfilled).toBe(
		true,
	);
	// The repair re-pulled the table (both invoices now present)...
	expect(
		one<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM invoices').n,
	).toBe(2);
	// ...but the realm cursor is untouched (a repair is not a high-water move).
	expect(ctx.db.readRealmState().cdcCursor).toBe(cursorAfterFull);

	ctx.teardown();
});

test('a second incremental with no source changes is a clean no-op that still advances the cursor', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));
	await syncRealm(ctx.deps, { forceFull: true });

	ctx.advance();
	const inc = await syncRealm(ctx.deps, { forceFull: false });
	expect(inc.mode).toBe('INCREMENTAL');
	const invR = inc.entities.find((e) => e.entity === 'Invoice');
	expect(invR?.upserted).toBe(0);
	expect(invR?.deleted).toBe(0);
	expect(Date.parse(inc.cursorAfter!)).toBeGreaterThan(
		Date.parse(inc.cursorBefore!),
	);

	ctx.teardown();
});

test('a throttled (429) request is retried and the pull still completes', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.fail429(2); // first two data requests are throttled

	const out = await syncRealm(ctx.deps, { forceFull: true });
	expect(out.failures).toHaveLength(0);
	expect(out.entities.find((e) => e.entity === 'Invoice')?.upserted).toBe(1);
	// Throttled responses are not counted as successful query hits.
	expect(ctx.server.hits.query).toBe(1);

	ctx.teardown();
});

test('a 401 triggers a transparent refresh, retries, and persists the new token', async () => {
	const clock = Date.parse('2026-06-21T00:00:00.000Z');
	const now = () => clock;
	const server = startMockQbServer({ now });
	const config = makeConfig({
		apiBase: server.apiBase,
		tokenUrl: server.tokenUrl,
		realmOverride: server.realmId,
	});
	const store = createMemoryTokenStore();
	const stale: TokenSet = {
		realmId: server.realmId,
		environment: 'sandbox',
		accessToken: 'stale-access',
		refreshToken: 'valid-refresh',
		accessTokenExpiresAt: new Date(clock + 3600 * 1000).toISOString(),
		refreshTokenExpiresAt: new Date(clock + 8726400 * 1000).toISOString(),
		obtainedAt: new Date(clock).toISOString(),
	};
	await store.set(stale);
	server.rejectAccessToken('stale-access');

	const tokens = createTokenManager({ config, store, token: stale, now });
	const client = createQbClient({ config, realmId: server.realmId, tokens });
	server.put('Invoice', makeInvoice('1'));

	const { data, error } = await client.queryAll('Invoice');
	expect(error).toBeNull();
	expect(data?.length).toBe(1);
	expect(server.hits.token).toBe(1); // exactly one refresh
	expect(tokens.current().accessToken).not.toBe('stale-access');

	const persisted = await store.get(server.realmId);
	expect(persisted?.accessToken).toBe(tokens.current().accessToken);

	server.stop();
});

test('parseInterval understands s / m / h and rejects junk', () => {
	expect(parseInterval('30s')).toBe(30_000);
	expect(parseInterval('30m')).toBe(30 * 60_000);
	expect(parseInterval('2h')).toBe(2 * 3_600_000);
	expect(parseInterval('45')).toBe(45 * 60_000); // a bare number means minutes
	expect(() => parseInterval('soon')).toThrow();
});

test('runSyncLoop: full first pass, incremental after, stops on abort', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));

	const controller = new AbortController();
	await runSyncLoop(ctx.deps, {
		forceFull: true,
		intervalMs: 1,
		signal: controller.signal,
		onPass: (_outcome, pass) => {
			ctx.advance(); // move the clock forward between passes
			if (pass >= 2) controller.abort(); // stop after the 2nd pass
		},
	});

	// Pass 1 was FULL (one query), pass 2 was INCREMENTAL (one cdc): no re-pull.
	expect(ctx.server.hits.query).toBe(1);
	expect(ctx.server.hits.cdc).toBe(1);

	ctx.teardown();
});
