/**
 * Route-bound Document Protocol Tests
 *
 * Verifies the Yjs 14 state-vector and update wire after connection lifecycle
 * moved to WebSocket admission and close codes.
 *
 * Key behaviors:
 * - the selected subprotocol is the only protocol-major fact
 * - WebSocket boundaries need only a one-byte frame kind
 * - addresses, multiplexing, presence, and lifecycle controls are absent
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	DOCUMENT_CLOSE_CODE,
	DOCUMENT_FRAME_LIMITS,
	DOCUMENT_SUBPROTOCOL,
	type DocumentFrame,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from './protocol.js';

describe('document v3 frame codec', () => {
	test('round trips the complete fixed-document data protocol', () => {
		const doc = createDoc('hello');
		const frames: DocumentFrame[] = [
			{ kind: 'sync-request', stateVector: Y.encodeStateVector(doc) },
			{ kind: 'sync-response', update: Y.encodeStateAsUpdateV2(doc) },
			{ kind: 'update', update: Y.encodeStateAsUpdateV2(doc) },
		];
		for (const frame of frames) {
			expect(decodeDocumentFrame(encodeDocumentFrame(frame))).toEqual(frame);
		}
	});

	test('carries a real Yjs 14 state-vector handshake and incremental update', () => {
		const server = createDoc('server');
		const client = new Y.Doc();
		const request = decodeDocumentFrame(
			encodeDocumentFrame({
				kind: 'sync-request',
				stateVector: Y.encodeStateVector(client),
			}),
		);
		if (request.kind !== 'sync-request')
			throw new Error('Expected sync request');
		const response = decodeDocumentFrame(
			encodeDocumentFrame({
				kind: 'sync-response',
				update: Y.encodeStateAsUpdateV2(server, request.stateVector),
			}),
		);
		if (response.kind !== 'sync-response') {
			throw new Error('Expected sync response');
		}
		Y.applyUpdateV2(client, response.update);
		expect(client.get('content').toString()).toBe('server');

		let incremental: Uint8Array | undefined;
		server.on('updateV2', (update: Uint8Array) => {
			incremental = update;
		});
		server.get('content').insert(6, ' update');
		if (!incremental) throw new Error('Expected an incremental update');
		const update = decodeDocumentFrame(
			encodeDocumentFrame({ kind: 'update', update: incremental }),
		);
		if (update.kind !== 'update') throw new Error('Expected update');
		Y.applyUpdateV2(client, update.update);
		expect(client.get('content').toString()).toBe('server update');
	});

	test('uses one frame-kind byte because the subprotocol owns the major', () => {
		const encoded = encodeDocumentFrame({
			kind: 'update',
			update: new Uint8Array([7, 8, 9]),
		});
		expect(DOCUMENT_SUBPROTOCOL).toBe('epicenter-document-v3');
		expect(DOCUMENT_FRAME_LIMITS.headerBytes).toBe(1);
		expect([...encoded]).toEqual([2, 7, 8, 9]);
	});

	test('reserves only terminal too-large as a document close code', () => {
		expect(DOCUMENT_CLOSE_CODE).toEqual({
			'too-large': 1009,
		});
	});

	test('rejects malformed, empty, over-limit, and unknown frames', () => {
		expect(() => decodeDocumentFrame(new Uint8Array())).toThrow(
			'Invalid document frame',
		);
		expect(() => decodeDocumentFrame(new Uint8Array([0]))).toThrow(
			'Invalid document frame',
		);
		expect(() =>
			decodeDocumentFrame(
				new Uint8Array(DOCUMENT_FRAME_LIMITS.encodedFrameBytes + 1),
			),
		).toThrow('Invalid document frame');
		expect(() => decodeDocumentFrame(new Uint8Array([99, 1]))).toThrow(
			'Unknown document frame kind',
		);
		expect(() =>
			encodeDocumentFrame({ kind: 'update', update: new Uint8Array() }),
		).toThrow('Invalid document frame payload');
		expect(() =>
			encodeDocumentFrame({
				kind: 'update',
				update: new Uint8Array(DOCUMENT_FRAME_LIMITS.payloadBytes + 1),
			}),
		).toThrow('Invalid document frame payload');
	});

	test('has no address, multiplex, presence, or lifecycle frame', () => {
		for (const frame of [
			{ kind: 'subscribe', table: 'notes', rowId: 'one' },
			{ kind: 'unsubscribe', table: 'notes', rowId: 'one' },
			{ kind: 'presence', payload: new Uint8Array([1]) },
			{ kind: 'unknown' },
			{ kind: 'revoked' },
			{ kind: 'too-large' },
			{
				kind: 'update',
				table: 'notes',
				rowId: 'one',
				update: new Uint8Array([1]),
			},
		]) {
			expect(() => encodeDocumentFrame(frame as never)).toThrow();
		}
	});
});

function createDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.get('content').insert(0, content);
	return doc;
}
