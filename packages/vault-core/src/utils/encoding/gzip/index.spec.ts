// Node.js built-in test runner specs for GZIP utilities
// Run with: node --test (after TypeScript compilation if needed)

import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { GZIP } from './index';

const textSample = 'The quick brown fox jumps over the lazy dog';

function randomBytes(len: number): Uint8Array {
	const arr = new Uint8Array(len);
	for (let i = 0; i < len; i++) arr[i] = (i * 31 + 17) % 256; // deterministic pattern
	return arr;
}

describe('GZIP.compress/decompress', () => {
	it('roundtrips UTF-8 text (bytes path)', async () => {
		const gz = await GZIP.encode(textSample); // default bytes output
		const outBytes = await GZIP.decode(gz); // default bytes
		const decoded = new TextDecoder().decode(outBytes as Uint8Array);
		assert.equal(decoded, textSample);
	});

	it('roundtrips binary data', async () => {
		const bytes = randomBytes(1024);
		const gz = await GZIP.encode(bytes, { level: 9 });
		const raw = await GZIP.decode(gz);
		assert.equal(raw.length, bytes.length);
		for (let i = 0; i < raw.length; i++) {
			if (raw[i] !== bytes[i]) {
				assert.fail(`mismatch at index ${i}`);
			}
		}
	});
	it('produces base64 output and decodes back to text', async () => {
		const b64 = await GZIP.encode(textSample, { output: 'base64' });
		assert.equal(typeof b64, 'string');
		const decoded = await GZIP.decode(b64 as string, {
			inputEncoding: 'base64',
			output: 'string',
		});
		assert.equal(decoded, textSample);
	});

	it('errors when passing string without base64 flag', async () => {
		let threw = false;
		try {
			await GZIP.decode('not base64 data');
		} catch {
			threw = true;
		}
		assert.ok(threw);
	});
});
