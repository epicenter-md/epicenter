/**
 * Executable row-sync protocol notes.
 *
 * These traces intentionally read more like a protocol notebook than a law
 * suite. The law coverage lives in authority-binding.test.ts; this file keeps
 * the acceptedRound/checkpoint/submission story concrete for humans.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from './adapters/bun.js';
import type { DocumentCodec, RowAuthority } from './authority.js';
import { openRowAuthority } from './authority.js';
import {
	encodeBase64,
	type JsonObject,
	ROW_SYNC_PROTOCOL_MAJOR,
	type SyncResponse,
	type SyncToken,
	type WireRowIntent,
} from './protocol.js';
import { rowRoundDigest } from './round-digest.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const codec: DocumentCodec = {
	mergedCompactState(parts) {
		const tokens = new Set<string>();
		for (const part of parts) {
			for (const token of JSON.parse(decoder.decode(part)) as string[]) {
				tokens.add(token);
			}
		}
		return encoder.encode(JSON.stringify([...tokens].sort()));
	},
};

const rid = (n: number) => n.toString(36).padStart(24, '0');
const docUpdate = (...tokens: string[]) =>
	encodeBase64(encoder.encode(JSON.stringify(tokens)));

function create(rowId: string, fields: JsonObject): WireRowIntent {
	return { kind: 'create', table: 'notes', rowId, fields };
}

function update(
	rowId: string,
	fields: { set: JsonObject; unset: string[] },
): WireRowIntent {
	return { kind: 'update', table: 'notes', rowId, fields };
}

function remove(rowId: string): WireRowIntent {
	return { kind: 'delete', table: 'notes', rowId };
}

function syncRound({
	authority,
	token,
	round,
	submission,
	intents,
	growth,
}: {
	authority: RowAuthority;
	token: SyncToken;
	round: number;
	submission: number;
	intents: WireRowIntent[];
	growth?: 'allow' | 'delete-only';
}) {
	return authority.sync(
		{
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token,
			sealedRound: {
				round,
				submission,
				requestDigest: rowRoundDigest(intents),
				intents,
			},
		},
		growth === undefined ? undefined : { growth },
	);
}

function normalize<T>(value: T, replicaId: string): T {
	return JSON.parse(
		JSON.stringify(value).replaceAll(replicaId, '<replica>'),
	) as T;
}

function expectPage(response: SyncResponse): Extract<SyncResponse, { result: 'page' }> {
	if (response.result !== 'page') {
		throw new Error(`Expected a page response, got ${JSON.stringify(response)}`);
	}
	return response;
}

test('acceptedRound, checkpoint, and submission protocol trace', () => {
	const authority = openRowAuthority({
		database: createBunSqliteAdapter(new Database(':memory:')),
		codec,
	});

	const enroll = authority.enroll({
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'enroll',
	});
	if (enroll.result !== 'enrolled') throw new Error('Enrollment failed');
	const replicaId = enroll.replicaId;
	const zero: SyncToken = { replicaId, acceptedRound: 0, checkpoint: 0 };

	const firstCreate = [
		{
			...create(rid(1), { title: 'alpha' }),
			documentUpdate: docUpdate('body-v1'),
		},
	];
	const accepted = syncRound({
		authority,
		token: zero,
		round: 1,
		submission: 1,
		intents: firstCreate,
	});

	const lostAcceptedRetry = syncRound({
		authority,
		token: zero,
		round: 1,
		submission: 2,
		intents: firstCreate,
	});

	const installed = expectPage(accepted).token;
	const refusedGrowth = syncRound({
		authority,
		token: installed,
		round: 2,
		submission: 3,
		intents: [update(rid(1), { set: { title: 'blocked' }, unset: [] })],
		growth: 'delete-only',
	});

	const deleteOnlyDelete = syncRound({
		authority,
		token: installed,
		round: 2,
		submission: 4,
		intents: [remove(rid(1))],
		growth: 'delete-only',
	});

	const staleRefusalRetry = syncRound({
		authority,
		token: installed,
		round: 2,
		submission: 3,
		intents: [update(rid(1), { set: { title: 'blocked' }, unset: [] })],
		growth: 'allow',
	});

	const afterDelete = expectPage(deleteOnlyDelete).token;
	const secondCreate = [
		{
			...create(rid(2), { title: 'beta' }),
			documentUpdate: docUpdate('body-v2'),
		},
	];
	const afterSecondCreate = syncRound({
		authority,
		token: afterDelete,
		round: 3,
		submission: 5,
		intents: secondCreate,
	});
	const current = expectPage(afterSecondCreate).token;
	authority.compactOutcomesThrough(2);

	const staleCheckpoint = authority.sync({
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: { ...current, checkpoint: 1 },
	});
	const baseline = authority.baselineScan({
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'baselineScan',
	});

	expect(
		normalize(
			{
				enroll,
				accepted,
				lostAcceptedRetry,
				refusedGrowth,
				deleteOnlyDelete,
				staleRefusalRetry,
				afterSecondCreate,
				staleCheckpoint,
				baseline,
				authority: authority.inspect(),
			},
			replicaId,
		),
	).toEqual({
		enroll: { result: 'enrolled', replicaId: '<replica>' },
		accepted: {
			result: 'page',
			token: {
				replicaId: '<replica>',
				acceptedRound: 1,
				checkpoint: 1,
			},
			outcomes: [
				{
					kind: 'row',
					table: 'notes',
					rowId: rid(1),
					fields: { title: 'alpha' },
					documentUpdate: docUpdate('body-v1'),
					sequence: 1,
				},
			],
			hasMore: false,
			retentionFloor: 0,
			submission: 1,
		},
		lostAcceptedRetry: {
			result: 'page',
			token: {
				replicaId: '<replica>',
				acceptedRound: 1,
				checkpoint: 1,
			},
			outcomes: [
				{
					kind: 'row',
					table: 'notes',
					rowId: rid(1),
					fields: { title: 'alpha' },
					documentUpdate: docUpdate('body-v1'),
					sequence: 1,
				},
			],
			hasMore: false,
			retentionFloor: 0,
			submission: 2,
		},
		refusedGrowth: { result: 'capacity-refused', submission: 3 },
		deleteOnlyDelete: {
			result: 'page',
			token: {
				replicaId: '<replica>',
				acceptedRound: 2,
				checkpoint: 2,
			},
			outcomes: [
				{ kind: 'deletion', table: 'notes', rowId: rid(1), sequence: 2 },
			],
			hasMore: false,
			retentionFloor: 0,
			submission: 4,
		},
		staleRefusalRetry: {
			result: 'stale-submission',
			submission: 3,
			watermark: 4,
		},
		afterSecondCreate: {
			result: 'page',
			token: {
				replicaId: '<replica>',
				acceptedRound: 3,
				checkpoint: 3,
			},
			outcomes: [
				{
					kind: 'row',
					table: 'notes',
					rowId: rid(2),
					fields: { title: 'beta' },
					documentUpdate: docUpdate('body-v2'),
					sequence: 3,
				},
			],
			hasMore: false,
			retentionFloor: 0,
			submission: 5,
		},
		staleCheckpoint: {
			result: 'baseline-required',
			token: {
				replicaId: '<replica>',
				acceptedRound: 3,
				checkpoint: 1,
			},
			retentionFloor: 2,
		},
		baseline: {
			result: 'page',
			rows: [
				{
					table: 'notes',
					rowId: rid(2),
					fields: { title: 'beta' },
					document: { updates: [docUpdate('body-v2')] },
				},
			],
			head: 3,
			retentionFloor: 2,
			hasMore: false,
		},
		authority: {
			head: 3,
			retentionFloor: 2,
			rows: [
				{
					table: 'notes',
					rowId: rid(2),
					fields: { title: 'beta' },
					sequence: 3,
				},
			],
			deletionOutcomes: [],
			documentBaselines: [],
			documentUpdates: [{ table: 'notes', rowId: rid(2), sequence: 3 }],
			replicas: {
				'<replica>': {
					acceptedRound: 3,
					submissionWatermark: 5,
				},
			},
		},
	});
});
