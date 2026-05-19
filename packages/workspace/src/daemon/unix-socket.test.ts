/**
 * Unix Socket Binding Tests
 *
 * Verifies the filesystem and recovery contract around Bun unix-socket
 * listeners. Route behavior lives in `app.ts`; this file pins the binding,
 * hardening, orphan recovery, and best-effort cleanup behavior.
 *
 * Key behaviors:
 * - bound sockets route requests and use mode 0600
 * - graceful server stop removes the socket file
 * - responsive existing sockets return AlreadyRunning with metadata pid
 * - orphan socket files and stale metadata are swept before rebinding
 * - manual socket unlink is best-effort when the file is already gone
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from '@epicenter/test-utils/result';

import { Hono } from 'hono';

import { writeMetadata } from './metadata';
import { metadataPathFor, socketPathFor } from './paths';
import { unlinkSocketFile } from './runtime-files';
import { bindOrRecover, bindUnixSocket } from './unix-socket';

let socketPath: string;
let servers: Bun.Server<undefined>[] = [];
const fetchOk = () => new Response('ok');

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-unix-socket-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(() => {
	for (const server of servers) {
		void server.stop(true).catch(() => {
			// already stopped
		});
	}
});

describe('bindUnixSocket', () => {
	test('binds the socket and routes through to the Hono app', async () => {
		const app = new Hono().post('/ping', (c) => c.json({ ok: true }));

		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test('socket file is created with mode 0600', async () => {
		const server = bindUnixSocket({
			socketPath,
			fetch: fetchOk,
		});
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('server.stop() unlinks the socket file', async () => {
		const server = bindUnixSocket({
			socketPath,
			fetch: fetchOk,
		});
		expect(existsSync(socketPath)).toBe(true);

		await server.stop(true);
		// Bun.serve auto-unlinks; sweep best-effort just in case.
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});

	test('unknown route returns 404 (Hono default)', async () => {
		const app = new Hono().post('/ping', (c) => c.text('ok'));
		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const res = await fetch('http://daemon/nope', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(404);
	});

	test('unlinkSocketFile ignores an already-missing socket file', () => {
		expect(existsSync(socketPath)).toBe(false);
		expect(() => unlinkSocketFile(socketPath)).not.toThrow();
	});
});

describe('bindOrRecover', () => {
	let originalXdg: string | undefined;
	let runtimeRoot: string;
	let workDir: string;

	beforeEach(() => {
		originalXdg = process.env.XDG_RUNTIME_DIR;
		runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-'));
		process.env.XDG_RUNTIME_DIR = runtimeRoot;
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
		workDir = mkdtempSync(join(tmpdir(), 'ep-d-'));
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = originalXdg;
		rmSync(runtimeRoot, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	test('clean bind: succeeds and returns the server', async () => {
		const sock = socketPathFor(workDir);
		const server = expectOk(
			await bindOrRecover({
				socketPath: sock,
				projectDir: workDir,
				fetch: fetchOk,
				isSocketResponsive: async () => false,
			}),
		);
		servers.push(server);
		expect(existsSync(sock)).toBe(true);
	});

	test('ping-finds-occupant: returns AlreadyRunning with metadata pid', async () => {
		const sock = socketPathFor(workDir);
		const occupant = bindUnixSocket({
			socketPath: sock,
			fetch: fetchOk,
		});
		servers.push(occupant);
		writeMetadata(workDir, {
			pid: 4242,
			dir: workDir,
			startedAt: new Date(0).toISOString(),
			cliVersion: '0.0.0-test',
			discoveredAt: new Date(0).toISOString(),
		});

		const error = expectErr(
			await bindOrRecover({
				socketPath: sock,
				projectDir: workDir,
				fetch: fetchOk,
				isSocketResponsive: async () => true,
			}),
		);
		if (error.name === 'AlreadyRunning') {
			expect(error.pid).toBe(4242);
		} else {
			throw new Error('expected AlreadyRunning');
		}
	});

	test('orphan recovery: phantom socket + metadata get swept and bind succeeds', async () => {
		const sock = socketPathFor(workDir);
		// Phantom socket file with no listener (kill -9'd predecessor).
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
		await Bun.write(sock, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
			startedAt: new Date(0).toISOString(),
			cliVersion: '0.0.0-test',
			discoveredAt: new Date(0).toISOString(),
		});

		const server = expectOk(
			await bindOrRecover({
				socketPath: sock,
				projectDir: workDir,
				fetch: fetchOk,
				isSocketResponsive: async () => false,
			}),
		);
		servers.push(server);
		expect(existsSync(sock)).toBe(true);
		// Stale metadata is swept on the recovery branch.
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
	});
});
