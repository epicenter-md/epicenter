/**
 * Schema-Blind Record Protocol Tests
 *
 * Verifies strict parsing and admission for the current-state wire contract.
 *
 * Key behaviors:
 * - only createRow, patchRow, and deleteRow are admitted
 * - actor sequences within a push are contiguous
 * - JSON null is data while undefined is rejected
 */

import { expect, test } from 'bun:test';
import { RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import { canonicalJson } from './canonical-json.js';
import {
	parseMutation,
	parsePullResponse,
	parsePushRequest,
	RECORD_SYNC_PROTOCOL_MAJOR,
	requestRefusal,
} from './protocol.js';

test('request refusal is absent for the current protocol', () => {
	expect(
		requestRefusal({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		}),
	).toBeUndefined();
});

test('canonical JSON orders object keys by JavaScript code units', () => {
	expect(canonicalJson({ ä: 3, a: 2, Z: 1 })).toBe('{"Z":1,"a":2,"ä":3}');
	expect(canonicalJson({ '2': 2, '10': 10, '\ue000': 2, '😀': 1 })).toBe(
		'{"10":10,"2":2,"😀":1,"":2}',
	);
});

test('push parser accepts contiguous opaque JSON commands', () => {
	const request = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push' as const,
		actorId: 'actor-a',
		mutations: [
			{
				actorSequence: 1,
				command: {
					kind: 'createRow' as const,
					table: 'skills',
					rowId: 'skill-1',
					value: { title: 'One', future: { nested: true }, nullable: null },
				},
			},
			{
				actorSequence: 2,
				command: {
					kind: 'patchRow' as const,
					table: 'skills',
					rowId: 'skill-1',
					set: { title: 'Two' },
					unset: ['obsolete'],
				},
			},
		],
	};

	expect(parsePushRequest(request)).toEqual(request);
});

test('push parser rejects sequence gaps', () => {
	expect(() =>
		parsePushRequest({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			actorId: 'actor-a',
			mutations: [
				{
					actorSequence: 1,
					command: {
						kind: 'deleteRow',
						table: 'skills',
						rowId: 'one',
					},
				},
				{
					actorSequence: 3,
					command: {
						kind: 'deleteRow',
						table: 'skills',
						rowId: 'two',
					},
				},
			],
		}),
	).toThrow('contiguous');
});

test('mutation parser rejects undefined and non-finite JSON values', () => {
	for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() =>
			parseMutation({
				actorSequence: 1,
				command: {
					kind: 'createRow',
					table: 'skills',
					rowId: 'skill-1',
					value: { invalid },
				},
			}),
		).toThrow('Invalid record mutation');
	}
});

test('mutation parser rejects cyclic objects and bigint without leaking JSON errors', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const invalid of [cyclic, 1n]) {
		expect(() =>
			parseMutation({
				actorSequence: 1,
				command: {
					kind: 'createRow',
					table: 'skills',
					rowId: 'skill-1',
					value: { invalid },
				},
			}),
		).toThrow('Invalid record mutation');
	}
});

test('patch parser rejects empty, duplicate, and overlapping unsets', () => {
	for (const command of [
		{ set: {}, unset: [] },
		{ set: {}, unset: ['title', 'title'] },
		{ set: { title: 'New' }, unset: ['title'] },
	]) {
		expect(() =>
			parseMutation({
				actorSequence: 1,
				command: {
					kind: 'patchRow',
					table: 'skills',
					rowId: 'skill-1',
					...command,
				},
			}),
		).toThrow('Invalid record mutation');
	}
});

test('legacy schema, database, KV, and operation envelopes are rejected', () => {
	expect(() =>
		parsePushRequest({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsSchemaHash: 'v1',
			databaseId: 'database-a',
			kind: 'push',
			actorId: 'actor-a',
			mutations: [],
		}),
	).toThrow('Invalid record push request');
	expect(() =>
		parseMutation({
			actorSequence: 1,
			command: { kind: 'setKv', key: 'theme', value: 'dark' },
		}),
	).toThrow('Invalid record mutation');
});

test('pull responses are bounded by entry count and total encoded bytes', () => {
	const deletion = (index: number) => ({
		kind: 'deletion' as const,
		table: 'skills',
		rowId: `skill-${index}`,
		lastServerSequence: index + 1,
	});
	expect(() =>
		parsePullResponse({
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: 0,
			entries: Array.from(
				{ length: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull + 1 },
				(_, index) => deletion(index),
			),
			newCursor: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull + 1,
			hasMore: false,
		}),
	).toThrow('Invalid record pull response');

	const largeValue = 'x'.repeat(500 * 1024);
	expect(() =>
		parsePullResponse({
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: 0,
			entries: Array.from({ length: 17 }, (_, index) => ({
				kind: 'row',
				table: 'skills',
				rowId: `skill-${index}`,
				value: { body: largeValue },
				lastServerSequence: index + 1,
			})),
			newCursor: 17,
			hasMore: false,
		}),
	).toThrow('Invalid record pull response');
});
