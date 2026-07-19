/**
 * Workspace Authority Route Tests
 *
 * Proves that route parsing and authentication resolve one account authority
 * from the authenticated principal alone, with the bounded workspace id as an
 * operation argument.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import {
	type AcquireRequest,
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	type PullRequest,
	type PushRequest,
	rowRoundDigest,
} from '@epicenter/row-sync';
import { Hono } from 'hono';
import type {
	AccountAuthorities,
	AccountAuthority,
} from '../records/current-state-contracts.js';
import type { Env } from '../types.js';
import {
	type AdmitFirstContact,
	mountCurrentStateRecordsApp,
} from './current-state-records.js';

type OperationCall = { principalId: PrincipalId; workspaceId: string };

function setup({
	fail,
	admitFirstContact,
	hasReplica = false,
	isAuthenticated = true,
}: {
	fail?: 'deleteWorkspace' | 'hasReplica' | 'push' | 'pull' | 'acquire';
	admitFirstContact?: AdmitFirstContact;
	hasReplica?: boolean;
	isAuthenticated?: boolean;
} = {}) {
	const operationCalls: OperationCall[] = [];
	let authorityResolutions = 0;
	function authority(principalId: PrincipalId): AccountAuthority {
		authorityResolutions += 1;
		return {
			async deleteWorkspace(workspaceId) {
				operationCalls.push({ principalId, workspaceId });
				if (fail === 'deleteWorkspace') throw new TypeError('invalid deletion');
			},
			async deleteAccount() {},
			async hasReplica(workspaceId) {
				operationCalls.push({ principalId, workspaceId });
				if (fail === 'hasReplica')
					throw new TypeError('invalid replica lookup');
				return hasReplica;
			},
			async push(workspaceId, request) {
				operationCalls.push({ principalId, workspaceId });
				if (fail === 'push') throw new TypeError('invalid push');
				return {
					result: 'accepted',
					receipt: {
						acceptedRound: request.round,
						requestDigest: request.requestDigest,
						appliedThrough: request.intents.length,
					},
				};
			},
			async pull(workspaceId, request) {
				operationCalls.push({ principalId, workspaceId });
				if (fail === 'pull') throw new TypeError('invalid pull');
				return {
					result: 'page',
					receipt: {
						acceptedRound: 1,
						requestDigest: 'digest',
						appliedThrough: 1,
					},
					through: request.through ?? 1,
					checkpoint: request.through ?? 1,
					retentionFloor: 0,
					entries: [],
				};
			},
			async acquire(workspaceId) {
				operationCalls.push({ principalId, workspaceId });
				if (fail === 'acquire') throw new TypeError('invalid acquire');
				return {
					result: 'page',
					receipt: {
						acceptedRound: 1,
						requestDigest: 'digest',
						appliedThrough: 1,
					},
					rows: [],
					head: 1,
					retentionFloor: 0,
					hasMore: false,
				};
			},
			async databaseSize() {
				return 0;
			},
			acceptDocumentUpgrade() {
				return new Response(null, { status: 500 });
			},
		};
	}
	const authorities: AccountAuthorities = {
		authority,
		rejectDocumentUpgrade() {
			return new Response(null, { status: 500 });
		},
	};
	const app = new Hono<Env>();
	mountCurrentStateRecordsApp(app, {
		resolveAuthorities: () => authorities,
		admitFirstContact,
		auth: async (c, next) => {
			if (!isAuthenticated) return new Response(null, { status: 401 });
			c.set('principal', {
				id: asPrincipalId(c.req.header('x-test-principal') ?? 'alice'),
			});
			await next();
		},
	});
	return {
		app,
		operationCalls,
		get authorityResolutions() {
			return authorityResolutions;
		},
	};
}

const intents: CurrentStateWireRowIntent[] = [
	{
		kind: 'create',
		table: 'pages',
		rowId: '000000000000000000000001',
		fields: { title: 'Hello' },
	},
];
const push: PushRequest = {
	protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'push',
	replicaId: '000000000000000000000001',
	round: 1,
	requestDigest: rowRoundDigest(intents),
	intents,
};
const pull: PullRequest = {
	protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'pull',
	replicaId: '000000000000000000000001',
	after: 0,
};
const acquire: AcquireRequest = {
	protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'acquire',
	replicaId: '000000000000000000000001',
};

function post(
	app: Hono<Env>,
	suffix: string,
	body: unknown,
	headers?: Record<string, string>,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/workspaces/wiki/records/${suffix}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		}),
	);
}

test('every scalar operation enters one resolved account authority', async () => {
	const context = setup();
	const responses = await Promise.all([
		post(context.app, 'push', push),
		post(context.app, 'pull', pull),
		post(context.app, 'acquire', acquire),
	]);

	expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
	expect(context.operationCalls).toEqual(
		Array.from({ length: 4 }, () => ({
			principalId: asPrincipalId('alice'),
			workspaceId: 'wiki',
		})),
	);
	// One authority resolution per request; push reuses its handle for the
	// replica lookup and the dispatch.
	expect(context.authorityResolutions).toBe(3);
});

test('authenticated principals select independent account authorities', async () => {
	const context = setup();
	await post(context.app, 'pull', pull, { 'x-test-principal': 'alice' });
	await post(context.app, 'pull', pull, { 'x-test-principal': 'bob' });

	expect(context.operationCalls).toEqual([
		{ principalId: asPrincipalId('alice'), workspaceId: 'wiki' },
		{ principalId: asPrincipalId('bob'), workspaceId: 'wiki' },
	]);
});

test('workspace deletion is a mounted authenticated operation', async () => {
	const context = setup();
	const response = await context.app.request('/api/workspaces/wiki', {
		method: 'DELETE',
	});

	expect(response.status).toBe(204);
	expect(context.operationCalls).toEqual([
		{ principalId: asPrincipalId('alice'), workspaceId: 'wiki' },
	]);
});

test('workspace deletion requires authentication and a bounded id', async () => {
	const unauthenticated = setup({ isAuthenticated: false });
	expect(
		(
			await unauthenticated.app.request('/api/workspaces/wiki', {
				method: 'DELETE',
			})
		).status,
	).toBe(401);
	expect(unauthenticated.operationCalls).toEqual([]);

	const context = setup();
	expect(
		(
			await context.app.request(`/api/workspaces/${'w'.repeat(513)}`, {
				method: 'DELETE',
			})
		).status,
	).toBe(400);
	expect(context.operationCalls).toEqual([]);
});

test('the workspace creation route is absent', async () => {
	const context = setup();
	const response = await context.app.request('/api/workspaces/wiki', {
		method: 'PUT',
	});

	expect(response.status).toBe(404);
	expect(context.authorityResolutions).toBe(0);
});

test('the enrollment route is absent', async () => {
	const context = setup();
	const response = await post(context.app, 'enroll', {
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'enroll',
		replicaId: push.replicaId,
	});

	expect(response.status).toBe(404);
	expect(context.authorityResolutions).toBe(0);
	expect(context.operationCalls).toEqual([]);
});

test('authentication protects every data operation', async () => {
	const context = setup({ isAuthenticated: false });
	for (const [method, body] of [
		['push', push],
		['pull', pull],
		['acquire', acquire],
	] as const) {
		expect((await post(context.app, method, body)).status).toBe(401);
	}
	expect(context.operationCalls).toEqual([]);
});

test('invalid bodies and protocol mismatch stop before authority resolution', async () => {
	const context = setup();
	const malformed = await context.app.request(
		'/api/workspaces/wiki/records/push',
		{ method: 'POST', body: '{' },
	);
	const inexact = await post(context.app, 'push', {
		...push,
		principalId: 'mallory',
	});
	const mismatch = await post(context.app, 'pull', {
		...pull,
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR - 1,
	});

	expect(malformed.status).toBe(400);
	expect(inexact.status).toBe(400);
	expect(mismatch.status).toBe(200);
	expect((await mismatch.json()) as unknown).toEqual({
		result: 'protocol-mismatch',
	});
	expect(context.operationCalls).toEqual([]);
	expect(context.authorityResolutions).toBe(0);
});

test('workspace and body bounds stop before authority resolution', async () => {
	const context = setup();
	const oversizedWorkspace = 'w'.repeat(513);
	expect(
		(
			await context.app.request(
				`/api/workspaces/${oversizedWorkspace}/records/pull`,
				{ method: 'POST', body: JSON.stringify(pull) },
			)
		).status,
	).toBe(400);
	expect(
		(
			await post(context.app, 'push', push, {
				'content-length': '1048577',
			})
		).status,
	).toBe(413);
	expect(context.operationCalls).toEqual([]);
	expect(context.authorityResolutions).toBe(0);
});

test('first-contact admission receives the already-resolved authority', async () => {
	const issued: {
		principalId: PrincipalId;
		workspaceId: string;
		accountBytes: number;
	}[] = [];
	const context = setup({
		admitFirstContact: async (_c, { authority, principalId, workspaceId }) => {
			issued.push({
				principalId,
				workspaceId,
				accountBytes: await authority.databaseSize(),
			});
			return 'allow';
		},
	});
	const response = await post(context.app, 'push', push);

	expect(response.status).toBe(200);
	expect(issued).toEqual([
		{
			principalId: asPrincipalId('alice'),
			workspaceId: 'wiki',
			accountBytes: 0,
		},
	]);
	// The admission callback shares the push's single authority resolution.
	expect(context.authorityResolutions).toBe(1);
	expect(context.operationCalls).toEqual([
		{ principalId: asPrincipalId('alice'), workspaceId: 'wiki' },
		{ principalId: asPrincipalId('alice'), workspaceId: 'wiki' },
	]);
});

test('refused first contact returns storage-limit without dispatching push', async () => {
	const context = setup({ admitFirstContact: async () => 'refuse' });
	const response = await post(context.app, 'push', push);

	expect(response.status).toBe(200);
	expect((await response.json()) as unknown).toEqual({
		result: 'storage-limit',
	});
	expect(context.operationCalls).toEqual([
		{ principalId: asPrincipalId('alice'), workspaceId: 'wiki' },
	]);
});

test('known replicas bypass first-contact policy', async () => {
	let policyCalls = 0;
	const context = setup({
		hasReplica: true,
		admitFirstContact: async () => {
			policyCalls += 1;
			return 'refuse';
		},
	});
	expect((await post(context.app, 'push', push)).status).toBe(200);
	expect(policyCalls).toBe(0);
});

test('authority TypeErrors map to invalid-request on every operation', async () => {
	for (const [method, body, fail] of [
		['push', push, 'hasReplica'],
		['push', push, 'push'],
		['pull', pull, 'pull'],
		['acquire', acquire, 'acquire'],
	] as const) {
		const context = setup({ fail });
		expect((await post(context.app, method, body)).status).toBe(400);
	}
});

test('the old records route is absent', async () => {
	const context = setup();
	expect(
		(
			await context.app.request('/api/records/wiki/pull', {
				method: 'POST',
				body: JSON.stringify(pull),
			})
		).status,
	).toBe(404);
	expect(context.operationCalls).toEqual([]);
});

test('new production modules never call deleted authority operations', () => {
	for (const path of [
		'../records/current-state-bun.ts',
		'../records/current-state-cloudflare.ts',
		'../records/current-state-contracts.ts',
		'./current-state-records.ts',
	]) {
		const source = readFileSync(join(import.meta.dir, path), 'utf8');
		expect(source).not.toMatch(/baselineScan|\.sync\s*\(/);
	}
});
