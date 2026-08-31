/**
 * The storage contract, driven through the only implementation there is.
 *
 * These test `blobs.opfs.ts` over a supplied platform (`test-opfs.ts`) rather
 * than a second in-memory `Blobs`, because a second implementation is the
 * thing this seam was introduced to stop needing. What is asserted is what a
 * caller may assume: a key holds the bytes last written to it, a write is
 * whole or not at all, and one store's directory is the entire blast radius of
 * anything done to it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { type Blobs, keySegments } from './blobs.js';
import { createOpfsBlobs } from './blobs.opfs.js';
import { installTestOpfs } from './test-opfs.js';

installTestOpfs();

const ADDRESS = 'epicenter/v3/so.epicenter.honeycrisp/local/gen/1';

let blobs: Blobs;
let counter = 0;

beforeEach(() => {
	// A fresh root per test, because the fake persists for the process the way
	// a real origin persists for a profile.
	counter += 1;
	blobs = createOpfsBlobs({ root: `${ADDRESS}/${counter}` });
});

const bytes = (...values: number[]) => new Uint8Array(values);

describe('a key holds the bytes last written to it', () => {
	test('an unwritten key reads as undefined, which is a fact not a failure', async () => {
		expect(await blobs.read('app')).toBeUndefined();
	});

	test('a written key reads back exactly', async () => {
		await blobs.write('app', bytes(1, 2, 3));
		expect(await blobs.read('app')).toEqual(bytes(1, 2, 3));
	});

	test('a second write replaces rather than appends', async () => {
		await blobs.write('app', bytes(1, 2, 3, 4, 5));
		await blobs.write('app', bytes(9));
		expect(await blobs.read('app')).toEqual(bytes(9));
	});

	test('a nested key creates what it implies', async () => {
		await blobs.write('notes/abc', bytes(7));
		expect(await blobs.read('notes/abc')).toEqual(bytes(7));
	});

	test('reading a nested key under a directory that was never made is undefined', async () => {
		expect(await blobs.read('notes/never')).toBeUndefined();
	});

	test('the value handed back cannot be used to mutate what is stored', async () => {
		await blobs.write('app', bytes(1, 2, 3));
		const read = await blobs.read('app');
		(read as Uint8Array)[0] = 99;
		expect(await blobs.read('app')).toEqual(bytes(1, 2, 3));
	});
});

describe('removal', () => {
	test('removing a key forgets it', async () => {
		await blobs.write('notes/abc', bytes(1));
		await blobs.remove('notes/abc');
		expect(await blobs.read('notes/abc')).toBeUndefined();
	});

	test('removing what is not there is success, because a discard runs again', async () => {
		await blobs.remove('notes/never');
		await blobs.remove('never/at/all');
	});

	test('removing one key leaves its siblings', async () => {
		await blobs.write('notes/abc', bytes(1));
		await blobs.write('notes/def', bytes(2));
		await blobs.remove('notes/abc');
		expect(await blobs.read('notes/def')).toEqual(bytes(2));
	});
});

describe('list', () => {
	beforeEach(async () => {
		await blobs.write('app', bytes(1));
		await blobs.write('notes/abc', bytes(2));
		await blobs.write('notes/def', bytes(3));
		await blobs.write('folders/xyz', bytes(4));
	});

	test('the empty prefix is everything, as full keys', async () => {
		expect((await blobs.list('')).sort()).toEqual([
			'app',
			'folders/xyz',
			'notes/abc',
			'notes/def',
		]);
	});

	test('a prefix is a subtree', async () => {
		expect((await blobs.list('notes')).sort()).toEqual([
			'notes/abc',
			'notes/def',
		]);
	});

	test('a prefix nothing was written under is empty rather than an error', async () => {
		expect(await blobs.list('tasks')).toEqual([]);
	});

	test('a prefix matches at segment boundaries, never mid-segment', async () => {
		await blobs.write('notesy/ghi', bytes(5));
		expect((await blobs.list('notes')).sort()).toEqual([
			'notes/abc',
			'notes/def',
		]);
	});
});

describe('one store cannot reach another', () => {
	test('two roots holding the same key hold different bytes', async () => {
		const other = createOpfsBlobs({ root: `${ADDRESS}/${counter}-other` });
		await blobs.write('app', bytes(1));
		await other.write('app', bytes(2));
		expect(await blobs.read('app')).toEqual(bytes(1));
		expect(await other.read('app')).toEqual(bytes(2));
	});
});

describe('a key is slash-separated segments, and nothing else', () => {
	test.each([
		['', 'empty'],
		['a//b', 'an empty segment'],
		['a/./b', 'a dot'],
		['../a', 'a parent'],
	])('%s is refused (%s)', (key) => {
		expect(() => keySegments(key)).toThrow();
	});

	test('a key that escapes its root is refused before any storage is touched', async () => {
		await expect(blobs.read('../elsewhere')).rejects.toThrow();
	});
});
