import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { TAR } from './index';

describe('TAR', () => {
	it('packs and unpacks single text file', async () => {
		const files = { 'hello.txt': 'hello world' };
		const tar = await TAR.pack(files);
		assert.ok(tar instanceof Uint8Array);
		assert.equal(tar.length % 512, 0);
		const unpacked = await TAR.unpack(tar);
		assert.equal(Object.keys(unpacked).length, 1);
		assert.equal(
			new TextDecoder().decode(unpacked['hello.txt']),
			'hello world',
		);
	});

	it('packs and unpacks binary file', async () => {
		const bin = new Uint8Array(100);
		for (let i = 0; i < bin.length; i++) bin[i] = i;
		const files = { 'data.bin': bin };
		const tar = await TAR.pack(files);
		const unpacked = await TAR.unpack(tar);
		assert.equal(unpacked['data.bin']?.length, 100);
		assert.equal(unpacked['data.bin']?.[50], 50);
	});

	it('handles multiple files and preserves content', async () => {
		const files = {
			'a.txt': 'A',
			'path/b.txt': 'Bee',
			'nested/deep/c.txt': 'Sea',
		};
		const tar = await TAR.pack(files);
		const unpacked = await TAR.unpack(tar);
		assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(files).sort());
		for (const k of Object.keys(files) as Array<keyof typeof files>) {
			assert.equal(new TextDecoder().decode(unpacked[k]), files[k]);
		}
	});

	it('aligns file data to 512-byte boundaries (padding check)', async () => {
		const content = 'x'.repeat(700); // crosses one 512 boundary, requires padding
		const tar = await TAR.pack({ 'pad.txt': content });
		// header (512) + data padded to 1024 (data + padding) + two zero-blocks (1024) => total 2560
		assert.equal(tar.length, 2560);
	});
});
