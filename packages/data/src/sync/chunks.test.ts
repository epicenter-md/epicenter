/**
 * The round trip, which had no test of its own outside a dying suite.
 *
 * `transport.test.ts` proved this while proving the old wire, and that file
 * goes with the positional log. What it was really pinning is a storage
 * property, so it moves here rather than being deleted with its old neighbours.
 */
import { describe, expect, test } from 'bun:test';
import { CHUNK_BYTES, intoChunks, joinChunks } from './chunks.js';

const sized = (length: number) =>
	Uint8Array.from({ length }, (_, index) => index % 251);

describe('chunking', () => {
	test('an update under the cap is one chunk, and the same bytes', () => {
		const bytes = sized(1_000);
		const chunks = intoChunks(bytes);
		expect(chunks).toHaveLength(1);
		expect(joinChunks(chunks)).toEqual(bytes);
	});

	test('an empty update is one empty chunk, never none', () => {
		// So "how many went in" and "how many came out" always agree, which a
		// zero-length answer would quietly break.
		expect(intoChunks(new Uint8Array(0))).toHaveLength(1);
		expect(joinChunks(intoChunks(new Uint8Array(0)))).toHaveLength(0);
	});

	test('an update over the cap round-trips through several chunks', () => {
		const bytes = sized(2_500);
		const chunks = intoChunks(bytes, 1_000);
		expect(chunks).toHaveLength(3);
		expect(chunks.map((chunk) => chunk.length)).toEqual([1000, 1000, 500]);
		expect(joinChunks(chunks)).toEqual(bytes);
	});

	test('the cap is the documented value, not the bisected one', () => {
		// 2 MB is what Cloudflare documents; a live object was measured
		// accepting 2,199,994 bytes. The gap is the margin, on purpose.
		expect(CHUNK_BYTES).toBe(2_097_152);
	});
});
