/**
 * Synchronous SHA-256 over a UTF-8 string, returning lowercase hex.
 *
 * The sealed-round digest (ADR-0144) is computed inside synchronous SQLite
 * transactions in browsers, workers, and Bun alike; WebCrypto's digest is
 * async and `node:crypto` is not isomorphic, so this package carries the one
 * standard primitive the wire needs. FIPS 180-4, no options, no streaming:
 * canonical intent arrays and persistence keys are bounded strings.
 *
 * Verified against NIST vectors in `sha256.test.ts`.
 */

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number =>
	(value >>> bits) | (value << (32 - bits));

function wordAt(words: Uint32Array, index: number): number {
	const word = words[index];
	if (word === undefined) throw new RangeError('SHA-256 word index is invalid');
	return word;
}

/** Compute the SHA-256 digest of `input` (UTF-8) as lowercase hex. */
export function sha256Hex(input: string): string {
	return sha256HexBytes(new TextEncoder().encode(input));
}

function sha256HexBytes(message: Uint8Array): string {
	// Pad to a multiple of 64 bytes: 0x80, zeros, then the 64-bit bit length.
	const bitLength = message.length * 8;
	const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[message.length] = 0x80;
	const view = new DataView(padded.buffer);
	// Descriptors are far below 2^32 bits; the high word of the length is the
	// integer quotient anyway for completeness.
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(paddedLength - 4, bitLength >>> 0);

	// First 32 bits of the fractional parts of the square roots of the first 8 primes.
	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;

	const w = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let t = 0; t < 16; t++) {
			w[t] = view.getUint32(offset + t * 4);
		}
		for (let t = 16; t < 64; t++) {
			const word15 = wordAt(w, t - 15);
			const word2 = wordAt(w, t - 2);
			const s0 = rotr(word15, 7) ^ rotr(word15, 18) ^ (word15 >>> 3);
			const s1 = rotr(word2, 17) ^ rotr(word2, 19) ^ (word2 >>> 10);
			w[t] = (wordAt(w, t - 16) + s0 + wordAt(w, t - 7) + s1) >>> 0;
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;

		for (let t = 0; t < 64; t++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + ch + wordAt(K, t) + wordAt(w, t)) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((word) => word.toString(16).padStart(8, '0'))
		.join('');
}
