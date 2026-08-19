/**
 * Local Mail Status Tests
 *
 * Verifies the status report describes the local mirror lifecycle rather than
 * only whether the SQLite file exists.
 *
 * Key behaviors:
 * - missing mirror reports `empty`
 * - mirror file with no history cursor reports `building`
 * - mirror with a history cursor reports `ready`
 * - the report is artifact inventory, not a stored-shape comparison (ADR-0197)
 * - undelivered triage stays visible whether or not a mirror exists, and a
 *   status read never creates the durable store it reports on
 */

import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { mailDbFile, openMailDb } from './db.ts';
import { intentDbPath, openIntentDb } from './intent.ts';
import { accountDir } from './paths.ts';
import type { GmailMessage } from './schema.ts';
import { readMailStatus } from './status.ts';
import type { TokenStore } from './token-store.ts';

const ACCOUNT = 'you@example.com';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-status-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

const store: TokenStore = {
	async get() {
		return null;
	},
	async listAccounts() {
		return [];
	},
	async set() {},
};

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

test('status reports empty when the mirror file does not exist', async () => {
	const tmp = tempDir();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('empty');
	expect(status.historyId).toBeNull();
	expect(status.rows).toEqual({ messages: 0, labels: 0 });
	tmp.cleanup();
});

test('status reports building when the mirror file exists without a cursor', async () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], '2026-07-01T00:00:00.000Z');
	db.close();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('building');
	expect(status.historyId).toBeNull();
	expect(status.rows.messages).toBe(1);
	tmp.cleanup();
});

test('status reports ready when the mirror has a cursor', async () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], '2026-07-01T00:00:00.000Z');
	db.finishFullPull('1000', '2026-07-01T00:00:00.000Z');
	db.close();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('ready');
	expect(status.historyId).toBe('1000');
	expect(status.rows.messages).toBe(1);
	tmp.cleanup();
});

test('status reporting an absent mirror does not create one', async () => {
	const tmp = tempDir();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	// The path is reported so a human can find the file; reporting it must not
	// bring it into existence.
	expect(status.mirrorPath).toBe(mailDbFile(tmp.dir, ACCOUNT).path);
	expect(existsSync(status.mirrorPath)).toBe(false);
	expect(existsSync(accountDir(tmp.dir, ACCOUNT))).toBe(false);
	expect(status.predecessors).toEqual([]);
	tmp.cleanup();
});

test('status lists retained predecessors as inventory, not as a mismatch', async () => {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message('m1')], '2026-07-01T00:00:00.000Z');
	db.finishFullPull('1000', '2026-07-01T00:00:00.000Z');
	db.close();
	// What a version bump leaves behind, plus the siblings the app owns.
	const previousVersion = mailDbFile(tmp.dir, ACCOUNT).version - 1;
	const dir = accountDir(tmp.dir, ACCOUNT);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `mail.v${previousVersion}.db`), '');
	writeFileSync(join(dir, 'lock.db'), '');

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	// The current artifact is still authoritative and still `ready`: a retained
	// predecessor is inventory, and no read path consults it.
	expect(status.mirror).toBe('ready');
	expect(status.rows.messages).toBe(1);
	expect(status.predecessors).toEqual([previousVersion]);
	tmp.cleanup();
});

test('pending assertions stay visible when the mirror is gone', async () => {
	// The mirror is disposable: a corpus-version bump names a new artifact and a
	// reclaim unlinks the old one, and a status call can land in that window. The
	// durable store outlives it on purpose, so a missing mirror must never be
	// read as "nothing is owed": that is exactly when a user needs to see their
	// undelivered work.
	const tmp = tempDir();
	const intent = openIntentDb({ dataDir: tmp.dir, accountEmail: ACCOUNT });
	intent.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		'2026-08-01T10:00:00.000Z',
	);
	intent.close();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.mirror).toBe('empty');
	expect(status.rows).toEqual({ messages: 0, labels: 0 });
	expect(status.pending).toEqual({
		assertions: 1,
		oldestAssertedAt: '2026-08-01T10:00:00.000Z',
	});
	tmp.cleanup();
});

test('a status read reports zero pending without creating the store', async () => {
	const tmp = tempDir();

	const status = await readMailStatus({
		config: config(tmp.dir),
		accountEmail: ACCOUNT,
		store,
	});

	expect(status.pending).toEqual({ assertions: 0, oldestAssertedAt: null });
	// Reading must not conjure a durable file for an account that has none.
	expect(existsSync(intentDbPath(tmp.dir, ACCOUNT))).toBe(false);
	tmp.cleanup();
});
