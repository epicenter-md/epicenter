/**
 * Multi-account mail surface tests (`createApiApp`).
 *
 * A host serves every connected mailbox under one origin, so these prove the
 * account-scoped routing: `GET /accounts` lists the loaded set,
 * `/accounts/:account/*` reads are isolated per account, an unknown `:account`
 * is a 404, and a `POST .../sync` on an account whose loop is owned elsewhere
 * yields busy rather than racing a second bulk pull.
 *
 * Paths carry no prefix and requests carry no credential: the app is mounted
 * and authenticated by its host (ADR-0191), so both are the host's to test.
 *
 * Only the read/status/list surface and the sync-busy yield are exercised here
 * (a real Gmail client would be needed for modify/trash); that is the smallest
 * surface that proves N accounts compose under one app.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import { type MailDb, openMailDb } from '../db.ts';
import type { GmailClient } from '../gmail-client.ts';
import type { LocalMailRuntime } from '../runtime.ts';
import type { GmailMessage } from '../schema.ts';
import type { SyncDeps } from '../sync.ts';
import type { TokenStore } from '../token-store.ts';
import { type AccountApi, createApiApp } from './api.ts';

function config(dataDir: string): AppConfig {
	return {
		dataDir,
		apiBase: 'http://localhost:0',
		authorizeUrl: 'http://localhost:0/auth',
		tokenUrl: 'http://localhost:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: join(dataDir, 'credentials.json'),
		account: null,
		readOnly: false,
	};
}

// A store that reports no stored token: status still resolves (reads are
// token-free), it just reports `connected: false`, which these tests do not assert.
const store: TokenStore = {
	async get() {
		return null;
	},
	async listAccounts() {
		return [];
	},
	async set() {},
};

function message(id: string, subject: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: subject }] },
	};
}

/**
 * Build one account's `AccountApi` slice backed by a real on-disk mirror under
 * the shared data dir (the arrangement the host uses: one dir, one subdir per
 * account). `ownsLoop` defaults true; the gate is a passthrough.
 */
function account(
	dataDir: string,
	accountEmail: string,
	seed: { messageId: string; subject: string; label: string },
	ownsLoop = true,
): { api: AccountApi; db: MailDb } {
	const db = openMailDb({ dataDir, accountEmail });
	const syncedAt = '2026-07-08T00:00:00.000Z';
	db.ingestFullPullPage([message(seed.messageId, seed.subject)], syncedAt);
	db.ingestLabels(
		[{ id: seed.label, name: seed.label, type: 'user' }],
		syncedAt,
	);
	db.finishFullPull('1000', syncedAt);
	const runtime: LocalMailRuntime = {
		config: config(dataDir),
		store,
		accountEmail,
	};
	const syncDeps: SyncDeps = {
		db,
		// The read/list/status/busy paths never call the client; a real one is
		// only needed for the modify/trash routes, which are not exercised here.
		client: {} as unknown as GmailClient,
		config: runtime.config,
		now: () => Date.parse(syncedAt),
	};
	return {
		api: { runtime, syncDeps, gate: (fn) => fn(), ownsLoop },
		db,
	};
}

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-api-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function get(app: ReturnType<typeof createApiApp>, path: string) {
	return app.fetch(new Request(`http://127.0.0.1${path}`));
}

describe('createApiApp multi-account routing', () => {
	test('GET /accounts lists every loaded account, sorted', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'b@example.com', {
			messageId: 'mb',
			subject: 'B',
			label: 'LB',
		});
		const b = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([
				['b@example.com', a.api],
				['a@example.com', b.api],
			]),
			readOnly: false,
		});

		const res = await get(app, '/accounts');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			accounts: ['a@example.com', 'b@example.com'],
		});

		a.db.close();
		b.db.close();
		tmp.cleanup();
	});

	test('account-scoped reads are isolated to the named account', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'Alpha',
			label: 'LA',
		});
		const b = account(tmp.dir, 'b@example.com', {
			messageId: 'mb',
			subject: 'Beta',
			label: 'LB',
		});
		const app = createApiApp({
			accounts: new Map([
				['a@example.com', a.api],
				['b@example.com', b.api],
			]),
			readOnly: false,
		});

		const statusA = (await (
			await get(app, '/accounts/a@example.com/status')
		).json()) as {
			accountEmail: string;
			mirror: string;
			rows: { messages: number };
		};
		expect(statusA.accountEmail).toBe('a@example.com');
		expect(statusA.mirror).toBe('ready');
		expect(statusA.rows.messages).toBe(1);

		const messagesB = (await (
			await get(app, '/accounts/b@example.com/messages')
		).json()) as { messages: { id: string }[] };
		expect(messagesB.messages.map((m) => m.id)).toEqual(['mb']);

		const labelsA = (await (
			await get(app, '/accounts/a@example.com/labels')
		).json()) as { labels: { id: string }[] };
		expect(labelsA.labels.map((l) => l.id)).toContain('LA');
		expect(labelsA.labels.map((l) => l.id)).not.toContain('LB');

		a.db.close();
		b.db.close();
		tmp.cleanup();
	});

	test('an unknown account is a 404 AccountNotFound', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
		});

		const res = await get(app, '/accounts/nobody@example.com/status');
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('AccountNotFound');

		a.db.close();
		tmp.cleanup();
	});

	test('POST sync yields busy when this host does not own the account loop', async () => {
		const tmp = tempDir();
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			false,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/accounts/a@example.com/sync', {
				method: 'POST',
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			synced: false,
			reason: 'sync-owner-active',
		});

		a.db.close();
		tmp.cleanup();
	});
});
