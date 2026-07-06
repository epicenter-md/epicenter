/**
 * Local Mail CLI Parser Tests
 *
 * Covers parse-time argument validation that protects command handlers from
 * ambiguous or unsafe flag values.
 *
 * Key behaviors:
 * - `--watch` accepts only positive millisecond values
 * - invalid watch intervals fail before the sync loop can start polling
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modifyExitCode, parseArgs, runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import type { ModifyMessageLabelsOutcome } from './modify.ts';
import { createFileTokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

test('--watch rejects unit-suffixed intervals', () => {
	expect(() => parseArgs(['sync', '--watch=30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch rejects zero milliseconds', () => {
	expect(() => parseArgs(['sync', '--watch=0'])).toThrow(
		'Invalid --watch interval "0"',
	);
});

test('--watch accepts a space-separated interval', () => {
	const args = parseArgs(['sync', '--watch', '5000']);
	expect(args.watch).toBe(true);
	expect(args.watchIntervalMs).toBe(5000);
	expect(args.positionals).toEqual([]);
});

test('--watch space form validates the value instead of swallowing it', () => {
	expect(() => parseArgs(['sync', '--watch', '30s'])).toThrow(
		'Invalid --watch interval "30s"',
	);
});

test('--watch followed by another flag stays flag-only', () => {
	const args = parseArgs(['sync', '--watch', '--full']);
	expect(args.watch).toBe(true);
	expect(args.full).toBe(true);
	expect(args.watchIntervalMs).toBeUndefined();
});

test('app parses browser and port flags', () => {
	const args = parseArgs(['app', '--no-open', '--port', '4177']);
	expect(args.command).toBe('app');
	expect(args.noOpen).toBe(true);
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

test('modifyExitCode is nonzero on any per-id failure or systemic abort', () => {
	const clean: ModifyMessageLabelsOutcome = {
		results: [{ id: 'm1', labelIds: ['INBOX'], folded: true, error: null }],
		aborted: null,
	};
	const perId: ModifyMessageLabelsOutcome = {
		results: [
			{ id: 'm1', labelIds: ['INBOX'], folded: true, error: null },
			{
				id: 'm2',
				labelIds: null,
				folded: false,
				error: { name: 'Http', message: 'not found' },
			},
		],
		aborted: null,
	};
	const aborted: ModifyMessageLabelsOutcome = {
		results: [{ id: 'm1', labelIds: ['INBOX'], folded: true, error: null }],
		aborted: { name: 'Throttled', message: 'slow down' },
	};
	expect(modifyExitCode(clean)).toBe(0);
	expect(modifyExitCode(perId)).toBe(1);
	expect(modifyExitCode(aborted)).toBe(1);
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
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-cli-readonly-test-'));
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousDir = process.env.LOCAL_MAIL_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const previousReadOnly = process.env.LOCAL_MAIL_READ_ONLY;
	const errors: string[] = [];
	const originalError = console.error;
	process.env.LOCAL_MAIL_DIR = dir;
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
		if (previousDir === undefined) delete process.env.LOCAL_MAIL_DIR;
		else process.env.LOCAL_MAIL_DIR = previousDir;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		if (previousReadOnly === undefined) delete process.env.LOCAL_MAIL_READ_ONLY;
		else process.env.LOCAL_MAIL_READ_ONLY = previousReadOnly;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('status --json resolves the sole stored account and prints JSON', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-cli-test-'));
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
	const previousDir = process.env.LOCAL_MAIL_DIR;
	const previousAccount = process.env.LOCAL_MAIL_ACCOUNT;
	const previousTokenFile = process.env.LOCAL_MAIL_TOKEN_FILE;
	const logs: string[] = [];
	const originalLog = console.log;
	process.env.LOCAL_MAIL_DIR = dir;
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
		if (previousDir === undefined) delete process.env.LOCAL_MAIL_DIR;
		else process.env.LOCAL_MAIL_DIR = previousDir;
		if (previousAccount === undefined) delete process.env.LOCAL_MAIL_ACCOUNT;
		else process.env.LOCAL_MAIL_ACCOUNT = previousAccount;
		if (previousTokenFile === undefined)
			delete process.env.LOCAL_MAIL_TOKEN_FILE;
		else process.env.LOCAL_MAIL_TOKEN_FILE = previousTokenFile;
		rmSync(dir, { recursive: true, force: true });
	}
});
