import type { DownloadService } from './types';
import { DownloadError } from './types';

export type { DownloadError, DownloadService } from './types';

/** File export is outside the Epicenter V1 capability set. */
export const DownloadServiceLive = {
	async downloadBlob() {
		return DownloadError.NotSupported();
	},
} satisfies DownloadService;
