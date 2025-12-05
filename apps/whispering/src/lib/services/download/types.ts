import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const { DownloadServiceError, DownloadServiceErr } = createTaggedError(
	'DownloadServiceError',
);
export type DownloadServiceError = ReturnType<typeof DownloadServiceError>;

export type DownloadService = {
	downloadBlob: (args: {
		name: string;
		blob: Blob;
	}) => Promise<Result<void, DownloadServiceError>>;
};
