import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	type PullRequest,
	type PushRequest,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '@epicenter/record-sync';
import { Hono } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { mountRecordsApp } from './records.js';

function setup() {
	const partitions: RecordsPartition[] = [];
	const records: Records = {
		async push(partition, request) {
			partitions.push(partition);
			return {
				kind: 'push',
				ok: true,
				acceptance: 'accepted',
				receipt: {
					actorId: request.actorId,
					batchChecksum: 'checksum',
					firstActorSequence: 1,
					lastActorSequence: 1,
					firstServerSequence: 1,
					lastServerSequence: 1,
				},
			};
		},
		async pull(partition, request) {
			partitions.push(partition);
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: request.cursor,
				entries: [],
				newCursor: request.cursor,
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

const push: PushRequest = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	kind: 'push',
	actorId: 'actor-1',
	mutations: [
		{
			actorSequence: 1,
			command: {
				kind: 'createRow',
				table: 'pages',
				rowId: 'page-1',
				value: { title: 'Hello' },
			},
		},
	],
};
const pull: PullRequest = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	kind: 'pull',
	cursor: 0,
	limit: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
};

function post(
	app: Hono<Env>,
	suffix: string,
	body: unknown,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/records/wiki/${suffix}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

test('push and pull derive the authority partition from authentication and path', async () => {
	const { app, partitions } = setup();
	const pushResponse = await post(app, 'push', push);
	const pullResponse = await post(app, 'pull', pull);

	expect(pushResponse.status).toBe(200);
	expect((await pushResponse.json()) as { ok: boolean }).toMatchObject({
		kind: 'push',
		ok: true,
		acceptance: 'accepted',
	});
	expect((await pullResponse.json()) as unknown).toEqual({
		kind: 'pull',
		ok: true,
		snapshotRequired: false,
		fromCursor: 0,
		entries: [],
		newCursor: 0,
		hasMore: false,
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
	const malformed = await app.request('/api/records/wiki/push', {
		method: 'POST',
		body: '{',
	});
	const oversized = await post(app, 'push', {
		payload: 'x'.repeat(1_048_576),
	});
	const inexact = await post(app, 'pull', { ...pull, principalId: 'mallory' });

	expect(malformed.status).toBe(400);
	expect(oversized.status).toBe(413);
	expect(inexact.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('oversized workspace identity stops before backend work', async () => {
	const { app, partitions } = setup();
	const response = await app.request(`/api/records/${'w'.repeat(513)}/pull`, {
		method: 'POST',
		body: JSON.stringify(pull),
	});

	expect(response.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('the transport exposes no open or succession lifecycle', async () => {
	const { app, partitions } = setup();
	expect((await post(app, 'open', {})).status).toBe(404);
	expect((await post(app, 'succession/activate', {})).status).toBe(404);
	expect(partitions).toEqual([]);
});
