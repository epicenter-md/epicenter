/**
 * Current-State Row-Sync Protocol Tests
 *
 * Verifies the incompatible push, fixed pull, and address acquisition
 * wire contract used by every production records transport.
 *
 * Key behaviors:
 * - Exact round receipts identify accepted work
 * - Pull pages carry one fixed head and current scalar state
 * - Acquisition transfers complete rows in stable address order
 * - Closed schemas reject old combined-sync vocabulary and malformed payloads
 */
import { describe, expect, test } from 'bun:test';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	currentStateRequestRefusal,
	fromCurrentStateWireRowIntent,
	parseAcquireRequest,
	parseAcquireResponse,
	parseCurrentStateRowIntent,
	parsePullRequest,
	parsePullResponse,
	parsePushRequest,
	parsePushResponse,
	toCurrentStateWireRowIntent,
} from './current-state-protocol.js';
import type { RowIntent } from './protocol.js';
import { rowRoundDigest } from './round-digest.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const initialReceipt = {
	acceptedRound: 0,
	requestDigest: null,
	appliedThrough: 0,
} as const;
const acceptedReceipt = {
	acceptedRound: 1,
	requestDigest: 'digest-a',
	appliedThrough: 4,
} as const;
const intent = {
	kind: 'create',
	table: 'notes',
	rowId: ROW_ID,
	fields: { title: 'A' },
} as const;

describe('current-state push', () => {
	test('push carries one immutable non-empty RowIntent round', () => {
		const intents = [intent];
		const request = parsePushRequest({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			replicaId: REPLICA_ID,
			round: 1,
			requestDigest: rowRoundDigest(intents),
			intents,
		});
		expect(request.round).toBe(1);
		expect(request.intents).toEqual(intents);
	});

	test('push responses include first-contact storage refusal', () => {
		expect(
			parsePushResponse({ result: 'accepted', receipt: acceptedReceipt }),
		).toEqual({ result: 'accepted', receipt: acceptedReceipt });
		for (const result of [
			'recovery-required',
			'storage-limit',
			'protocol-mismatch',
		] as const) {
			expect(parsePushResponse({ result }).result).toBe(result);
		}
	});

	test('push rejects old combined-sync fields and inadmissible intents', () => {
		expect(() =>
			parsePushRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId: REPLICA_ID,
				round: 1,
				requestDigest: 'digest',
				intents: [intent],
				token: { replicaId: REPLICA_ID, acceptedRound: 0, checkpoint: 0 },
			}),
		).toThrow('Invalid row-sync push request');
		expect(() =>
			parsePushRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId: REPLICA_ID,
				round: 1,
				requestDigest: 'digest',
				intents: [{ ...intent, rowId: 'short' }],
			}),
		).toThrow('Invalid row-sync push request');
		expect(() =>
			parsePushRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId: REPLICA_ID,
				round: 1,
				requestDigest: 'digest',
				intents: [{ ...intent, documentUpdate: 'AQID' }],
			}),
		).toThrow('Invalid row-sync push request');
	});
});

