import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const { FfmpegServiceErr, FfmpegServiceError } =
	createTaggedError('FfmpegServiceError');

export type FfmpegServiceError = ReturnType<typeof FfmpegServiceError>;

export type FfmpegService = {
	/**
	 * Checks if FFmpeg is installed on the system.
	 * Returns Ok(true) if installed, Ok(false) if not installed.
	 */
	checkInstalled(): Promise<Result<boolean, FfmpegServiceError>>;

	/**
	 * Compresses an audio blob using FFmpeg with the specified compression options.
	 * Creates temporary files for processing and returns a compressed audio blob.
	 *
	 * @param blob - The input audio blob to compress
	 * @param compressionOptions - FFmpeg compression options (e.g., "-c:a libopus -b:a 32k -ar 16000 -ac 1")
	 * @returns A Result containing the compressed blob or an error
	 */
	compressAudioBlob(
		blob: Blob,
		compressionOptions: string,
	): Promise<Result<Blob, FfmpegServiceError>>;
};
