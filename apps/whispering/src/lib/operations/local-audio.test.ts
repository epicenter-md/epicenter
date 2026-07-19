import { expect, test } from 'bun:test';
import { BlobStoreError, parseBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { finalizeAudioBlob } from './local-audio';

test('commits captured bytes before returning the finalized blob id', async () => {
	const audio = new Blob(['audio'], { type: 'audio/webm' });
	let committed = false;

	const result = await finalizeAudioBlob(audio, {
		async put(id, blob) {
			expect(parseBlobId(id)).toBe(id);
			expect(blob).toBe(audio);
			committed = true;
			return Ok(undefined);
		},
	});

	expect(committed).toBe(true);
	expect(result.error).toBeNull();
	if (result.error !== null) return;
	expect(result.data.byteLength).toBe(audio.size);
	expect(parseBlobId(result.data.audioBlobId)).toBe(result.data.audioBlobId);
});

test('does not expose an id when local blob finalization fails', async () => {
	const result = await finalizeAudioBlob(new Blob(['audio']), {
		async put(id) {
			return BlobStoreError.BlobStoreFailed({
				id,
				cause: new Error('quota exceeded'),
			});
		},
	});

	expect(result.error).toMatchObject({
		name: 'BlobStoreFailed',
		cause: expect.any(Error),
	});
});