describe('fixed pull', () => {
	test('first pull omits through and later pages repeat the fixed head', () => {
		expect(
			parsePullRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: REPLICA_ID,
				after: 0,
			}).through,
		).toBeUndefined();
		expect(
			parsePullRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: REPLICA_ID,
				after: 2,
				through: 8,
			}).through,
		).toBe(8);
	});

	test('page carries marker progress and current postimages', () => {
		const response = parsePullResponse({
			result: 'page',
			receipt: acceptedReceipt,
			through: 8,
			checkpoint: 5,
			retentionFloor: 0,
			entries: [
				{
					kind: 'row',
					table: 'notes',
					rowId: ROW_ID,
					changedSequence: 10,
					fields: { title: 'current' },
				},
				{
					kind: 'deleted',
					table: 'notes',
					rowId: 'def456ghi789jkl012mno345',
					deletedSequence: 9,
				},
			],
		});
		expect(response.result).toBe('page');
		if (response.result !== 'page') throw new Error('Expected a pull page');
		const firstEntry = response.entries[0];
		if (firstEntry?.kind !== 'row') throw new Error('Expected a row entry');
		expect(firstEntry.changedSequence).toBe(10);
	});

	test('final empty page advances no-op gaps to the fixed head', () => {
		expect(
			parsePullResponse({
				result: 'page',
				receipt: acceptedReceipt,
				through: 8,
				checkpoint: 8,
				retentionFloor: 3,
				entries: [],
			}),
		).toMatchObject({ checkpoint: 8, through: 8 });
	});

	test('pull rejects a moving target and obsolete document entries', () => {
		expect(() =>
			parsePullRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: REPLICA_ID,
				after: 9,
				through: 8,
			}),
		).toThrow('Invalid row-sync pull request');
		expect(() =>
			parsePullResponse({
				result: 'page',
				receipt: acceptedReceipt,
				through: 8,
				checkpoint: 4,
				retentionFloor: 0,
				entries: [
					{
						kind: 'document',
						sequence: 4,
						table: 'notes',
						rowId: ROW_ID,
						update: 'AQID',
					},
				],
			}),
		).toThrow('Invalid row-sync pull response');
	});

	test('joined state may be newer than the fixed page head', () => {
		expect(
			parsePullResponse({
				result: 'page',
				receipt: acceptedReceipt,
				through: 8,
				checkpoint: 4,
				retentionFloor: 0,
				entries: [
					{
						kind: 'deleted',
						table: 'notes',
						rowId: ROW_ID,
						deletedSequence: 10,
					},
				],
			}),
		).toMatchObject({ result: 'page', checkpoint: 4 });
	});

	test('pull rejects the retired tombstone entry vocabulary', () => {
		for (const entry of [
			{
				kind: 'tombstone',
				table: 'notes',
				rowId: ROW_ID,
				changedSequence: 10,
			},
			{
				kind: 'deleted',
				table: 'notes',
				rowId: ROW_ID,
				changedSequence: 10,
			},
		]) {
			expect(() =>
				parsePullResponse({
					result: 'page',
					receipt: acceptedReceipt,
					through: 8,
					checkpoint: 4,
					retentionFloor: 0,
					entries: [entry],
				}),
			).toThrow('Invalid row-sync pull response');
		}
	});

	test('pull rejects marker metadata and embedded document updates on rows', () => {
		for (const obsoleteField of [
			{ sequence: 4 },
			{ documentUpdate: 'AQID' },
			{ hasMore: true },
		]) {
			expect(() =>
				parsePullResponse({
					result: 'page',
					receipt: acceptedReceipt,
					through: 8,
					checkpoint: 4,
					retentionFloor: 0,
					entries: [
						{
							kind: 'row',
							table: 'notes',
							rowId: ROW_ID,
							changedSequence: 10,
							fields: {},
							...(obsoleteField.hasMore === undefined ? obsoleteField : {}),
						},
					],
					...(obsoleteField.hasMore === undefined ? {} : obsoleteField),
				}),
			).toThrow('Invalid row-sync pull response');
		}
	});

	test('pull exposes acquisition and safety halt as distinct results', () => {
		expect(
			parsePullResponse({
				result: 'acquisition-required',
				receipt: acceptedReceipt,
				retentionFloor: 7,
			}).result,
		).toBe('acquisition-required');
		expect(parsePullResponse({ result: 'recovery-required' }).result).toBe(
			'recovery-required',
		);
	});
});

describe('address acquisition', () => {
	test('acquire pages complete live rows after an optional stable address', () => {
		expect(
			parseAcquireRequest({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
				afterAddress: { table: 'notes', rowId: ROW_ID },
				pageLimit: 8,
			}).afterAddress,
		).toEqual({ table: 'notes', rowId: ROW_ID });
		expect(
			parseAcquireResponse({
				result: 'page',
				receipt: acceptedReceipt,
				rows: [
					{
						table: 'notes',
						rowId: ROW_ID,
						fields: { title: 'complete' },
						changedSequence: 8,
					},
				],
				head: 10,
				retentionFloor: 2,
				hasMore: false,
			}),
		).toMatchObject({ result: 'page', head: 10, hasMore: false });
	});

	test('acquire rejects obsolete embedded document state', () => {
		expect(() =>
			parseAcquireResponse({
				result: 'page',
				receipt: acceptedReceipt,
				rows: [
					{
						table: 'notes',
						rowId: ROW_ID,
						fields: {},
						changedSequence: 1,
						document: 'AQID',
					},
				],
				head: 1,
				retentionFloor: 0,
				hasMore: false,
			}),
		).toThrow('Invalid row-sync acquire response');
	});

	test('acquire rejects a row newer than its observed head', () => {
		expect(() =>
			parseAcquireResponse({
				result: 'page',
				receipt: initialReceipt,
				rows: [
					{
						table: 'notes',
						rowId: ROW_ID,
						fields: {},
						changedSequence: 2,
					},
				],
				head: 1,
				retentionFloor: 0,
				hasMore: false,
			}),
		).toThrow('Invalid row-sync acquire response');
	});
});

describe('RowIntent wire encoding and protocol refusal', () => {
	test('semantic scalar intent round trips through the wire schema', () => {
		const semantic: RowIntent = {
			kind: 'update',
			table: 'notes',
			rowId: ROW_ID,
			fields: { set: { title: 'changed' }, unset: ['archived'] },
		};
		const wire = parseCurrentStateRowIntent(
			toCurrentStateWireRowIntent(semantic),
		);
		expect(fromCurrentStateWireRowIntent(wire)).toEqual(semantic);
	});

	test('the old major is refused before authority work', () => {
		expect(
			currentStateRequestRefusal({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			}),
		).toBeUndefined();
		expect(
			currentStateRequestRefusal({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR - 1,
			}),
		).toBe('protocol-mismatch');
	});
});
