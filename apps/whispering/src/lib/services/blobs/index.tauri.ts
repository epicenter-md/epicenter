import type { BlobReplica, Blobs } from '@epicenter/blobs';
import { createHttpBlobs, desktopBlobUrl } from '@epicenter/blobs/http';
import { Err, Ok } from 'wellcrafted/result';
import type { AudioBlobUrls } from './types.js';

export type { AudioBlobUrls } from './types.js';

export const AudioBlobsLive: Blobs = createHttpBlobs();

export const AudioBlobUrlsLive: AudioBlobUrls = {
	async open(id) {
		const { error } = await AudioBlobsLive.stat(id);
		if (error !== null) return Err(error);
		return Ok({ url: desktopBlobUrl(id), dispose() {} });
	},
};

/**
 * Desktop recording rows are still device-local. Do not offer a cloud copy
 * whose only manifest would disappear with this device; a later Account
 * workspace cutover must land with the host-owned streaming adapter.
 */
export const AudioBlobReplicaLive: BlobReplica | null = null;
