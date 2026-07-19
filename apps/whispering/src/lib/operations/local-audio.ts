import { type BlobStore, generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { services } from '$lib/services';

/** Mint an opaque id and commit browser-provided bytes before any row exists. */
export async function finalizeAudioBlob(
	blob: Blob,
	local: Pick<BlobStore, 'put'> = services.blobs.local,
) {
	const audioBlobId = generateBlobId();
	const result = await local.put(audioBlobId, blob);
	if (result.error !== null) return result;
	return Ok({ audioBlobId, byteLength: blob.size });
}
