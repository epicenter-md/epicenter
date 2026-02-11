// Node.js built-in test runner specs for ZIP utilities
// Run with: node --test (after TypeScript compilation if needed)

import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ZIP } from './index';

function bytes(n: number): Uint8Array {
	const a = new Uint8Array(n);
	for (let i = 0; i < n; i++) a[i] = (i * 19 + 7) % 256;
	return a;
}

describe('ZIP.archive/extract', () => {
	it('archives and extracts multiple files preserving content', async () => {
		const files = {
			'a.txt': 'Hello world',
			'b.bin': bytes(256),
			'nested/c.txt': 'Nested file',
		};
		const zipped = await ZIP.pack(files, { level: 6 });
		assert.ok(zipped.length > 20);
		const out = await ZIP.unpack(zipped);
		// Basic presence checks
		assert.ok(out['a.txt']);
		assert.ok(out['b.bin']);
		assert.ok(out['nested/c.txt']);
		// Content verification
		const decoder = new TextDecoder();
		assert.equal(decoder.decode(out['a.txt']), 'Hello world');
		assert.equal(decoder.decode(out['nested/c.txt']), 'Nested file');
		const originalBin = files['b.bin'] as Uint8Array;
		const extractedBin = out['b.bin'];
		assert.equal(extractedBin.length, originalBin.length);
		for (let i = 0; i < originalBin.length; i++) {
			if (originalBin[i] !== extractedBin[i]) {
				assert.fail(`byte mismatch at ${i}`);
			}
		}
	});
});
