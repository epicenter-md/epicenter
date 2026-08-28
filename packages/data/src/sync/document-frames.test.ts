/**
 * The wire, which is small enough that the tests are mostly about what it does
 * NOT do.
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

import {
	type DocumentFrame,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from './document-frames.js';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('a frame survives the round trip', () => {
	test.each([
		[{ kind: 'step1', stateVector: bytes(1, 2, 3) } as DocumentFrame],
		[{ kind: 'step2', update: bytes(4, 5, 6, 7) } as DocumentFrame],
		[{ kind: 'update', update: bytes(8) } as DocumentFrame],
	])('%o', (frame) => {
		expect(expectOk(decodeDocumentFrame(encodeDocumentFrame(frame)))).toEqual(
			frame,
		);
	});

	test('an empty payload is a frame, because an empty update is a real update', () => {
		// The 13-byte no-op has a body, but a state vector for a document holding
		// nothing is legitimately short, and a zero-length payload must not be
		// mistaken for a malformed message.
		const decoded = expectOk(
			decodeDocumentFrame(
				encodeDocumentFrame({ kind: 'step1', stateVector: new Uint8Array() }),
			),
		);
		expect(decoded).toEqual({ kind: 'step1', stateVector: new Uint8Array() });
	});

	test('the header is one byte, and that is the whole overhead', () => {
		const payload = bytes(1, 2, 3, 4, 5);
		expect(
			encodeDocumentFrame({ kind: 'update', update: payload }).length,
		).toBe(payload.length + 1);
	});
});

describe('what it refuses', () => {
	test('an empty message is not a frame', () => {
		expect(decodeDocumentFrame(new Uint8Array()).error?.name).toBe('Malformed');
	});

	test('an unknown kind is refused rather than guessed at', () => {
		expect(decodeDocumentFrame(bytes(99, 1, 2)).error?.name).toBe('Malformed');
	});
});

describe('the numbers are y-protocols numbers', () => {
	test('step1 is 0, step2 is 1, update is 2', () => {
		// Matching the ecosystem's ids costs one comment and means a reader who
		// knows y-protocols is not learning a private dialect.
		expect(
			encodeDocumentFrame({ kind: 'step1', stateVector: new Uint8Array() })[0],
		).toBe(0);
		expect(
			encodeDocumentFrame({ kind: 'step2', update: new Uint8Array() })[0],
		).toBe(1);
		expect(
			encodeDocumentFrame({ kind: 'update', update: new Uint8Array() })[0],
		).toBe(2);
	});
});

describe('a decoded frame does not alias the socket buffer', () => {
	test('mutating the input afterwards does not change the frame', () => {
		// A socket may reuse the buffer it handed over. `slice` copies where
		// `subarray` would have shared, and the difference is invisible until a
		// runtime starts pooling.
		const wire = encodeDocumentFrame({
			kind: 'update',
			update: bytes(1, 2, 3),
		});
		const decoded = expectOk(decodeDocumentFrame(wire));
		wire[1] = 99;
		expect((decoded as { update: Uint8Array }).update).toEqual(bytes(1, 2, 3));
	});
});
