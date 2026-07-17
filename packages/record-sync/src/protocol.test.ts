/**
 * Schema-Blind Record Protocol Tests (wire major 5)
 *
 * Verifies strict parsing and admission for the sealed-round sync contract.
 *
 * Key behaviors:
 * - only createRow, patchRow, deleteRow, and bodyAppend are admitted
 * - row lifecycle at the reserved KV address is rejected at parse time
 * - JSON null is data while undefined is rejected
 * - sync responses are bounded by entry count and total encoded bytes
 */

import { expect, test } from 'bun:test';
import { RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import { canonicalJson } from './canonical-json.js';
import {
	parseRecordCommand,
	parseSyncRequest,
	parseSyncResponse,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	requestRefusal,
	type SyncRequest,
} from './protocol.js';
import { recordRoundDigest } from './round-digest.js';

function sealedSync(commands: RecordCommand[]): SyncRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: { replicaId: 'replica-a', acceptedRound: 0, checkpoint: 0 },
		sealedRound: {
			round: 1,
			requestDigest: recordRoundDigest(commands),
			commands,
		},
	};
}

test('request refusal is absent for the current protocol', () => {
	expect(
		requestRefusal({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		}),
	).toBeUndefined();
	expect(requestRefusal({ protocolMajor: 4 })).toBe('protocol-mismatch');
});

test('canonical JSON orders object keys by JavaScript code units', () => {
	expect(canonicalJson({ ä: 3, a: 2, Z: 1 })).toBe('{"Z":1,"a":2,"ä":3}');
	expect(canonicalJson({ '2': 2, '10': 10, '\ue000': 2, '😀': 1 })).toBe(
		'{"10":10,"2":2,"😀":1,"\ue000":2}',
	);
});

test('sync parser accepts a sealed round of opaque JSON commands', () => {
	const request = sealedSync([
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'skill-1',
			value: { title: 'One', future: { nested: true }, nullable: null },
		},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: 'skill-1',
			set: { title: 'Two' },
			unset: ['obsolete'],
		},
		{
			kind: 'bodyAppend',
			table: 'skills',
			rowId: 'skill-1',
			update: 'dXBkYXRl',
		},
	]);

	expect(parseSyncRequest(request)).toEqual(request);
	// A pull is a sync with no round.
	const pull: SyncRequest = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: { replicaId: 'replica-a', acceptedRound: 3, checkpoint: 17 },
	};
	expect(parseSyncRequest(pull)).toEqual(pull);
});

test('command parser rejects undefined and non-finite JSON values', () => {
	for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() =>
			parseRecordCommand({
				kind: 'createRow',
				table: 'skills',
				rowId: 'skill-1',
				value: { invalid },
			}),
		).toThrow('Invalid record command');
	}
});

test('command parser rejects cyclic objects and bigint without leaking JSON errors', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const invalid of [cyclic, 1n]) {
		expect(() =>
			parseRecordCommand({
				kind: 'createRow',
				table: 'skills',
				rowId: 'skill-1',
				value: { invalid },
			}),
		).toThrow('Invalid record command');
	}
});

test('patch parser rejects empty, duplicate, and overlapping unsets', () => {
	for (const command of [
		{ set: {}, unset: [] },
		{ set: {}, unset: ['title', 'title'] },
		{ set: { title: 'New' }, unset: ['title'] },
	]) {
		expect(() =>
			parseRecordCommand({
				kind: 'patchRow',
				table: 'skills',
				rowId: 'skill-1',
				...command,
			}),
		).toThrow('Invalid record command');
	}
});

test('row lifecycle at the reserved KV address is rejected at parse time', () => {
	expect(() =>
		parseSyncRequest(
			sealedSync([
				{
					kind: 'createRow',
					table: '__epicenter_kv',
					rowId: 'workspace',
					value: {},
				},
			]),
		),
	).toThrow('Invalid record sync request');
	expect(() =>
		parseSyncRequest(
			sealedSync([
				{ kind: 'deleteRow', table: '__epicenter_kv', rowId: 'workspace' },
			]),
		),
	).toThrow('Invalid record sync request');
	expect(
		parseSyncRequest(
			sealedSync([
				{
					kind: 'patchRow',
					table: '__epicenter_kv',
					rowId: 'workspace',
					set: { theme: 'dark' },
					unset: [],
				},
			]),
		).sealedRound?.commands,
	).toHaveLength(1);
});

test('legacy push, actor, and first-class KV envelopes are rejected', () => {
	expect(() =>
		parseSyncRequest({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			actorId: 'actor-a',
			mutations: [],
		}),
	).toThrow('Invalid record sync request');
	expect(() =>
		parseRecordCommand({ kind: 'kvSet', key: 'theme', value: 'dark' }),
	).toThrow('Invalid record command');
});

test('sync responses are bounded by entry count and total encoded bytes', () => {
	const token = { replicaId: 'replica-a', acceptedRound: 1, checkpoint: 65 };
	const deletion = (index: number) => ({
		kind: 'deletion' as const,
		table: 'skills',
		rowId: `skill-${index}`,
		lastServerSequence: index + 1,
	});
	expect(() =>
		parseSyncResponse({
			kind: 'sync',
			ok: true,
			snapshotRequired: false,
			token,
			entries: Array.from(
				{ length: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage + 1 },
				(_, index) => deletion(index),
			),
			hasMore: false,
		}),
	).toThrow('Invalid record sync response');

	const largeValue = 'x'.repeat(500 * 1024);
	expect(() =>
		parseSyncResponse({
			kind: 'sync',
			ok: true,
			snapshotRequired: false,
			token,
			entries: Array.from({ length: 17 }, (_, index) => ({
				kind: 'row',
				table: 'skills',
				rowId: `skill-${index}`,
				value: { body: largeValue },
				lastServerSequence: index + 1,
			})),
			hasMore: false,
		}),
	).toThrow('Invalid record sync response');
});
