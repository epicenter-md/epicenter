/**
 * Bun Filesystem Blob Store Tests
 *
 * Verifies the desktop filesystem implementation of the shared local blob
 * contract and its streaming request extension.
 *
 * Key behaviors:
 * - Complete body and metadata directories publish atomically
 * - Immutable identifiers refuse replacement, including concurrent writers
 * - Stat verifies data presence and exact size without loading its bytes
 * - Request bodies stream into the store without becoming an in-memory Blob
 * - Runtime BlobId validation protects every filesystem operation
 * - Missing reads and repeated deletes keep their typed contract
 */

import { afterEach, expect, test } from 'bun:test';
import {
	stat as fsStat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type BlobId, generateBlobId } from './blob-id.js';
import { createBunBlobStore } from './bun.js';

const testDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		testDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
	testDirectories.push(directory);
	return { blobs: createBunBlobStore({ directory }), directory };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fsStat(path);
		return true;
	} catch (cause) {
		if (
			cause instanceof Error &&
			'code' in cause &&
			(cause as Error & { code?: unknown }).code === 'ENOENT'
		) {
			return false;
		}
		throw cause;
	}
}

async function setupHostilePathTarget() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-hostile-bun-blobs-'));
	testDirectories.push(root);
	const directory = join(root, 'blobs');
	const outside = join(root, 'outside');
	await mkdir(directory);
	await mkdir(outside);
	await writeFile(join(outside, 'sentinel'), 'untouched');
	await writeFile(join(outside, 'data'), 'outside bytes');
	await writeFile(
		join(outside, 'metadata.json'),
		JSON.stringify({ contentType: 'text/plain', size: 13 }),
	);
	return {
		blobs: createBunBlobStore({ directory }),
		directory,
		outside,
		hostileId: '../outside' as BlobId,
	};
}

test('put stores immutable bytes and metadata under one id', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	const input = new Blob(['hello'], { type: 'text/plain' });

	expectOk(await blobs.put(id, input));
	const stored = expectOk(await blobs.get(id));

	expect(stored).toBeInstanceOf(Blob);
	expect(stored.type).toStartWith('text/plain');
	expect(await stored.text()).toBe('hello');
	expect(expectOk(await blobs.stat(id))).toEqual({
		contentType: input.type,
		size: 5,
	});
});

test('put refuses to replace bytes under an existing id', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['first'])));

	const error = expectErr(await blobs.put(id, new Blob(['second'])));

	expect(error.name).toBe('BlobAlreadyExists');
	expect(await expectOk(await blobs.get(id)).text()).toBe('first');
});

test('concurrent puts publish one complete immutable object', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	const results = await Promise.all([
		blobs.put(id, new Blob(['first'], { type: 'text/first' })),
		blobs.put(id, new Blob(['second'], { type: 'text/second' })),
	]);

	expect(results.filter((result) => result.error === null)).toHaveLength(1);
	expect(
		results.filter((result) => result.error?.name === 'BlobAlreadyExists'),
	).toHaveLength(1);
	const stored = expectOk(await blobs.get(id));
	expect(['first', 'second']).toContain(await stored.text());
});

test('putRequest keeps the final id invisible until the stream completes', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let chunk = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (chunk === 0) {
				chunk += 1;
				controller.enqueue(new TextEncoder().encode('first'));
				started.resolve();
				return;
			}
			if (chunk === 1) {
				chunk += 1;
				return release.promise.then(() => {
					controller.enqueue(new TextEncoder().encode('-second'));
					controller.close();
				});
			}
		},
	});
	const request = new Request('http://127.0.0.1/upload', {
		method: 'PUT',
		headers: { 'content-type': 'audio/test' },
		body,
	});

	const write = blobs.putRequest(id, request);
	await started.promise;
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobNotFound');
	release.resolve();
	expectOk(await write);

	const stored = expectOk(await blobs.get(id));
	expect(stored.type).toBe('audio/test');
	expect(await stored.text()).toBe('first-second');
});

