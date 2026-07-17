import { describe, expect, test } from 'bun:test';
import { sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
	test('matches the NIST empty-string vector', () => {
		expect(sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	test('matches the NIST "abc" vector', () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	test('matches the NIST two-block vector', () => {
		expect(
			sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
		).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
	});

	test('encodes multibyte input as UTF-8', async () => {
		const expected = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode('schema é☃\u{1f600}'),
				),
			),
		)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		expect(sha256Hex('schema é☃\u{1f600}')).toBe(expected);
	});

	test('handles block-boundary lengths (55, 56, 64 bytes)', async () => {
		for (const length of [55, 56, 63, 64, 65]) {
			const input = 'a'.repeat(length);
			const expected = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						'SHA-256',
						new TextEncoder().encode(input),
					),
				),
			)
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
			expect(sha256Hex(input)).toBe(expected);
		}
	});
});
