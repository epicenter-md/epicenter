import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, remove, writeFile } from '@tauri-apps/plugin-fs';
import { nanoid } from 'nanoid/non-secure';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { asShellCommand, CommandServiceLive } from './command';
import { FsServiceLive } from './fs';
import { getFileExtensionFromFfmpegOptions } from './recorder/ffmpeg';

export const { FfmpegServiceErr, FfmpegServiceError } =
	createTaggedError('FfmpegServiceError');

export type FfmpegServiceError = ReturnType<typeof FfmpegServiceError>;

export const FfmpegServiceLive = {
	/**
	 * Checks if FFmpeg is installed on the system.
	 * @returns Ok(true) if installed, Ok(false) if not installed.
	 */
	async checkInstalled() {
		const { data: shellFfmpegProcess, error: shellFfmpegError } =
			await tryAsync({
				try: async () => {
					const { data: result, error: commandError } =
						await CommandServiceLive.execute(asShellCommand('ffmpeg -version'));

					if (commandError) throw commandError;
					return result;
				},
				catch: (error) =>
					FfmpegServiceErr({
						message: `Unable to determine if FFmpeg is installed through shell. ${extractErrorMessage(error)}`,
					}),
			});

		if (shellFfmpegError) return Err(shellFfmpegError);
		return Ok(shellFfmpegProcess.code === 0);
	},

	/**
	 * Compresses an audio blob using FFmpeg with the specified compression options.
	 * Creates temporary files for processing and returns a compressed audio blob.
	 *
	 * @param blob - The input audio blob to compress
	 * @param compressionOptions - FFmpeg compression options (e.g., "-c:a libopus -b:a 32k -ar 16000 -ac 1")
	 * @returns A Result containing the compressed blob or an error
	 */
	async compressAudioBlob(blob: Blob, compressionOptions: string) {
		return await tryAsync({
			try: async () => {
				// Generate unique filenames for temporary files
				const sessionId = nanoid();
				const tempDir = await appDataDir();
				const inputPath = await join(
					tempDir,
					`compression_input_${sessionId}.wav`,
				);

				// Determine output extension and path based on compression options
				const outputExtension =
					getFileExtensionFromFfmpegOptions(compressionOptions);
				const outputPath = await join(
					tempDir,
					`compression_output_${sessionId}.${outputExtension}`,
				);

				try {
					// Write input blob to temporary file
					const inputContents = new Uint8Array(await blob.arrayBuffer());
					await writeFile(inputPath, inputContents);

					// Verify file is accessible (forces OS flush on Windows)
					const { error: verifyError } = await tryAsync({
						try: () => FsServiceLive.pathToBlob(inputPath),
						catch: (error) =>
							FfmpegServiceErr({
								message: `Temp file not accessible: ${extractErrorMessage(error)}`,
							}),
					});
					if (verifyError) throw new Error(verifyError.message);

					// Build FFmpeg command for compression using the utility function
					const command = buildCompressionCommand({
						inputPath,
						compressionOptions,
						outputPath,
					});

					// Execute FFmpeg compression command
					const { data: result, error: commandError } =
						await CommandServiceLive.execute(asShellCommand(command));
					if (commandError) {
						throw new Error(
							`FFmpeg compression failed: ${commandError.message}`,
						);
					}

					// Check if FFmpeg command was successful
					if (result.code !== 0) {
						throw new Error(
							`FFmpeg compression failed with exit code ${result.code}: ${result.stderr}`,
						);
					}

					// Verify output file exists
					const outputExists = await exists(outputPath);
					if (!outputExists) {
						throw new Error(
							'FFmpeg compression completed but output file was not created',
						);
					}

					// Read compressed file back as blob
					const { data: compressedBlob, error: readError } =
						await FsServiceLive.pathToBlob(outputPath);
					if (readError) {
						throw new Error(
							`Failed to read compressed audio file: ${readError.message}`,
						);
					}

					return compressedBlob;
				} finally {
					// Clean up temporary files
					await tryAsync({
						try: async () => {
							if (await exists(inputPath)) await remove(inputPath);
							if (await exists(outputPath)) await remove(outputPath);
						},
						catch: () => Ok(undefined), // Ignore cleanup errors
					});
				}
			},
			catch: (error) =>
				FfmpegServiceErr({
					message: `Audio compression failed: ${extractErrorMessage(error)}`,
				}),
		});
	},
};

export type FfmpegService = typeof FfmpegServiceLive;

/**
 * Builds a complete FFmpeg compression command string.
 * Creates a command that compresses an input audio file using the specified options.
 *
 * @param inputPath - Path to the input audio file
 * @param compressionOptions - FFmpeg compression options
 * @param outputPath - Path to the output compressed file
 * @returns Complete FFmpeg compression command string
 *
 * @example
 * buildCompressionCommand({ inputPath: 'input.wav', compressionOptions: '-c:a libopus -b:a 32k', outputPath: 'output.opus' })
 * // returns: 'ffmpeg -i "input.wav" -c:a libopus -b:a 32k "output.opus"'
 */
function buildCompressionCommand({
	inputPath,
	compressionOptions,
	outputPath,
}: {
	inputPath: string;
	compressionOptions: string;
	outputPath: string;
}) {
	// Build command parts
	const parts = [
		'ffmpeg',
		'-i',
		`"${inputPath}"`,
		compressionOptions.trim(),
		`"${outputPath}"`,
	].filter((part) => part); // Remove empty strings

	return parts.join(' ');
}
