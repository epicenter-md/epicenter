/**
 * Row Sync Route Tests
 *
 * Verifies that the authenticated HTTP boundary validates RowIntent requests,
 * derives authority partitions, and exposes enrollment, sync, and baseline scan.
 *
 * Key behaviors:
 * - all three routes derive partitions from authentication and workspace paths
 * - declared and actual bodies are capped at 1 MiB before backend work
 * - authority TypeErrors become 400 invalid-request responses
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	type BaselineScanRequest,
	type EnrollRequest,
	ROW_SYNC_PROTOCOL_MAJOR,
	rowRoundDigest,
	type SyncRequest,
	type WireRowIntent,
} from '@epicenter/row-sync';
import { Hono } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { mountRecordsApp } from './records.js';

function setup({ fail }: { fail?: keyof Records } = {}) {
	const partitions: RecordsPartition[] = [];
	const records: Records = {
		async enroll(partition) {
			partitions.push(partition);
			if (fail === 'enroll') throw new TypeError('invalid enrollment');
			return {
				kind: 'enroll',
				ok: true,
				replicaId: '000000000000000000000001',
			};
		},
		async sync(partition, request) {
			partitions.push(partition);
			if (fail === 'sync') throw new TypeError('invalid sync');
			return {
				kind: 'sync',
				ok: true,
				result: 'page',
				token: {
					...request.token,
					acceptedRound:
						request.sealedRound?.round ?? request.token.acceptedRound,
				},
				outcomes: [],
				hasMore: false,
				retentionFloor: 0,
				...(request.sealedRound === undefined
					? {}
					: { submission: request.sealedRound.submission }),
			};
		},
		async baselineScan(partition) {
			partitions.push(partition);
			if (fail === 'baselineScan') throw new TypeError('invalid baseline scan');
			return {
				kind: 'baselineScan',
				ok: true,
				rows: [],
				head: 0,
				retentionFloor: 0,
				hasMore: false,
			};
		},
	};
	const app = new Hono<Env>();
	mountRecordsApp(app, {
		resolveRecords: () => records,
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('authenticated-alice') });
			await next();
		},
	});
	return { app, partitions };
}

const intents: WireRowIntent[] = [
	{
		kind: 'create',
		table: 'pages',
		rowId: '000000000000000000000001',
		fields: { title: 'Hello' },
	},
];
const enroll: EnrollRequest = {
	protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'enroll',
};
const sync: SyncRequest = {
	protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'sync',
	token: {
		replicaId: '000000000000000000000001',
		acceptedRound: 0,
		checkpoint: 0,
	},
	sealedRound: {
		round: 1,
		requestDigest: rowRoundDigest(intents),
		submission: 1,
		intents,
	},
};
const baselineScan: BaselineScanRequest = {
	protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
	kind: 'baselineScan',
	pageLimit: 1,
};

function post(
	app: Hono<Env>,
	suffix: string,
	body: unknown,
	headers?: Record<string, string>,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/records/wiki/${suffix}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		}),
	);
}

test('enroll, sync, and baseline-scan derive the authenticated partition', async () => {
	const { app, partitions } = setup();
	const enrollResponse = await post(app, 'enroll', enroll);
	const syncResponse = await post(app, 'sync', sync);
	const baselineResponse = await post(app, 'baseline-scan', baselineScan);

	expect(enrollResponse.status).toBe(200);
	expect((await enrollResponse.json()) as unknown).toEqual({
		kind: 'enroll',
		ok: true,
		replicaId: '000000000000000000000001',
	});
	expect(syncResponse.status).toBe(200);
	expect((await syncResponse.json()) as unknown).toMatchObject({
		kind: 'sync',
		ok: true,
		result: 'page',
		token: { acceptedRound: 1 },
		submission: 1,
	});
	expect(baselineResponse.status).toBe(200);
	expect((await baselineResponse.json()) as unknown).toEqual({
		kind: 'baselineScan',
		ok: true,
		rows: [],
		head: 0,
		retentionFloor: 0,
		hasMore: false,
	});
	expect(partitions).toEqual(
		Array.from({ length: 3 }, () => ({
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		})),
	);
});

test('malformed and structurally inexact requests stop before backend work', async () => {
	const { app, partitions } = setup();
	const malformed = await app.request('/api/records/wiki/sync', {
		method: 'POST',
		body: '{',
	});
	const inexact = await post(app, 'sync', { ...sync, principalId: 'mallory' });

	expect(malformed.status).toBe(400);
	expect(inexact.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('declared and actual bodies above 1 MiB stop before backend work', async () => {
	const { app, partitions } = setup();
	const declared = await post(app, 'enroll', enroll, {
		'content-length': '1048577',
	});
	const actual = await post(app, 'sync', {
		payload: 'x'.repeat(1_048_576),
	});

	expect(declared.status).toBe(413);
	expect(actual.status).toBe(413);
	expect(partitions).toEqual([]);
});

test('oversized workspace identity stops before backend work', async () => {
	const { app, partitions } = setup();
	const response = await app.request(`/api/records/${'w'.repeat(513)}/sync`, {
		method: 'POST',
		body: JSON.stringify(sync),
	});

	expect(response.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('authority TypeErrors map to 400 invalid-request on every route', async () => {
	for (const [method, body, fail] of [
		['enroll', enroll, 'enroll'],
		['sync', sync, 'sync'],
		['baseline-scan', baselineScan, 'baselineScan'],
	] as const) {
		const { app } = setup({ fail });
		expect((await post(app, method, body)).status).toBe(400);
	}
});

test('snapshot and deleted record-sync routes have no compatibility aliases', async () => {
	const { app, partitions } = setup();
	for (const route of [
		'snapshot-chunk',
		'push',
		'pull',
		'open',
		'succession/activate',
	]) {
		expect((await post(app, route, {})).status).toBe(404);
	}
	expect(partitions).toEqual([]);
});
