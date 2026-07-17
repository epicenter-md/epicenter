/**
 * Record Sync Route Tests
 *
 * Verifies that the authenticated HTTP boundary validates wire-v5 requests,
 * derives authority partitions, and exposes only sync and snapshot reads.
 *
 * Key behaviors:
 * - sync and snapshot-chunk derive their partition from auth and the path
 * - malformed, oversized, and structurally inexact requests never reach storage
 * - obsolete and unrelated authority lifecycle routes remain absent
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	recordRoundDigest,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type SyncRequest,
} from '@epicenter/row-sync';
import { Hono } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { mountRecordsApp } from './records.js';

function setup() {
	const partitions: RecordsPartition[] = [];
	const records: Records = {
		async sync(partition, request) {
			partitions.push(partition);
			return {
				kind: 'sync',
				ok: true,
				snapshotRequired: false,
				token: {
					...request.token,
					acceptedRound: request.sealedRound?.round ?? request.token.acceptedRound,
				},
				entries: [],
				hasMore: false,
			};
		},
		async snapshotChunk(partition) {
			partitions.push(partition);
			return {
				kind: 'snapshotChunk',
				ok: false,
				reason: 'snapshot-replaced',
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

const commands = [
	{
		kind: 'createRow' as const,
		table: 'pages',
		rowId: 'page-1',
		value: { title: 'Hello' },
	},
];
const sync: SyncRequest = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	kind: 'sync',
	token: { replicaId: 'replica-1', acceptedRound: 0, checkpoint: 0 },
	sealedRound: {
		round: 1,
		requestDigest: recordRoundDigest(commands),
		commands,
	},
};
const snapshotChunk = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	kind: 'snapshotChunk' as const,
	generation: 1,
	index: 0,
};

function post(app: Hono<Env>, suffix: string, body: unknown): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/records/wiki/${suffix}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

test('sync and snapshot-chunk derive the authority partition from authentication and path', async () => {
	const { app, partitions } = setup();
	const syncResponse = await post(app, 'sync', sync);
	const snapshotResponse = await post(app, 'snapshot-chunk', snapshotChunk);

	expect(syncResponse.status).toBe(200);
	expect((await syncResponse.json()) as unknown).toEqual({
		kind: 'sync',
		ok: true,
		snapshotRequired: false,
		token: { replicaId: 'replica-1', acceptedRound: 1, checkpoint: 0 },
		entries: [],
		hasMore: false,
	});
	expect((await snapshotResponse.json()) as unknown).toEqual({
		kind: 'snapshotChunk',
		ok: false,
		reason: 'snapshot-replaced',
	});
	expect(partitions).toEqual([
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
	]);
});

test('malformed, oversized, and structurally inexact requests stop before backend work', async () => {
	const { app, partitions } = setup();
	const malformed = await app.request('/api/records/wiki/sync', {
		method: 'POST',
		body: '{',
	});
	const oversized = await post(app, 'sync', {
		payload: 'x'.repeat(1_048_576),
	});
	const inexact = await post(app, 'sync', { ...sync, principalId: 'mallory' });

	expect(malformed.status).toBe(400);
	expect(oversized.status).toBe(413);
	expect(inexact.status).toBe(400);
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

test('the transport exposes no obsolete verbs or authority lifecycle', async () => {
	const { app, partitions } = setup();
	expect((await post(app, 'push', {})).status).toBe(404);
	expect((await post(app, 'pull', {})).status).toBe(404);
	expect((await post(app, 'open', {})).status).toBe(404);
	expect((await post(app, 'succession/activate', {})).status).toBe(404);
	expect(partitions).toEqual([]);
});
