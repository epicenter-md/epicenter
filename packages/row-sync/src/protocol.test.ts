import { describe, expect, test } from 'bun:test';
import { ROW_SYNC_ADMISSION_LIMITS } from './admission.js';
import {
	fromWireRowIntent,
	parseBaselineScanRequest,
	parseEnrollRequest,
	parseSyncRequest,
	parseSyncResponse,
	ROW_SYNC_PROTOCOL_MAJOR,
	type RowIntent,
	requestRefusal,
	toWireRowIntent,
	type WireRowIntent,
} from './protocol.js';
import { rowRoundDigest } from './round-digest.js';

const ROW_ID = 'abc123def456ghi789jkl012';

const intents: WireRowIntent[] = [
	{
		kind: 'create',
		table: 'notes',
		rowId: ROW_ID,
		fields: { title: 'a' },
		documentUpdate: 'AAAA',
	},
];

const token = { replicaId: 'replica-a', acceptedRound: 0, checkpoint: 0 };

describe('sync request parsing', () => {
	test('accepts a sealed round with a submission', () => {
		const request = parseSyncRequest({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token,
			sealedRound: {
				round: 1,
				requestDigest: rowRoundDigest(intents),
				submission: 1,
				intents,
			},
		});
		expect(request.sealedRound?.submission).toBe(1);
	});

	test('rejects a sealed round without a submission', () => {
		expect(() =>
			parseSyncRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token,
				sealedRound: {
					round: 1,
					requestDigest: rowRoundDigest(intents),
					intents,
				},
			}),
		).toThrow('Invalid row sync request');
	});

	test('rejects inadmissible intents and the old command vocabulary', () => {
		expect(() =>
			parseSyncRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token,
				sealedRound: {
					round: 1,
					requestDigest: 'x',
					submission: 1,
					intents: [
						{ kind: 'createRow', table: 'notes', rowId: ROW_ID, value: {} },
					],
				},
			}),
		).toThrow('Invalid row sync request');
		expect(() =>
			parseSyncRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token,
				sealedRound: {
					round: 1,
					requestDigest: 'x',
					submission: 1,
					intents: [
						{ kind: 'create', table: 'notes', rowId: 'short', fields: {} },
					],
				},
			}),
		).toThrow('Invalid row sync request');
	});

	test('rejects a request above the encoded round bound', () => {
		const oversized: WireRowIntent = {
			kind: 'update',
			table: 'notes',
			rowId: ROW_ID,
			fields: {
				set: { a: 'x'.repeat(ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes) },
				unset: [],
			},
		};
		expect(() =>
			parseSyncRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token,
				sealedRound: {
					round: 1,
					requestDigest: rowRoundDigest([oversized]),
					submission: 1,
					intents: [oversized],
				},
			}),
		).toThrow('Invalid row sync request');
	});
});

describe('sync response parsing', () => {
	test('accepts pages, baseline-required, and every refusal shape', () => {
		expect(
			parseSyncResponse({
				kind: 'sync',
				ok: true,
				result: 'page',
				token,
				outcomes: [
					{
						kind: 'row',
						table: 'notes',
						rowId: ROW_ID,
						fields: { title: 'a' },
						documentUpdate: 'AAAA',
						sequence: 1,
					},
					{ kind: 'deletion', table: 'notes', rowId: ROW_ID, sequence: 2 },
				],
				hasMore: false,
				retentionFloor: 0,
				submission: 3,
			}).ok,
		).toBeTrue();
		expect(
			parseSyncResponse({
				kind: 'sync',
				ok: true,
				result: 'baseline-required',
				token,
				retentionFloor: 10,
			}).ok,
		).toBeTrue();
		for (const refusal of [
			{ kind: 'sync', ok: false, reason: 'protocol-mismatch' },
			{ kind: 'sync', ok: false, reason: 'unknown-replica' },
			{ kind: 'sync', ok: false, reason: 'replica-fork' },
			{
				kind: 'sync',
				ok: false,
				reason: 'stale-submission',
				submission: 1,
				watermark: 4,
			},
			{ kind: 'sync', ok: false, reason: 'capacity-refused', submission: 5 },
		]) {
			expect(parseSyncResponse(refusal).ok).toBeFalse();
		}
	});

	test('rejects a row outcome with neither fields nor document', () => {
		expect(() =>
			parseSyncResponse({
				kind: 'sync',
				ok: true,
				result: 'page',
				token,
				outcomes: [{ kind: 'row', table: 'notes', rowId: ROW_ID, sequence: 1 }],
				hasMore: false,
				retentionFloor: 0,
			}),
		).toThrow('Invalid row sync response');
	});
});

describe('enrollment and baseline scan parsing', () => {
	test('enroll request is the bare envelope', () => {
		expect(
			parseEnrollRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'enroll',
			}).kind,
		).toBe('enroll');
	});

	test('baseline scan accepts an optional address cursor', () => {
		expect(
			parseBaselineScanRequest({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'baselineScan',
				after: { table: 'notes', rowId: ROW_ID },
				pageLimit: 8,
			}).after?.table,
		).toBe('notes');
	});
});

describe('round digest', () => {
	test('is deterministic over the canonical wire encoding', () => {
		expect(rowRoundDigest(intents)).toBe(
			rowRoundDigest(structuredClone(intents)),
		);
		expect(rowRoundDigest(intents)).toMatch(/^[0-9a-f]{64}$/);
	});

	test('changes when intent order or content changes', () => {
		const reordered: WireRowIntent[] = [
			{ kind: 'delete', table: 'notes', rowId: ROW_ID },
			...intents,
		];
		expect(rowRoundDigest(reordered)).not.toBe(rowRoundDigest(intents));
		expect(
			rowRoundDigest([
				{ ...intents[0]!, fields: { title: 'b' } } as WireRowIntent,
			]),
		).not.toBe(rowRoundDigest(intents));
	});
});

describe('semantic and wire encodings', () => {
	test('one RowIntent round trips bytes through base64', () => {
		const semantic: RowIntent = {
			kind: 'update',
			table: 'notes',
			rowId: ROW_ID,
			fields: { set: { a: 1 }, unset: ['b'] },
			documentUpdate: new Uint8Array([1, 2, 3, 250]),
		};
		const wire = toWireRowIntent(semantic);
		if (wire.kind !== 'update') throw new Error('Expected an update');
		expect(typeof wire.documentUpdate).toBe('string');
		expect(fromWireRowIntent(wire)).toEqual(semantic);
	});
});

describe('protocol refusal', () => {
	test('a different major is refused before any authority work', () => {
		expect(
			requestRefusal({ protocolMajor: ROW_SYNC_PROTOCOL_MAJOR }),
		).toBeUndefined();
		expect(requestRefusal({ protocolMajor: ROW_SYNC_PROTOCOL_MAJOR + 1 })).toBe(
			'protocol-mismatch',
		);
	});
});