test('putRequest streams a large multi-chunk body without truncation', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	const chunkSize = 128 * 1024;
	const chunkCount = 96;
	let chunkIndex = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (chunkIndex === chunkCount) {
				controller.close();
				return;
			}
			controller.enqueue(new Uint8Array(chunkSize).fill(chunkIndex % 251));
			chunkIndex += 1;
		},
	});
	const request = new Request('http://127.0.0.1/upload', {
		method: 'PUT',
		headers: { 'content-type': 'audio/test' },
		body,
	});

	expectOk(await blobs.putRequest(id, request));
	expect(expectOk(await blobs.stat(id)).size).toBe(chunkSize * chunkCount);
	const bytes = new Uint8Array(
		await expectOk(await blobs.get(id)).arrayBuffer(),
	);
	for (const sample of [0, 1, 47, chunkCount - 1]) {
		expect(bytes[sample * chunkSize]).toBe(sample % 251);
		expect(bytes[(sample + 1) * chunkSize - 1]).toBe(sample % 251);
	}
});

test('putRequest removes partial staging bytes when the source stream throws', async () => {
	const { blobs, directory } = await setup();
	const id = generateBlobId();
	let pullCount = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pullCount += 1;
			if (pullCount === 1) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024).fill(7));
				return;
			}
			controller.error(new Error('source failed'));
		},
	});
	const request = new Request('http://127.0.0.1/upload', {
		method: 'PUT',
		body,
	});

	expect(expectErr(await blobs.putRequest(id, request)).name).toBe(
		'BlobStoreFailed',
	);
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobNotFound');
	expect(await readdir(join(directory, '.staging', 'bun'))).toEqual([]);
});

test('stat fails when immutable data is missing or differs from metadata', async () => {
	const { blobs, directory } = await setup();
	const id = generateBlobId();
	expectOk(
		await blobs.put(id, new Blob(['bytes'], { type: 'application/test' })),
	);
	await unlink(join(directory, id, 'data'));

	expect(expectErr(await blobs.stat(id)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.get(id)).name).toBe('BlobStoreFailed');

	await writeFile(join(directory, id, 'data'), 'different-size');
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.get(id)).name).toBe('BlobStoreFailed');
});

test('corrupt content-type metadata never reaches an HTTP header boundary', async () => {
	const { blobs, directory } = await setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['bytes'], { type: 'audio/wav' })));
	await writeFile(
		join(directory, id, 'metadata.json'),
		JSON.stringify({ contentType: 'audio/wav\r\nx-injected: yes', size: 5 }),
	);

	expect(expectErr(await blobs.stat(id)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.get(id)).name).toBe('BlobStoreFailed');
});

test('missing reads are typed and repeated deletes succeed', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();

	expect(expectErr(await blobs.get(id)).name).toBe('BlobNotFound');
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobNotFound');
	expectOk(await blobs.delete(id));
	expectOk(await blobs.delete(id));
});

test('get rejects a path-hostile runtime id before reading outside the store', async () => {
	const { blobs, outside, hostileId } = await setupHostilePathTarget();

	expect(expectErr(await blobs.get(hostileId)).name).toBe('BlobStoreFailed');
	expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
});

test('stat rejects a path-hostile runtime id before reading outside the store', async () => {
	const { blobs, outside, hostileId } = await setupHostilePathTarget();

	expect(expectErr(await blobs.stat(hostileId)).name).toBe('BlobStoreFailed');
	expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
});

test('put rejects a path-hostile runtime id before writing outside the store', async () => {
	const { blobs, directory, outside } = await setupHostilePathTarget();
	const escaped = join(directory, '..', 'escaped-put');

	expect(
		expectErr(await blobs.put('../escaped-put' as BlobId, new Blob(['bad'])))
			.name,
	).toBe('BlobStoreFailed');
	expect(await pathExists(escaped)).toBe(false);
	expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
});

test('delete rejects a path-hostile runtime id before deleting outside the store', async () => {
	const { blobs, outside, hostileId } = await setupHostilePathTarget();

	expect(expectErr(await blobs.delete(hostileId)).name).toBe('BlobStoreFailed');
	expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
});

test('putResponse streams a response body under its content type', async () => {
	const { blobs } = await setup();
	const id = generateBlobId();
	const response = new Response('response bytes', {
		headers: { 'content-type': 'audio/test' },
	});

	expectOk(await blobs.putResponse(id, response));
	const stat = expectOk(await blobs.stat(id));
	expect(stat).toEqual({ contentType: 'audio/test', size: 14 });
	const read = expectOk(await blobs.get(id));
	expect(await read.text()).toBe('response bytes');
});
