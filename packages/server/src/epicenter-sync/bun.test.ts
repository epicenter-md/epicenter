/**
 * Bun Epicenter Sync Composition Tests
 *
 * Verifies the mounted Bun runtime across authentication, scalar exchange, and
 * document upgrade boundaries with one principal-owned SQLite authority.
 *
 * Key behaviors:
 * - Missing bearer credentials never reach the scalar authority
 * - A scalar batch round-trips through the mounted POST route
 * - A document bearer resolves during upgrade and binds the live row address
 */
import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Principal } from '@epicenter/auth';
import { batchDigest } from '@epicenter/data/protocol';
import {
	DOCUMENT_SUBPROTOCOL,
	encodeDocumentFrame,
} from '@epicenter/document-sync';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import type { Server, ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';

import type { Env } from '../types.js';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './bun.js';
import type { BunEpicenterDocumentSocketData } from './document-bun.js';

const PRINCIPAL_ID = asPrincipalId('alice');
const KEY = 'so.epicenter.tests.documents';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-sync-bun-route-'));
	const runtime = createBunEpicenterSyncRuntime({ dir });
	const upgrades: BunEpicenterDocumentSocketData[] = [];
	runtime.bindServer({
		upgrade(
			_request: Request,
			options?: { data?: BunEpicenterDocumentSocketData },
		) {
			upgrades.push(options?.data as BunEpicenterDocumentSocketData);
			return true;
		},
	} as unknown as Server<BunEpicenterDocumentSocketData>);
	const app = new Hono<Env>();
	mountBunEpicenterSyncApp(app, {
		runtime,
		auth: async (c, next) => {
			if (c.req.header('authorization') !== 'Bearer token') {
				return new Response(null, { status: 401 });
			}
			c.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
		resolveDocumentPrincipal: async (_c, bearer) =>
			bearer === 'token'
				? Ok({
						principal: Principal.assert({ id: PRINCIPAL_ID }),
						authorizationExpiresAt: Date.now() + 60_000,
					})
				: {
						data: null,
						error: {
							name: 'InvalidToken',
							message: 'Invalid token',
							status: 401,
						},
					},
	});
	return {
		app,
		dir,
		runtime,
		upgrades,
		cleanup() {
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function exchange(app: Hono<Env>, body: unknown, authenticated = true) {
	return app.request('/api/sync/v1', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(authenticated ? { authorization: 'Bearer token' } : {}),
		},
		body: JSON.stringify(body),
	});
}

function createRequest() {
	const changes = [
		{
			kind: 'create' as const,
			key: KEY,
			rowId: ROW_ID,
			fields: { title: 'Hello' },
		},
	];
	return {
		replicaId: REPLICA_ID,
		after: 0,
		batch: { seq: 1, digest: batchDigest(changes), changes },
	};
}

test('missing bearer refuses the scalar exchange', async () => {
	const context = setup();
	try {
		const response = await exchange(context.app, createRequest(), false);
		expect(response.status).toBe(401);
		expect(context.upgrades).toEqual([]);
	} finally {
		context.cleanup();
	}
});

test('mounted exchange stores and returns one principal row', async () => {
	const context = setup();
	try {
		const response = await exchange(context.app, createRequest());
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toMatchObject({
			receipt: { seq: 1, appliedThrough: 1 },
			through: 1,
			records: [
				{
					kind: 'row',
					key: KEY,
					rowId: ROW_ID,
					fields: { title: 'Hello' },
				},
			],
			next: null,
		});
	} finally {
		context.cleanup();
	}
});

test('document upgrade resolves the bearer and binds the live row', async () => {
	const context = setup();
	try {
		await exchange(context.app, createRequest());
		const response = await context.app.request(
			`/api/sync/v1/documents/${encodeURIComponent(KEY)}/${ROW_ID}`,
			{
				headers: {
					upgrade: 'websocket',
					'sec-websocket-protocol': `${DOCUMENT_SUBPROTOCOL}, bearer.token`,
				},
			},
		);
		expect(response.status).toBe(200);
		expect(context.upgrades).toHaveLength(1);
		expect(context.upgrades[0]).toMatchObject({
			surface: 'epicenter-document',
			principalId: PRINCIPAL_ID,
			address: { key: KEY, rowId: ROW_ID },
		});
	} finally {
		context.cleanup();
	}
});

test('committed scalar deletion closes the connected document socket', async () => {
	const context = setup();
	try {
		await exchange(context.app, createRequest());
		await context.app.request(
			`/api/sync/v1/documents/${encodeURIComponent(KEY)}/${ROW_ID}`,
			{
				headers: {
					upgrade: 'websocket',
					'sec-websocket-protocol': `${DOCUMENT_SUBPROTOCOL}, bearer.token`,
				},
			},
		);
		const data = context.upgrades[0];
		if (data === undefined) throw new Error('Expected document upgrade data');
		let closed = false;
		const socket = {
			data,
			send: () => 1,
			close: () => {
				closed = true;
			},
		} as unknown as ServerWebSocket<BunEpicenterDocumentSocketData>;
		context.runtime.websocket.open?.(socket);
		context.runtime.websocket.message?.(
			socket,
			Buffer.from(
				encodeDocumentFrame({
					kind: 'sync-request',
					stateVector: Y.encodeStateVector(new Y.Doc()),
				}),
			),
		);

		const changes = [{ kind: 'delete' as const, key: KEY, rowId: ROW_ID }];
		const response = await exchange(context.app, {
			replicaId: REPLICA_ID,
			after: 1,
			batch: { seq: 2, digest: batchDigest(changes), changes },
		});
		expect(response.status).toBe(200);
		expect(closed).toBe(true);
	} finally {
		context.cleanup();
	}
});
