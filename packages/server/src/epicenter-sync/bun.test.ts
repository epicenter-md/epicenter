/**
 * Bun Epicenter Sync Composition Tests
 *
 * Verifies the mounted Bun runtime across authentication, scalar exchange, and
 * document publish/pull boundaries with one principal-owned SQLite authority.
 *
 * Key behaviors:
 * - Missing bearer credentials never reach the scalar or document authority
 * - A scalar batch round-trips through the mounted POST route
 * - Document publish and conditional pull share one bearer-authenticated route
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Principal } from '@epicenter/auth';
import { batchDigest } from '@epicenter/data/protocol';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './bun.js';

const PRINCIPAL_ID = asPrincipalId('alice');
const NAMESPACE = 'so.epicenter.tests';
const TABLE = 'documents';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ROW_ADDRESS = {
	kind: 'row',
	namespace: NAMESPACE,
	tableName: TABLE,
	rowId: ROW_ID,
} as const;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-sync-bun-route-'));
	const runtime = createBunEpicenterSyncRuntime({ dir });
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
	});
	return {
		app,
		dir,
		runtime,
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
	const intents = [
		{
			verb: 'patch' as const,
			address: ROW_ADDRESS,
			set: { title: 'Hello' },
			unset: [],
		},
	];
	return {
		replicaId: REPLICA_ID,
		after: 0,
		batch: { seq: 1, digest: batchDigest(intents), intents },
	};
}

function documentPath(): string {
	return `/api/sync/v1/documents/${NAMESPACE}/${TABLE}/${ROW_ID}`;
}

function encodeContent(text: string): Uint8Array {
	const authored = new Y.Doc();
	try {
		authored.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(authored));
	} finally {
		authored.destroy();
	}
}

test('missing bearer refuses the scalar exchange and document routes', async () => {
	const context = setup();
	try {
		const scalar = await exchange(context.app, createRequest(), false);
		expect(scalar.status).toBe(401);
		const publish = await context.app.request(documentPath(), {
			method: 'POST',
			body: encodeContent('nope').slice().buffer as ArrayBuffer,
		});
		expect(publish.status).toBe(401);
		const pull = await context.app.request(documentPath());
		expect(pull.status).toBe(401);
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
			facts: [
				{
					presence: 'present',
					address: ROW_ADDRESS,
					fields: { title: 'Hello' },
				},
			],
			next: null,
		});
	} finally {
		context.cleanup();
	}
});

test('publish then conditional pull round-trips through the mounted routes', async () => {
	const context = setup();
	try {
		await exchange(context.app, createRequest());
		const published = await context.app.request(documentPath(), {
			method: 'POST',
			headers: { authorization: 'Bearer token' },
			body: encodeContent('published body').slice().buffer as ArrayBuffer,
		});
		expect(published.status).toBe(200);
		expect((await published.json()) as unknown).toEqual({
			outcome: 'accepted',
		});

		const pulled = await context.app.request(documentPath(), {
			headers: { authorization: 'Bearer token' },
		});
		expect(pulled.status).toBe(200);
		const version = pulled.headers.get('etag');
		expect(version).toMatch(/^"\d+"$/);
		const state = new Uint8Array(await pulled.arrayBuffer());
		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, state);
			expect(hydrated.get('content').toString()).toBe('published body');
		} finally {
			hydrated.destroy();
		}

		// The matching version transfers no body.
		const unchanged = await context.app.request(documentPath(), {
			headers: {
				authorization: 'Bearer token',
				'if-none-match': version ?? '',
			},
		});
		expect(unchanged.status).toBe(304);
	} finally {
		context.cleanup();
	}
});

test('pulling a deleted row reports not-live', async () => {
	const context = setup();
	try {
		await exchange(context.app, createRequest());
		const intents = [{ verb: 'delete' as const, address: ROW_ADDRESS }];
		await exchange(context.app, {
			replicaId: REPLICA_ID,
			after: 1,
			batch: { seq: 2, digest: batchDigest(intents), intents },
		});
		const pulled = await context.app.request(documentPath(), {
			headers: { authorization: 'Bearer token' },
		});
		expect(pulled.status).toBe(404);
		expect((await pulled.json()) as unknown).toEqual({ error: 'not-live' });
	} finally {
		context.cleanup();
	}
});
