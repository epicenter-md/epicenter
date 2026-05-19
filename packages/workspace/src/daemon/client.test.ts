/**
 * `daemonClient` is the typed `hc<DaemonApp>` wrapper consumers use. These
 * tests stand up a real Hono app on a real unix socket and exercise the
 * client's transport-error mapping (the typed inputs/outputs are checked
 * by the compiler).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from '@epicenter/test-utils/result';

import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';

import { daemonClient, pingDaemon } from './client';
import { bindUnixSocket } from './unix-socket';

let socketPath: string;
let servers: Bun.Server<undefined>[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-daemon-client-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
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

describe('pingDaemon', () => {
	test('returns true against a live ping route, false after server stops', async () => {
		const app = new Hono().post('/ping', (c) => c.json(Ok('pong')));
		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		expect(await pingDaemon(socketPath)).toBe(true);

		await server.stop(true);
		servers = [];

		expect(await pingDaemon(socketPath)).toBe(false);
	});

	test('returns false against a missing socket', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		expect(await pingDaemon(missing)).toBe(false);
	});
});

// Transport-mapping coverage. We use `/peers` as the convenient probe route
// because the actual `daemonClient` no longer exposes a `.ping()` method
// (production callers use the boolean `pingDaemon` instead).
describe('daemonClient', () => {
	test('peers resolves to the rows on success', async () => {
		const app = new Hono().post('/peers', (c) => c.json(Ok([])));
		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const data = expectOk(await daemonClient(socketPath).peers());
		expect(data).toEqual([]);
	});

	test('returns Unreachable when socket is missing', async () => {
		const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.sock`);
		const error = expectErr(await daemonClient(missing).peers());
		expect(error.name).toBe('Unreachable');
	});

	test('returns Timeout when route hangs past the deadline', async () => {
		const app = new Hono().post('/peers', () => new Promise(() => {}));
		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const error = expectErr(await daemonClient(socketPath, 100).peers());
		expect(error.name).toBe('Timeout');
	});

	test('returns HandlerCrashed on a 500 from the daemon', async () => {
		const app = new Hono().post('/peers', () => {
			throw new Error('kaboom');
		});
		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const error = expectErr(await daemonClient(socketPath).peers());
		expect(error.name).toBe('HandlerCrashed');
	});
});
