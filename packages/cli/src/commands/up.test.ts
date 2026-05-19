/**
 * Unit-level tests for `epicenter daemon up`.
 *
 * These tests run `runUp` in-process against tiny folder-routed daemon
 * fixtures. They never spawn a child or call `process.exit`; each test owns a
 * temp project, temp runtime root, and temp home.
 *
 * Key behaviors:
 * - happy path discovers workspaces/demo/daemon.ts, writes metadata, binds the
 *   socket, and replies to ping
 * - startup failures release the daemon lease
 * - responsive legacy sockets return AlreadyRunning and dispose opened routes
 * - held SQLite leases short-circuit before daemon module import
 * - orphan socket files are swept and replaced by a fresh daemon
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import {
	claimDaemonLease,
	metadataPathFor,
	pingDaemon,
	socketPathFor,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { runUp } from './up';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let workDir: string;
let homeRoot: string;

function servePingDaemon(socketPath: string): Bun.Server<undefined> {
	const app = new Hono().post('/ping', (c) => c.json(Ok('pong' as const)));
	return Bun.serve({ unix: socketPath, fetch: app.fetch });
}

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;

	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-up-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	homeRoot = mkdtempSync(join(tmpdir(), 'ep-home-'));
	process.env.HOME = homeRoot;
	mkdirSync(join(homeRoot, '.epicenter'), { recursive: true });
	writeFileSync(
		join(homeRoot, '.epicenter', 'auth.json'),
		JSON.stringify({
			grant: {
				accessToken: 'access-stored',
				refreshToken: 'refresh-stored',
				accessTokenExpiresAt: Date.now() + 3_600_000,
			},
			localIdentity: {
				subject: 'user-1',
				keyring: [
					{
						version: 1,
						subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
					},
				],
			},
		}),
		{ mode: 0o600 },
	);

	workDir = mkdtempSync(join(tmpdir(), 'ep-dir-'));
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;

	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

function markerPath(name: string): string {
	return join(workDir, `${name}.marker`);
}

function writeDemoDaemon(source: string): string {
	const dir = join(workDir, 'workspaces', 'demo');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'daemon.ts');
	writeFileSync(path, source);
	return path;
}

function writeRuntimeDaemon({
	onImportMarker,
	onDisposeMarker,
}: {
	onImportMarker?: string;
	onDisposeMarker?: string;
} = {}) {
	writeDemoDaemon(`
		import { writeFileSync } from 'node:fs';
		${onImportMarker ? `writeFileSync(${JSON.stringify(onImportMarker)}, 'imported');` : ''}

		const actions = {};
		const collaboration = {
			actions,
			whenConnected: new Promise(() => {}),
			status: { phase: 'connected' },
			onStatusChange: () => () => {},
			peers: {
				list: () => [],
				find: () => undefined,
				observe: () => () => {},
			},
			dispatch: async () => {
				throw new Error('fixture does not dispatch');
			},
		};

		export default {
			async open() {
				return {
					collaboration,
					async [Symbol.asyncDispose]() {
						${onDisposeMarker ? `writeFileSync(${JSON.stringify(onDisposeMarker)}, 'disposed');` : ''}
					},
				};
			},
		};
	`);
}

describe('runUp: happy path', () => {
	test('writes metadata, binds socket, replies to ping', async () => {
		writeRuntimeDaemon();

		const handle = expectOk(
			await runUp({
				projectDir: workDir,
				quiet: true,
			}),
		);
		try {
			expect(existsSync(metadataPathFor(workDir))).toBe(true);
			expect(handle.metadata.pid).toBe(process.pid);
			expect(handle.metadata.discoveredAt).toEqual(expect.any(String));
			expect(handle.runtimes).toHaveLength(1);
			expect(handle.runtimes[0]?.route).toBe('demo');

			const sockPath = socketPathFor(workDir);
			expect(existsSync(sockPath)).toBe(true);
			const ok = await pingDaemon(sockPath, 1000);
			expect(ok).toBe(true);
		} finally {
			await handle.teardown();
		}
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		expect(existsSync(socketPathFor(workDir))).toBe(false);
	});
});

describe('runUp: failure cleanup', () => {
	test('starts with no routes when no workspace daemon entrypoints exist', async () => {
		mkdirSync(join(workDir, 'workspaces', 'demo'), { recursive: true });

		const handle = expectOk(
			await runUp({
				projectDir: workDir,
				quiet: true,
			}),
		);

		try {
			expect(handle.runtimes).toEqual([]);
		} finally {
			await handle.teardown();
		}
	});

	test('releases the daemon lease when workspace startup fails', async () => {
		writeDemoDaemon(`
			export default {
				async open() {
					throw new Error('route failed');
				},
			};
		`);

		const error = expectErr(
			await runUp({
				projectDir: workDir,
				quiet: true,
			}),
		);

		expect(error.name).toBe('WorkspaceOpenFailed');
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('returns MetadataWriteFailed and tears down when metadata path is blocked', async () => {
		writeRuntimeDaemon();
		mkdirSync(metadataPathFor(workDir));

		const error = expectErr(
			await runUp({
				projectDir: workDir,
				quiet: true,
			}),
		);

		expect(error.name).toBe('MetadataWriteFailed');
		expect(existsSync(socketPathFor(workDir))).toBe(false);
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});
});

describe('runUp: already running', () => {
	test('returns AlreadyRunning when a responsive legacy socket is detected', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		const server = servePingDaemon(sockPath);
		const disposeMarker = markerPath('dispose');
		writeRuntimeDaemon({ onDisposeMarker: disposeMarker });

		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			discoveredAt: new Date().toISOString(),
		});

		try {
			const error = expectErr(
				await runUp({
					projectDir: workDir,
					quiet: true,
				}),
			);
			expect(error).toMatchObject({
				name: 'AlreadyRunning',
				pid: process.pid,
			});
			expect(readFileSync(disposeMarker, 'utf8')).toBe('disposed');
		} finally {
			await server.stop(true).catch(() => {
				// best-effort
			});
		}
	});

	test('does not import workspace daemons when the daemon lease is held', async () => {
		const lease = expectOk(claimDaemonLease(workDir));
		const importMarker = markerPath('import');
		writeRuntimeDaemon({ onImportMarker: importMarker });

		try {
			const error = expectErr(
				await runUp({
					projectDir: workDir,
					quiet: true,
				}),
			);

			expect(error.name).toBe('AlreadyRunning');
			expect(existsSync(importMarker)).toBe(false);
		} finally {
			lease.release();
		}
	});
});

describe('runUp: orphan path', () => {
	test('proceeds cleanly when metadata pid is dead and socket is phantom', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		writeFileSync(sockPath, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			discoveredAt: new Date().toISOString(),
		});
		writeRuntimeDaemon();

		const handle = expectOk(
			await runUp({
				projectDir: workDir,
				quiet: true,
			}),
		);

		try {
			expect(handle.metadata.pid).toBe(process.pid);
			expect(existsSync(socketPathFor(workDir))).toBe(true);
		} finally {
			await handle.teardown();
		}
	});
});
