import type { BlobId, BlobNotFound, BlobStoreFailed } from '@epicenter/blobs';
import type { BrowserBlobUrlFailed } from '@epicenter/blobs/browser';
import type { Result } from 'wellcrafted/result';

export type AudioBlobUrl = {
	url: string;
	dispose(): void;
};

export type AudioBlobUrls = {
	open(
		id: BlobId,
	): Promise<
		Result<AudioBlobUrl, BlobNotFound | BlobStoreFailed | BrowserBlobUrlFailed>
	>;
};
