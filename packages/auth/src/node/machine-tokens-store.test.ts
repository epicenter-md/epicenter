/**
 * Machine tokens store tests.
 *
 * Covers the file-backed PersistedAuth cell at `~/.epicenter/auth.json`:
 * round trip, file mode 0o600, parent directory 0o700, atomic rename,
 * corrupt blob -> Ok(null), permissions-too-open refusal.
 */

import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expectErr, expectOk } from '@epicenter/test-utils/result';

import type { PersistedAuth } from '../auth-types.js';
import {
	loadMachineTokens,
	saveMachineTokens,
} from './machine-tokens-store.js';

const cleanupPaths: string[] = [];

function tmpAuthPath() {
	const dir = path.join(os.tmpdir(), `epicenter-test-${randomUUID()}`);
	const filePath = path.join(dir, 'auth.json');
	cleanupPaths.push(dir);
	return filePath;
}

afterEach(async () => {
	while (cleanupPaths.length) {
		const dir = cleanupPaths.pop()!;
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

const keyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

function makeCell(subject = 'user-1'): PersistedAuth {
	return {
		grant: {
			accessToken: 'a',
			refreshToken: 'r',
			accessTokenExpiresAt: 1_700_000_000_000,
		},
		localIdentity: { subject, keyring: [...keyring] },
	};
}

test('round trip: save then load returns the same PersistedAuth', async () => {
	const filePath = tmpAuthPath();
	const cell = makeCell();
	const saved = await saveMachineTokens(cell, { filePath });
	expectOk(saved);
	const loaded = await loadMachineTokens({ filePath });
	const loadedData = expectOk(loaded);
	expect(loadedData).toEqual(cell);
});

test('save writes file with mode 0o600 and parent dir 0o700', async () => {
	if (process.platform === 'win32') return;
	const filePath = tmpAuthPath();
	await saveMachineTokens(makeCell(), { filePath });
	const fileStat = await fs.stat(filePath);
	expect(fileStat.mode & 0o777).toBe(0o600);
	const dirStat = await fs.stat(path.dirname(filePath));
	expect(dirStat.mode & 0o777).toBe(0o700);
});

test('save(null) removes the file; subsequent load returns Ok(null)', async () => {
	const filePath = tmpAuthPath();
	await saveMachineTokens(makeCell(), { filePath });
	const cleared = await saveMachineTokens(null, { filePath });
	expectOk(cleared);
	const loaded = await loadMachineTokens({ filePath });
	const loadedData = expectOk(loaded);
	expect(loadedData).toBeNull();
});

test('load against a missing file returns Ok(null)', async () => {
	const filePath = tmpAuthPath();
	const loaded = await loadMachineTokens({ filePath });
	const loadedData = expectOk(loaded);
	expect(loadedData).toBeNull();
});

test('load against corrupt JSON returns Ok(null)', async () => {
	const filePath = tmpAuthPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await fs.writeFile(filePath, '{not valid json', { mode: 0o600 });
	const loaded = await loadMachineTokens({ filePath });
	const loadedData = expectOk(loaded);
	expect(loadedData).toBeNull();
});

test('load refuses when permissions are too open', async () => {
	if (process.platform === 'win32') return;
	const filePath = tmpAuthPath();
	await saveMachineTokens(makeCell(), { filePath });
	await fs.chmod(filePath, 0o644);
	const loaded = await loadMachineTokens({ filePath });
	const error = expectErr(loaded);
	expect(error.name).toBe('PermissionsTooOpen');
});
