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
import { mailMirror, openMailDb } from './db.ts';
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
	expect(status.mirrorPath).toBe(mailMirror(tmp.dir, ACCOUNT).path);
	expect(existsSync(status.mirrorPath)).toBe(false);
	expect(existsSync(join(tmp.dir, ACCOUNT))).toBe(false);
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
	const previousVersion = mailMirror(tmp.dir, ACCOUNT).version - 1;
	const accountDir = join(tmp.dir, ACCOUNT);
	mkdirSync(accountDir, { recursive: true });
	writeFileSync(join(accountDir, `mail.v${previousVersion}.db`), '');
	writeFileSync(join(accountDir, 'lock.db'), '');

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
