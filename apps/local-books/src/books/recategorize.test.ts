/**
 * `recategorizeExpense` driven against a mock QuickBooks server and a seeded
 * mirror: the write-through path end to end (read the SyncToken from the mirror
 * -> sparse-update QuickBooks -> fold the authoritative response back), and the
 * safety primitive (a stale SyncToken is rejected, never clobbered). The CLI
 * `recategorize` verb is a thin adapter over this.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../../test/helpers.ts';
import {
	makeBill,
	makePurchase,
	startMockQbServer,
} from '../../test/mock-qb-server.ts';
import { booksDbFile, openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { createFileTokenStore } from '../token-store.ts';
import type { TokenSet } from '../tokens.ts';
import { createQbAccess } from './qb-access.ts';
import { recategorizeExpense } from './recategorize.ts';

const NOW = Date.parse('2026-02-01T00:00:00.000Z');
const now = () => NOW;

/** Boot a mock company with one expense object, seed its token + mirror, return deps. */
async function setup(
	opts: {
		mockSyncToken?: string;
		mirrorSyncToken?: string;
		entity?: 'Purchase' | 'Bill';
		id?: string;
	} = {},
) {
	const entity = opts.entity ?? 'Purchase';
	const id = opts.id ?? 'p1';
	const make = entity === 'Bill' ? makeBill : makePurchase;
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const mock = startMockQbServer({ now });
	mock.put(entity, make(id, { SyncToken: opts.mockSyncToken ?? '0' }));

	const tokenFile = join(dir, 'credentials.json');
	const config = makeConfig({
		dataDir: dir,
		apiBase: mock.apiBase,
		tokenUrl: mock.tokenUrl,
		credentialsPath: tokenFile,
		entities: [entity],
	});
	const store = createFileTokenStore(tokenFile);
	const token: TokenSet = {
		realmId: mock.realmId,
		environment: 'sandbox',
		accessToken: 'access-seed',
		refreshToken: 'refresh-seed',
		accessTokenExpiresAt: new Date(NOW + 86_400_000).toISOString(),
		refreshTokenExpiresAt: new Date(NOW + 8_726_400_000).toISOString(),
		obtainedAt: new Date(NOW).toISOString(),
	};
	await store.set(token);

	const mirror = booksDbFile(dir, mock.realmId);
	const db = openBooksDb(mirror);
	db.ingest(
		[
			{
				def: entityDef(entity),
				objects: [make(id, { SyncToken: opts.mirrorSyncToken ?? '0' })],
			},
		],
		{ syncedAt: '2026-01-20T00:00:00.000Z' },
	);
	db.close();

	const openQb = createQbAccess({ config, realmId: mock.realmId, store, now });
	return {
		mock,
		mirror,
		openQb,
		cleanup: () => {
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function lineAccount(obj: Record<string, unknown>): string | undefined {
	const line = (obj.Line as Record<string, unknown>[] | undefined)?.[0];
	const detail = line?.AccountBasedExpenseLineDetail as
		| { AccountRef?: { value?: string } }
		| undefined;
	return detail?.AccountRef?.value;
}

describe('recategorizeExpense', () => {
	test('moves the expense line in QuickBooks and folds it into the mirror', async () => {
		const { mock, mirror, openQb, cleanup } = await setup();

		const { data, error } = await recategorizeExpense({
			openQb,
			mirror,
			readOnly: false,
			input: {
				entity: 'Purchase',
				id: 'p1',
				account_id: '77',
				account_name: 'Cloud Infrastructure',
			},
		});
		expect(error).toBeNull();
		expect(data?.changed[0]?.toAccount).toBe('Cloud Infrastructure');
		expect(mock.hits.update).toBe(1);

		// The sparse body carries Purchase's mandatory top-level fields (a Line-only
		// body is a 400 ValidationFault, code 2020). AccountRef here is the header
		// bank/CC account paid from, NOT the line-level expense category being moved.
		const sent = mock.updates[0];
		expect(sent?.entity).toBe('Purchase');
		expect(sent?.body.sparse).toBe(true);
		expect(sent?.body.PaymentType).toBe('CreditCard');
		expect(sent?.body.AccountRef).toEqual({
			value: '35',
			name: 'Mercury Checking',
		});

		// QuickBooks (the source of truth) now has the new category + a bumped token.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('77');
		expect(remote?.SyncToken).toBe('1');

		// The mirror reflects the authoritative response (token '1', not the old '0').
		const db = openBooksDb(mirror);
		const row = db.raw
			.query<{ raw: string }, []>(`SELECT raw FROM purchases WHERE id = 'p1'`)
			.get();
		const mirrored = JSON.parse(row?.raw ?? '{}');
		expect(lineAccount(mirrored)).toBe('77');
		expect(mirrored.SyncToken).toBe('1');
		db.close();

		cleanup();
	});

	test('recategorizes a Bill, carrying its VendorRef through the sparse update', async () => {
		const { mock, mirror, openQb, cleanup } = await setup({
			entity: 'Bill',
			id: 'b1',
		});

		const { data, error } = await recategorizeExpense({
			openQb,
			mirror,
			readOnly: false,
			input: {
				entity: 'Bill',
				id: 'b1',
				account_id: '24',
				account_name: 'Utilities',
			},
		});
		expect(error).toBeNull();
		expect(data?.changed[0]?.toAccount).toBe('Utilities');
		expect(mock.hits.update).toBe(1);

		// A Bill without VendorRef is a 400 ValidationFault (code 2020); the sparse
		// body must carry it through unchanged even though only the Line changes.
		const sent = mock.updates[0];
		expect(sent?.entity).toBe('Bill');
		expect(sent?.body.sparse).toBe(true);
		expect(sent?.body.VendorRef).toEqual({
			value: '56',
			name: 'Norton Lumber and Building Materials',
		});

		// QuickBooks now has the new category + a bumped token, folded into the mirror.
		const remote = mock.get('Bill', 'b1');
		expect(remote && lineAccount(remote)).toBe('24');
		expect(remote?.SyncToken).toBe('1');

		const db = openBooksDb(mirror);
		const row = db.raw
			.query<{ raw: string }, []>(`SELECT raw FROM bills WHERE id = 'b1'`)
			.get();
		const mirrored = JSON.parse(row?.raw ?? '{}');
		expect(lineAccount(mirrored)).toBe('24');
		expect(mirrored.SyncToken).toBe('1');
		db.close();

		cleanup();
	});

	test('a stale SyncToken is rejected, leaving QuickBooks untouched', async () => {
		// Mirror thinks the token is '0'; QuickBooks has moved on to '5'.
		const { mock, mirror, openQb, cleanup } = await setup({
			mockSyncToken: '5',
			mirrorSyncToken: '0',
		});

		const { error } = await recategorizeExpense({
			openQb,
			mirror,
			readOnly: false,
			input: { entity: 'Purchase', id: 'p1', account_id: '77' },
		});
		expect(error).not.toBeNull();

		// QuickBooks kept the original category: no clobber on a stale write.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('60');
		expect(remote?.SyncToken).toBe('5');
		cleanup();
	});

	test('errors clearly when the transaction is not in the mirror', async () => {
		const { mirror, openQb, cleanup } = await setup();
		const { error } = await recategorizeExpense({
			openQb,
			mirror,
			readOnly: false,
			input: { entity: 'Purchase', id: 'does-not-exist', account_id: '77' },
		});
		expect(error?.message).toContain('mirror');
		cleanup();
	});

	test('refuses the write in read-only mode, leaving QuickBooks untouched', async () => {
		const { mock, mirror, openQb, cleanup } = await setup();
		const { error } = await recategorizeExpense({
			openQb,
			mirror,
			readOnly: true,
			input: { entity: 'Purchase', id: 'p1', account_id: '77' },
		});
		// The gate fires before any QuickBooks call: refused, nothing moved.
		expect(error?.message).toContain('read-only');
		expect(mock.hits.update).toBe(0);
		cleanup();
	});
});
