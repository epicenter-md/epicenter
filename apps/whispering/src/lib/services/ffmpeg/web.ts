import { Ok } from 'wellcrafted/result';
import type { FfmpegService } from './types';
import { FfmpegServiceErr } from './types';

export function createFfmpegServiceWeb(): FfmpegService {
	return {
		async checkInstalled() {
			// FFmpeg check is not available in web version, assume not installed
			return Ok(false);
		},

		async compressAudioBlob(_blob: Blob, compressionOptions: string) {
			// Audio compression is not available in web version
			return FfmpegServiceErr({
				message:
					'Audio compression is not available in the web version. FFmpeg is only supported in the desktop application.',
				context: { compressionOptions },
				cause: undefined,
			});
		},
	};
}
