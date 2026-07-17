import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import { rowDocumentCodec } from './codec.js';

test('the production codec distinguishes Yjs updates from bounded junk bytes', () => {
	const document = new Y.Doc();
	try {
		document.get('content').insert(0, 'valid');
		expect(
			rowDocumentCodec.isValidUpdate(Y.encodeStateAsUpdate(document)),
		).toBe(true);
		expect(rowDocumentCodec.isValidUpdate(new Uint8Array([1, 2, 3]))).toBe(
			false,
		);
	} finally {
		document.destroy();
	}
});
