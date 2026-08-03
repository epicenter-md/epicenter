/**
 * Local Mail CLI Parser Tests
 *
 * Covers parse-time argument validation that protects command handlers from
 * ambiguous or unsafe flag values, plus the refusals a triage verb and a
 * discard make before touching anything.
 *
 * Key behaviors:
 * - `--watch` accepts only positive millisecond values
 * - invalid watch intervals fail before the reconcile loop can start polling
 * - `discard` refuses without `--all` and creates no durable file
 */

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDataDir } from '@epicenter/constants/app-data';
import { parseArgs, runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { openIntentDb, readPendingSummary } from './intent.ts';
import { acquireReconcileLock } from './lock.ts';
import { accountDir } from './paths.ts';
import { createFileTokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

test('--watch rejects unit-suffixed intervals', () => {
	expect(() => parseArgs(['reconcile', '--watch=30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch rejects zero milliseconds', () => {
	expect(() => parseArgs(['reconcile', '--watch=0'])).toThrow(
		'Invalid --watch interval "0"',
	);
});

test('--watch accepts a space-separated interval', () => {
	const args = parseArgs(['reconcile', '--watch', '5000']);
	expect(args.watch).toBe(true);
	expect(args.watchIntervalMs).toBe(5000);
	expect(args.positionals).toEqual([]);
});

test('--watch space form validates the value instead of swallowing it', () => {
	expect(() => parseArgs(['reconcile', '--watch', '30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch followed by another flag stays flag-only', () => {
	const args = parseArgs(['reconcile', '--watch', '--full']);
	expect(args.watch).toBe(true);
	expect(args.full).toBe(true);
	expect(args.watchIntervalMs).toBeUndefined();
});

test('app parses the port flag', () => {
	const args = parseArgs(['app', '--port', '4177']);
	expect(args.command).toBe('app');
	expect(args.port).toBe(4177);
	expect(() => parseArgs(['app', '--port', 'abc'])).toThrow(
		'--port must be a non-negative integer, got "NaN"',
	);
});

test('triage verbs collect ids as positionals', () => {
	const args = parseArgs(['mark-read', 'm1', 'm2']);
	expect(args.command).toBe('mark-read');
	expect(args.positionals).toEqual(['m1', 'm2']);
	expect(args.addLabels).toEqual([]);
	expect(args.removeLabels).toEqual([]);
});

test('label parses repeatable label changes and --json', () => {
	const args = parseArgs([
		'label',
		'm1',
		'm2',
		'--add',
		'Work',
		'--add=Label_2',
		'--remove',
		'Travel',
		'--json',
	]);
	expect(args.command).toBe('label');
	expect(args.positionals).toEqual(['m1', 'm2']);
	expect(args.addLabels).toEqual(['Work', 'Label_2']);
	expect(args.removeLabels).toEqual(['Travel']);
	expect(args.json).toBe(true);
});

test('LOCAL_MAIL_READ_ONLY enables read-only config mode', () => {
	const previous = process.env.LOCAL_MAIL_READ_ONLY;
	process.env.LOCAL_MAIL_READ_ONLY = '1';
	try {
		expect(loadConfig().readOnly).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.LOCAL_MAIL_READ_ONLY;
		else process.env.LOCAL_MAIL_READ_ONLY = previous;
	}
});

test('label honors LOCAL_MAIL_READ_ONLY before resolving labels', async () => {
	const root = mkdtempSync(join(tmpdir(), 'local-mail-cli-readonly-test-'));
	const dir = appDataDir(root, 'local-mail');
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousRoot = process.env.EPICENTER_DATA_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const previousReadOnly = process.env.LOCAL_MAIL_READ_ONLY;
	const errors: string[] = [];
	const originalError = console.error;
	process.env.EPICENTER_DATA_DIR = root;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	process.env.LOCAL_MAIL_READ_ONLY = '1';
	console.error = (message?: unknown) => {
		errors.push(String(message));
	};
	try {
		expect(await runCli(['label', 'm1', '--add', 'Missing Label'])).toBe(1);
		expect(errors.join('\n')).toContain('Refusing to write: read-only mode');
		expect(errors.join('\n')).not.toContain('Unknown Gmail label');
	} finally {
		console.error = originalError;
		if (previousRoot === undefined) delete process.env.EPICENTER_DATA_DIR;
		else process.env.EPICENTER_DATA_DIR = previousRoot;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		if (previousReadOnly === undefined) delete process.env.LOCAL_MAIL_READ_ONLY;
		else process.env.LOCAL_MAIL_READ_ONLY = previousReadOnly;
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Drive `runCli` against a stored account, capturing both streams and the
 * durable state the run left behind.
 *
 * `holdLock` decides whether another owner (the open app, a watch loop) already
 * has the account's reconcile lock when the command runs. That one flag covers
 * both halves of every ownership contract here: the busy yield and the path that
 * actually gets to do the work.
 *
 * `seedPending` writes undelivered assertions first, so a test can prove what a
 * refused command did NOT do to them.
 */
async function runCliOnAccount(
	argv: string[],
	{
		holdLock = false,
		seedPending = 0,
	}: { holdLock?: boolean; seedPending?: number } = {},
): Promise<{
	code: number;
	stdout: string[];
	stderr: string[];
	/** Whether the run left a durable intent store behind. Read here, before the
	 * temp dir is removed, so a caller cannot assert it vacuously. */
	intentDbExists: boolean;
	/** Undelivered assertions after the run, read the same way. */
	pendingAfter: number;
}> {
	const root = mkdtempSync(join(tmpdir(), 'local-mail-cli-lock-test-'));
	const dir = appDataDir(root, 'local-mail');
	const accountEmail = 'you@example.com';
	const token: TokenSet = {
		accountEmail,
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);

	if (seedPending > 0) {
		const intent = openIntentDb({ dataDir: dir, accountEmail });
		intent.assert(
			Array.from({ length: seedPending }, (_, i) => ({
				messageId: `m${i}`,
				labelId: 'INBOX',
				want: false,
			})),
			'2026-08-01T10:00:00.000Z',
		);
		intent.close();
	}

	const previousRoot = process.env.EPICENTER_DATA_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	process.env.EPICENTER_DATA_DIR = root;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	console.log = (message?: unknown) => {
		stdout.push(String(message));
	};
	console.error = (message?: unknown) => {
		stderr.push(String(message));
	};
	const held = holdLock
		? acquireReconcileLock({ dataDir: dir, accountEmail })
		: null;
	if (holdLock) expect(held).not.toBeNull();
	try {
		const code = await runCli(argv);
		return {
			code,
			stdout,
			stderr,
			intentDbExists: existsSync(
				join(accountDir(dir, accountEmail), 'intent.db'),
			),
			pendingAfter: readPendingSummary({ dataDir: dir, accountEmail })
				.assertions,
		};
	} finally {
		console.log = originalLog;
		console.error = originalError;
		held?.release();
		if (previousRoot === undefined) delete process.env.EPICENTER_DATA_DIR;
		else process.env.EPICENTER_DATA_DIR = previousRoot;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		rmSync(root, { recursive: true, force: true });
	}
}

test('reconcile yields a human note on stdout when another owner holds the lock', async () => {
	const { code, stdout } = await runCliOnAccount(['reconcile'], {
		holdLock: true,
	});
	expect(code).toBe(0);
	// The terminal outcome lands on stdout like the success/failure summaries do.
	expect(stdout.join('\n')).toContain('already reconciling you@example.com');
});

test('reconcile --json yields a structured payload on stdout when the lock is held', async () => {
	const { code, stdout } = await runCliOnAccount(['reconcile', '--json'], {
		holdLock: true,
	});
	expect(code).toBe(0);
	// The whole yield must be a single clean JSON value on stdout, not a human
	// note on stderr: a --json consumer piping stdout has to see it.
	const payload = JSON.parse(stdout.join('\n'));
	expect(payload.reconciled).toBe(false);
	expect(payload.reason).toBe('reconcile-owner-active');
	expect(payload.message).toContain('you@example.com');
});

test('discard refuses without --all and leaves no durable file behind', async () => {
	// Discard is the only thing that drops a recorded change without delivering
	// it, so it is deliberately not the default shape of the verb. The refusal
	// also has to be a read-nothing path: asking about an account that never
	// triaged must not create its intent store (ADR-0198).
	const { code, stderr, intentDbExists } = await runCliOnAccount(['discard']);
	expect(code).toBe(1);
	expect(stderr.join('\n')).toContain('Refusing to discard without --all');
	expect(intentDbExists).toBe(false);
});

test('discard --all reports that there was nothing to discard', async () => {
	const { code, stdout, intentDbExists } = await runCliOnAccount([
		'discard',
		'--all',
	]);
	expect(code).toBe(0);
	expect(stdout.join('\n')).toContain('Nothing to discard for you@example.com');
	expect(intentDbExists).toBe(false);
});

test('discard --all abandons what is owed when it owns the account', async () => {
	const { code, stdout, pendingAfter } = await runCliOnAccount(
		['discard', '--all'],
		{ seedPending: 3 },
	);
	expect(code).toBe(0);
	expect(stdout.join('\n')).toContain('Discarded 3 undelivered change(s)');
	expect(pendingAfter).toBe(0);
});

test('discard --all refuses while a reconciler holds the account, and keeps every assertion', async () => {
	// The race this closes: a reconciler snapshots the pending set when its drain
	// starts, so a discard landing mid-pass would delete rows that pass is still
	// holding and about to send. The report would say the change was abandoned
	// while Gmail was being told the opposite. Taking the same lock makes the
	// promise true, and the refusal is loud rather than a silent no-op.
	const { code, stderr, pendingAfter } = await runCliOnAccount(
		['discard', '--all'],
		{ holdLock: true, seedPending: 2 },
	);
	// Nonzero, unlike a busy reconcile: nobody discards on your behalf, so this
	// is work that did not happen rather than work someone else is doing.
	expect(code).toBe(1);
	expect(stderr.join('\n')).toContain('Refusing to discard');
	expect(stderr.join('\n')).toContain('already reconciling you@example.com');
	expect(pendingAfter).toBe(2);
});

test('discard --all --json yields the established busy payload when the lock is held', async () => {
	const { code, stderr, pendingAfter } = await runCliOnAccount(
		['discard', '--all', '--json'],
		{ holdLock: true, seedPending: 1 },
	);
	expect(code).toBe(1);
	// Same discriminant and machine token a busy reconcile uses: it is the same
	// ownership question, so a consumer branches on it the same way.
	const payload = JSON.parse(stderr.join('\n'));
	expect(payload.reconciled).toBe(false);
	expect(payload.reason).toBe('reconcile-owner-active');
	expect(pendingAfter).toBe(1);
});

test('status --json resolves the sole stored account and prints JSON', async () => {
	const root = mkdtempSync(join(tmpdir(), 'local-mail-cli-test-'));
	const dir = appDataDir(root, 'local-mail');
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousRoot = process.env.EPICENTER_DATA_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const logs: string[] = [];
	const originalLog = console.log;
	process.env.EPICENTER_DATA_DIR = root;
	process.env.LOCAL_MAIL_ACCOUNT = '';
	process.env.LOCAL_MAIL_TOKEN_FILE = '';
	console.log = (message?: unknown) => {
		logs.push(String(message));
	};
	try {
		expect(await runCli(['status', '--json'])).toBe(0);
		expect(JSON.parse(logs[0] ?? '{}').accountEmail).toBe('you@example.com');
	} finally {
		console.log = originalLog;
		if (previousRoot === undefined) delete process.env.EPICENTER_DATA_DIR;
		else process.env.EPICENTER_DATA_DIR = previousRoot;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		rmSync(root, { recursive: true, force: true });
	}
});
