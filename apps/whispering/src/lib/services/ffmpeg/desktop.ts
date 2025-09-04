import { IS_WINDOWS } from '$lib/constants/platform';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { type FfmpegService, FfmpegServiceErr } from './types';
import { writeFile, remove, exists } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { nanoid } from 'nanoid/non-secure';
import * as services from '$lib/services';
import {
	buildCompressionCommand,
	getFileExtensionFromFfmpegOptions,
} from '../recorder/ffmpeg';
import { asShellCommand } from '../command/types';

export function createFfmpegService(): FfmpegService {
	return {
		async checkInstalled() {
			const { data: shellFfmpegProcess, error: shellFfmpegError } =
				await tryAsync({
					try: async () => {
						const { Command } = await import('@tauri-apps/plugin-shell');
						const output = await (IS_WINDOWS
							? Command.create('cmd', ['/c', 'ffmpeg -version'])
							: Command.create('sh', ['-c', 'ffmpeg -version'])
						).execute();
						return output;
					},
					catch: (error) =>
						FfmpegServiceErr({
							message: `Unable to determine if FFmpeg is installed through shell. ${extractErrorMessage(error)}`,
							cause: error,
						}),
				});

			if (shellFfmpegError) return Err(shellFfmpegError);
			return Ok(shellFfmpegProcess.code === 0);
		},

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

						// Build FFmpeg command for compression using the utility function
						const { command } = buildCompressionCommand({
							inputPath,
							compressionOptions,
							outputPath,
						});

						// Execute FFmpeg compression command
						const { data: result, error: commandError } =
							await services.command.execute(asShellCommand(command));
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
							await services.fs.pathToBlob(outputPath);
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
						context: { compressionOptions },
						cause: error,
					}),
			});
		},
	};
}
