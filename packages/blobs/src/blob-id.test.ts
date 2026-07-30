/**
 * BlobId Mint/Parse Tests
 *
 * Locks the mint boundary (`generateBlobId`) and the parse boundary (the
 * `BlobId` arktype validator) together: everything minted must parse, and
 * the validator must reject foreign ids, especially bare 16-char nanoids,
 * which are what every other minted id in the repo looks like.
 *
 * Key behaviors:
 * - Mint/parse round trip: minted ids are accepted by the validator
 * - Representation stays filesystem/S3/XML-safe (blob_ + lowercase alnum)
 * - Validator rejects unprefixed, malformed, and path-hostile strings
 * - The brand blocks plain strings and foreign branded ids at compile time
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import { BlobId, generateBlobId, parseBlobId } from './blob-id.js';

test('generateBlobId mints ids the BlobId validator accepts (round trip)', () => {
	const id = generateBlobId();
	expect(BlobId(id)).toBe(id);
});

test('minted ids are blob_ plus 21 lowercase alphanumerics', () => {
	for (let i = 0; i < 1_000; i++) {
		expect(generateBlobId()).toMatch(/^blob_[a-z0-9]{21}$/);
	}
});

test('10k mints produce 10k distinct ids', () => {
	const ids = new Set(Array.from({ length: 10_000 }, () => generateBlobId()));
	expect(ids.size).toBe(10_000);
});

test('validator rejects unprefixed, malformed, and path-hostile strings', () => {
	const rejected = [
		'',
		'abcdefghijklmnop', // bare 16-char nanoid: a row id, not a BlobId
		'blob_',
		'blob_abcdefghijklmnopqrst', // 20-char body
		'blob_abcdefghijklmnopqrstuv', // 22-char body
		'blob_ABCDEFGHIJKLMNOPQRSTU', // uppercase
		'blob_abcdefghijklmnopqrs/u', // path separator
		'blob_abcdefghijklmnopqrs.u', // dot
		'../blob_abcdefghijklmnopqrstu',
		' blob_abcdefghijklmnopqrstu',
		'blob_abcdefghijklmnopqrstu ',
	];
	for (const value of rejected) {
		expect(BlobId(value)).toBeInstanceOf(type.errors);
	}
});

test('parseBlobId narrows valid input and returns undefined for invalid input', () => {
	const id = generateBlobId();
	expect(parseBlobId(id)).toBe(id);
	expect(parseBlobId('../escape')).toBeUndefined();
	expect(parseBlobId(null)).toBeUndefined();
});

describe('type errors', () => {
	test('plain strings and foreign branded ids are not BlobId at compile time', () => {
		const takesBlobId = (id: BlobId) => id;

		takesBlobId(generateBlobId());

		// @ts-expect-error: a plain string is not a BlobId even when shaped like one
		takesBlobId('blob_abcdefghijklmnopqrstu');

		type RowId = string & Brand<'RowId'>;
		const rowId = 'abcdefghijklmnop' as RowId;
		// @ts-expect-error: a differently-branded id is not a BlobId
		takesBlobId(rowId);

		expect(takesBlobId(generateBlobId())).toMatch(/^blob_/);
	});
});
