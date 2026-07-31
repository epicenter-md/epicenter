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
 * The write routes are exercised against an injected fake Gmail client. That
 * replaces the deleted write-path smoke harness, which stood up a throwaway
 * mirror copy, forged credentials, a mock Gmail server, and a spawned host on a
 * real port to make one write safe to execute. All of that protected a process
 * that read real configuration; a test holding a fake client has nothing real to
 * reach, so it needs none of it, and unlike the harness it runs in CI.
 *
 * What these add over `modify.test.ts`, which already covers the write cores in
 * depth: the route wiring itself. That a modify or trash request reaches the
 * core with the body it was given, that `readOnly` is refused at the route, and
 * that a Gmail failure becomes `ModifyFailed` rather than a 500.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
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
/**
 * A Gmail client that records what the route asked of it and answers from a
 * canned table. Deliberately smaller than `modify.test.ts`'s fake: these tests
 * care that the call was made with the right arguments, not about the error
 * matrix that file already walks.
 */
function fakeGmailClient(options: { fail?: boolean } = {}) {
	const modifyCalls: {
		id: string;
		addLabelIds?: string[];
		removeLabelIds?: string[];
	}[] = [];
	const trashCalls: { id: string; trashed: boolean }[] = [];
	const failure = {
		data: null,
		error: { name: 'GmailApiError' as const, message: 'Gmail refused' },
	};
	const client = {
		modifyCalls,
		trashCalls,
		async modifyMessage(id: string, body: Record<string, string[]>) {
			modifyCalls.push({ id, ...body });
			if (options.fail) return failure;
			return { data: message(id, `subject ${id}`), error: null };
		},
		async trashMessage(id: string) {
			trashCalls.push({ id, trashed: true });
			if (options.fail) return failure;
			return { data: message(id, `subject ${id}`), error: null };
		},
		async untrashMessage(id: string) {
			trashCalls.push({ id, trashed: false });
			if (options.fail) return failure;
			return { data: message(id, `subject ${id}`), error: null };
		},
		async listLabels() {
			// The core resolves a label name or id through the mirror, falling back
			// to one live refresh; INBOX has to come back or archive cannot resolve.
			return {
				data: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
				error: null,
			};
		},
	};
	return client as typeof client & GmailClient;
}

function account(
	dataDir: string,
	accountEmail: string,
	seed: { messageId: string; subject: string; label: string },
	ownsLoop = true,
	client: GmailClient = {} as unknown as GmailClient,
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
		// The read/list/status/busy paths never touch the client, so they pass the
		// unusable default; the write routes pass a fake that records its calls.
		client,
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

	test('modify reaches the core with the labels the request carried', async () => {
		const tmp = tempDir();
		const client = fakeGmailClient();
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			true,
			client,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/accounts/a@example.com/messages/modify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: ['ma'], removeLabels: ['INBOX'] }),
			}),
		);
		expect(res.status).toBe(200);
		// Archive desugars to one remove, and the route hands the core the ids and
		// label sets verbatim rather than reinterpreting them.
		expect(client.modifyCalls).toEqual([
			{ id: 'ma', addLabelIds: [], removeLabelIds: ['INBOX'] },
		]);

		a.db.close();
		tmp.cleanup();
	});

	test('trash carries its direction to the matching Gmail verb', async () => {
		const tmp = tempDir();
		const client = fakeGmailClient();
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			true,
			client,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
		});

		const trash = async (trashed: boolean) =>
			app.fetch(
				new Request('http://127.0.0.1/accounts/a@example.com/messages/trash', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ids: ['ma'], trashed }),
				}),
			);
		expect((await trash(true)).status).toBe(200);
		expect((await trash(false)).status).toBe(200);
		// Gmail models trash and untrash as separate endpoints, so the boolean has
		// to pick one; this is the assertion that it picks the right one.
		expect(client.trashCalls).toEqual([
			{ id: 'ma', trashed: true },
			{ id: 'ma', trashed: false },
		]);

		a.db.close();
		tmp.cleanup();
	});

	test('readOnly refuses a write at the route, before Gmail', async () => {
		const tmp = tempDir();
		const client = fakeGmailClient();
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			true,
			client,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: true,
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/accounts/a@example.com/messages/modify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: ['ma'], removeLabels: ['INBOX'] }),
			}),
		);
		expect(res.status).toBe(400);
		// The point of the kill switch is that nothing reached Gmail, not merely
		// that the caller saw an error.
		expect(client.modifyCalls).toEqual([]);

		a.db.close();
		tmp.cleanup();
	});

	test('a per-message Gmail failure rides inside the outcome, not the status', async () => {
		const tmp = tempDir();
		const client = fakeGmailClient({ fail: true });
		const a = account(
			tmp.dir,
			'a@example.com',
			{ messageId: 'ma', subject: 'A', label: 'LA' },
			true,
			client,
		);
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/accounts/a@example.com/messages/modify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: ['ma'], removeLabels: ['INBOX'] }),
			}),
		);
		// Deliberately a 200. A write is per-id and Gmail-first, so one message
		// failing is a fact about that message, not a failed request: the caller
		// needs to see which ids changed and which did not. `ModifyFailed` is
		// reserved for a systemic refusal, like an unknown label or read-only.
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: { id: string; folded: boolean; error: unknown }[];
		};
		expect(body.results).toHaveLength(1);
		expect(body.results[0]?.id).toBe('ma');
		expect(body.results[0]?.folded).toBe(false);
		expect(body.results[0]?.error).not.toBeNull();

		a.db.close();
		tmp.cleanup();
	});

	test('connect answers with somewhere to send the person, not a finished flow', async () => {
		const tmp = tempDir();
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		const app = createApiApp({
			accounts: new Map([['a@example.com', a.api]]),
			readOnly: false,
			connect: async () =>
				Ok({ authorizeUrl: 'https://accounts.google.com/o/x' }),
		});

		const res = await app.fetch(
			new Request('http://127.0.0.1/connect', { method: 'POST' }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			authorizeUrl: 'https://accounts.google.com/o/x',
		});

		a.db.close();
		tmp.cleanup();
	});

	test('a surface mounted without connect says so instead of pretending', async () => {
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

		const res = await app.fetch(
			new Request('http://127.0.0.1/connect', { method: 'POST' }),
		);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('ConnectUnavailable');

		a.db.close();
		tmp.cleanup();
	});

	test('the account set is read per request, so a later mailbox is servable', async () => {
		const tmp = tempDir();
		// Start empty, which is the first-run state the engine now opens in.
		const accounts = new Map<string, AccountApi>();
		const app = createApiApp({ accounts, readOnly: false });

		expect(await (await get(app, '/accounts')).json()).toEqual({
			accounts: [],
		});

		// What `connect` does once Google redirects back: admit the mailbox.
		const a = account(tmp.dir, 'a@example.com', {
			messageId: 'ma',
			subject: 'A',
			label: 'LA',
		});
		accounts.set('a@example.com', a.api);

		// No rebuild, no restart: the same app now lists and serves it.
		expect(await (await get(app, '/accounts')).json()).toEqual({
			accounts: ['a@example.com'],
		});
		const status = await get(app, '/accounts/a@example.com/status');
		expect(status.status).toBe(200);

		a.db.close();
		tmp.cleanup();
	});
});
