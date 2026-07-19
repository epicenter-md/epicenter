import type { BlobReplica, Blobs } from '@epicenter/blobs';
import {
	createBrowserBlobs,
	createBrowserBlobUrls,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobReplica,
	createEpicenterClient,
} from '@epicenter/client';
import { auth } from '#platform/auth';
import type { AudioBlobUrls } from './types.js';

export type { AudioBlobUrls } from './types.js';

export const AudioBlobsLive: Blobs = createBrowserBlobs();
export const AudioBlobUrlsLive: AudioBlobUrls =
	createBrowserBlobUrls(AudioBlobsLive);
const epicenterClient = createEpicenterClient({
	baseURL: auth.deployment.baseURL,
	fetch: auth.fetch,
});

/**
 * Browser-only remote copy adapter. Auth state remains live inside `auth.fetch`;
 * application operations still refuse calls while signed out so a missing
 * credential is a product state rather than an HTTP surprise.
 */
export const AudioBlobReplicaLive: BlobReplica | null =
	createBrowserBlobReplica({
		blobs: AudioBlobsLive,
		client: epicenterClient,
	});
