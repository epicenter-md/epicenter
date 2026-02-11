import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type GzipCompressOptions = {
	level?: Level;
	output?: 'bytes' | 'base64';
};

export type GzipDecompressOptions = {
	inputEncoding?: 'raw' | 'base64';
	output?: 'bytes' | 'string';
};

export type GzipNamespace = {
	/** Gzip-compress data (Uint8Array or string) into bytes (default) or base64 string */
	encode: typeof encode;
	/** Gzip-decompress data (Uint8Array or base64 string) into bytes (default) or string */
	decode: typeof decode;
};

const toUint8 = (data: Uint8Array | string): Uint8Array =>
	typeof data === 'string' ? strToU8(data) : data;

const toBase64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === undefined) continue;
		binary += String.fromCharCode(byte);
	}
	// btoa is available in browsers; for environments without btoa, a polyfill would be needed upstream.
	return btoa(binary);
};

const fromBase64 = (b64: string): Uint8Array => {
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
};

// Overloaded encode implementation
function encode(data: Uint8Array | string): Promise<Uint8Array>;
function encode(
	data: Uint8Array | string,
	options: { output: 'bytes'; level?: Level },
): Promise<Uint8Array>;
function encode(
	data: Uint8Array | string,
	options: { output: 'base64'; level?: Level },
): Promise<string>;
function encode(
	data: Uint8Array | string,
	options?: GzipCompressOptions,
): Promise<Uint8Array | string>;
async function encode(
	data: Uint8Array | string,
	options?: GzipCompressOptions,
) {
	const raw = gzipSync(toUint8(data), { level: options?.level ?? 6 }); // default is 6
	if (options?.output === 'base64') return toBase64(raw);
	return raw;
}

// Overloaded decode implementation
function decode(data: Uint8Array): Promise<Uint8Array>;
function decode(
	data: Uint8Array,
	options: { output: 'bytes'; inputEncoding?: 'raw' | 'base64' },
): Promise<Uint8Array>;
function decode(
	data: Uint8Array,
	options: { output: 'string'; inputEncoding?: 'raw' | 'base64' },
): Promise<string>;
function decode(
	data: string,
	options: { inputEncoding: 'base64'; output?: 'bytes' },
): Promise<Uint8Array>;
function decode(
	data: string,
	options: { inputEncoding: 'base64'; output: 'string' },
): Promise<string>;
function decode(
	data: Uint8Array | string,
	options?: GzipDecompressOptions,
): Promise<Uint8Array | string>;
async function decode(
	data: Uint8Array | string,
	options?: GzipDecompressOptions,
) {
	let bytes: Uint8Array;
	if (typeof data === 'string') {
		if ((options?.inputEncoding ?? 'raw') !== 'base64') {
			throw new Error('String input requires options.inputEncoding = "base64"');
		}
		bytes = fromBase64(data);
	} else {
		bytes = data;
	}
	const out = gunzipSync(bytes);
	if (options?.output === 'string') return strFromU8(out);
	return out;
}

// Export using functions with overloads
export const GZIP = { encode, decode } satisfies GzipNamespace;
