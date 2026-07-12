import { expect, test } from 'bun:test';
import {
	parsePullRequest,
	parsePullResponse,
	parsePushRequest,
	parsePushResponse,
	parseSnapshotChunkRequest,
	parseSnapshotChunkResponse,
} from './protocol.js';

const envelope = {
	protocolMajor: 1,
	schemaEpochId: 'notes-v1',
	databaseIncarnationId: 'db-1',
};

test('protocol parsers accept the closed wire shapes and nested JSON cells', () => {
	expect(
		parsePushRequest({
			kind: 'push',
			...envelope,
			mutations: [
				{
					actorId: 'actor-a',
					actorSequence: 1,
					operations: [
						{
							kind: 'patchRow',
							table: 'notes',
							rowId: 'n1',
							cells: { metadata: { tags: ['one', 'two'], rank: 2 } },
						},
					],
				},
			],
		}).mutations[0]?.actorId,
	).toBe('actor-a');
	expect(
		parsePullRequest({ kind: 'pull', ...envelope, cursor: 0, limit: 100 }),
	).toMatchObject({ cursor: 0, limit: 100 });
	expect(
		parseSnapshotChunkRequest({
			kind: 'snapshotChunk',
			...envelope,
			generation: 1,
			index: 0,
		}),
	).toMatchObject({ generation: 1, index: 0 });
});

test('response parsers validate both success and refusal variants', () => {
	expect(parsePushResponse({ kind: 'push', ok: true })).toEqual({
		kind: 'push',
		ok: true,
	});
	expect(
		parsePullResponse({
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: 0,
			mutations: [
				{
					serverSequence: 1,
					actorId: 'actor-a',
					actorSequence: 1,
					operations: [
						{
							kind: 'patchRow',
							table: 'notes',
							rowId: 'n1',
							cells: { metadata: { tags: ['one'] } },
						},
					],
				},
			],
			newCursor: 1,
			hasMore: false,
		}),
	).toMatchObject({ newCursor: 1 });
	expect(
		parseSnapshotChunkResponse({
			kind: 'snapshotChunk',
			ok: false,
			reason: 'snapshot-replaced',
		}),
	).toMatchObject({ ok: false, reason: 'snapshot-replaced' });
});

test('response parsers reject extra fields and invalid snapshot cells', () => {
	expect(() =>
		parsePushResponse({ kind: 'push', ok: true, acceptedThrough: 3 }),
	).toThrow();
	expect(() =>
		parseSnapshotChunkResponse({
			kind: 'snapshotChunk',
			ok: true,
			chunk: {
				generation: 1,
				index: 0,
				rows: [
					{
						table: 'notes',
						rowId: 'n1',
						deleted: true,
						cells: { title: 'must be empty' },
					},
				],
				checksum: 'checksum',
			},
		}),
	).toThrow();
});

test('push parsing rejects non-JSON cells, unsafe sequences, and extra keys', () => {
	const operation = {
		kind: 'patchRow',
		table: 'notes',
		rowId: 'n1',
		cells: { title: 'valid' },
	};
	const mutation = {
		actorId: 'actor-a',
		actorSequence: 1,
		operations: [operation],
	};
	const base = {
		kind: 'push',
		...envelope,
		mutations: [mutation],
	};
	expect(() =>
		parsePushRequest({ ...base, mutations: [], extra: true }),
	).toThrow();
	expect(() =>
		parsePushRequest({
			...base,
			mutations: [
				{
					...mutation,
					actorSequence: Number.MAX_SAFE_INTEGER + 1,
				},
			],
		}),
	).toThrow();
	expect(() =>
		parsePushRequest({
			...base,
			mutations: [
				{
					...mutation,
					operations: [
						{
							...operation,
							cells: { invalid: undefined },
						},
					],
				},
			],
		}),
	).toThrow();
});
