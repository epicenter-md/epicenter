import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists, remove, stat } from '@tauri-apps/plugin-fs';
import { Child } from '@tauri-apps/plugin-shell';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';
import { PLATFORM_TYPE } from '$lib/constants/platform';
import * as services from '$lib/services';
import { asShellCommand } from '$lib/services/command';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '../types';
import { asDeviceIdentifier } from '../types';
import type {
	FfmpegRecordingParams,
	RecorderService,
	RecorderServiceError,
} from './types';
import { RecorderServiceErr } from './types';

/**
 * Default FFmpeg global options.
 *
 * Empty by default - users can add options to control FFmpeg's general behavior:
 * - `-hide_banner`: Hide the startup banner
 * - `-loglevel warning`: Set logging level (error, warning, info, verbose, debug)
 * - `-nostats`: Disable progress statistics
 * - `-y`: Overwrite output files without asking
 *
 * @example
 * // User might set: '-hide_banner -loglevel warning'
 */
export const FFMPEG_DEFAULT_GLOBAL_OPTIONS = '' as const;

/**
 * Default FFmpeg output options optimized for Whisper transcription.
 *
 * Configuration:
 * - **Format**: WAV PCM 16-bit (`pcm_s16le`) - Uncompressed audio for maximum compatibility
 * - **Sample Rate**: 16kHz - Matches Whisper's expected input frequency
 * - **Channels**: Mono (`-ac 1`) - Single channel audio for consistent processing
 *
 * Benefits:
 * - Universal browser compatibility (all HTML5 audio elements support WAV)
 * - No codec issues or browser-specific quirks
 * - Direct PCM audio data, no compression artifacts
 * - Optimized for Whisper's audio processing pipeline
 *
 * @example
 * // Using default output options
 * const command = `ffmpeg -i input ${FFMPEG_DEFAULT_OUTPUT_OPTIONS} output.wav`;
 */
export const FFMPEG_DEFAULT_OUTPUT_OPTIONS =
	'-acodec pcm_s16le -ar 16000 -ac 1' as const;

/**
 * Default FFmpeg compression options optimized for transcription.
 *
 * Configuration:
 * - **Format**: Opus codec (`libopus`) - Best speech compression codec
 * - **Bitrate**: 32kbps - Good balance of size vs quality for speech
 * - **Sample Rate**: 16kHz - Matches transcription service expectations
 * - **Channels**: Mono (`-ac 1`) - Single channel for speech
 * - **Compression Level**: 10 - Maximum compression efficiency
 *
 * Benefits:
 * - ~6x smaller files than uncompressed WAV
 * - Preserves speech quality for accurate transcription
 * - Reduces bandwidth usage for API calls
 * - Supported by all major transcription services
 *
 * @example
 * // Typical compression: 1.5MB WAV → 240KB Opus
 * const command = `ffmpeg -i input.wav ${FFMPEG_DEFAULT_COMPRESSION_OPTIONS} output.opus`;
 */
export const FFMPEG_DEFAULT_COMPRESSION_OPTIONS =
	'-af silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:detection=peak,aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono -c:a libopus -b:a 32k -ar 16000 -ac 1 -compression_level 10' as const;

/**
 * Variant of the default compression preset prioritizing smallest file size.
 *
 * Identical to {@link FFMPEG_DEFAULT_COMPRESSION_OPTIONS} except for the lower
 * Opus bitrate (16kbps instead of 32kbps).
 */
export const FFMPEG_SMALLEST_COMPRESSION_OPTIONS =
	FFMPEG_DEFAULT_COMPRESSION_OPTIONS.replace('-b:a 32k', '-b:a 16k') as const;

/**
 * Default FFmpeg input options for the current platform.
 *
 * Specifies the audio capture framework to use based on the operating system:
 * - **macOS**: AVFoundation (`-f avfoundation`) - Apple's audio/video framework
 * - **Windows**: DirectShow (`-f dshow`) - Windows multimedia framework
 * - **Linux**: ALSA (`-f alsa`) - Advanced Linux Sound Architecture
 *
 * These options tell FFmpeg which audio subsystem to use for capturing input
 * from the system's audio devices.
 *
 * @example
 * // Platform-specific usage
 * const command = `ffmpeg ${FFMPEG_DEFAULT_INPUT_OPTIONS} -i device output.wav`;
 */
export const FFMPEG_DEFAULT_INPUT_OPTIONS = (
	{
		macos: '-f avfoundation',
		windows: '-f dshow',
		linux: '-f alsa',
	} as const
)[PLATFORM_TYPE];

/**
 * Platform-specific command to enumerate available audio recording devices.
 *
 * Commands by platform:
 * - **macOS**: Uses FFmpeg with AVFoundation to list devices
 * - **Windows**: Uses FFmpeg with DirectShow to list devices
 * - **Linux**: Uses `arecord` to list ALSA devices
 *
 * The output of these commands is parsed by `parseDevices()` to extract
 * device IDs and labels for the UI.
 *
 * @example
 * // Execute device enumeration
 * const command = asShellCommand(FFMPEG_ENUMERATE_DEVICES_COMMAND);
 * const result = await services.command.execute(command);
 */
export const FFMPEG_ENUMERATE_DEVICES_COMMAND = (
	{
		macos: 'ffmpeg -f avfoundation -list_devices true -i ""',
		windows: 'ffmpeg -list_devices true -f dshow -i dummy',
		linux: 'arecord -l',
	} as const
)[PLATFORM_TYPE];

/**
 * Default audio device identifier for the current platform.
 *
 * These are fallback device identifiers used when:
 * - No devices can be enumerated
 * - User hasn't selected a specific device
 * - The selected device is unavailable
 *
 * Platform defaults:
 * - **macOS**: `"0"` - First audio device index in AVFoundation
 * - **Windows**: `"default"` - System default DirectShow audio capture device
 * - **Linux**: `"default"` - System default ALSA/PulseAudio device
 *
 * @example
 * // Using as fallback
 * const deviceId = selectedDeviceId ?? FFMPEG_DEFAULT_DEVICE_IDENTIFIER;
 */
export const FFMPEG_DEFAULT_DEVICE_IDENTIFIER = asDeviceIdentifier(
	{
		macos: '0', // Use first audio device index for avfoundation
		windows: 'default', // Default DirectShow audio capture
		linux: 'default', // Default ALSA/PulseAudio device
	}[PLATFORM_TYPE],
);

export function createFfmpegRecorderService(): RecorderService {
	// In-memory recording state - simple and straightforward
	let activeChild: Child | null = null;
	let activeOutputPath: string | null = null;

	const enumerateDevices = async (): Promise<
		Result<Device[], RecorderServiceError>
	> => {
		// Build platform-specific commands
		const command = asShellCommand(FFMPEG_ENUMERATE_DEVICES_COMMAND);

		const { data: result, error: executeError } =
			await services.command.execute(command);
		if (executeError) {
			return RecorderServiceErr({
				message: 'Failed to enumerate recording devices',
				cause: executeError,
			});
		}

		// FFmpeg lists devices to stderr, not stdout
		const output = result.stderr;

		const devices = parseDevices(output);

		if (devices.length === 0) {
			return RecorderServiceErr({
				message: 'No recording devices found',
				context: { output },
				cause: undefined,
			});
		}

		return Ok(devices);
	};

	return {
		getRecorderState: async (): Promise<
			Result<WhisperingRecordingState, RecorderServiceError>
		> => {
			return Ok(activeChild ? 'RECORDING' : 'IDLE');
		},

		enumerateDevices,

		startRecording: async (
			{
				selectedDeviceId,
				outputFolder,
				recordingId,
				globalOptions,
				inputOptions,
				outputOptions,
			}: FfmpegRecordingParams,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
			// Stop any existing recording
			if (activeChild) {
				await tryAsync({
					try: async () => {
						await activeChild.kill();
						console.log('Killed existing FFmpeg process');
					},
					catch: () => Ok(undefined),
				});
				activeChild = null;
				activeOutputPath = null;
			}

			// Enumerate devices to validate selection
			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError) return Err(enumerateError);

			const acquireDevice = (): Result<
				DeviceAcquisitionOutcome,
				RecorderServiceError
			> => {
				const deviceIds = devices.map((d) => d.id);
				const fallbackDeviceId = deviceIds.at(0);

				if (!fallbackDeviceId) {
					return RecorderServiceErr({
						message: selectedDeviceId
							? "We couldn't find the selected microphone. Make sure it's connected and try again!"
							: "We couldn't find any microphones. Make sure they're connected and try again!",
						context: { selectedDeviceId, deviceIds },
						cause: undefined,
					});
				}

				if (!selectedDeviceId) {
					sendStatus({
						title: '🔍 No Device Selected',
						description:
							"No worries! We'll find the best microphone for you automatically...",
					});
					return Ok({
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					});
				}

				const deviceExists = deviceIds.includes(selectedDeviceId);

				if (deviceExists)
					return Ok({ outcome: 'success', deviceId: selectedDeviceId });

				sendStatus({
					title: '⚠️ Finding a New Microphone',
					description:
						"That microphone isn't available. Let's try finding another one...",
				});

				return Ok({
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				});
			};

			const { data: deviceOutcome, error: acquireDeviceError } =
				acquireDevice();
			if (acquireDeviceError) return Err(acquireDeviceError);
			const deviceIdentifier = deviceOutcome.deviceId;

			// Determine the file extension from the output options
			const fileExtension = getFileExtensionFromFfmpegOptions(outputOptions);

			// Construct the output path
			const outputPath = await join(
				outputFolder,
				`${recordingId}.${fileExtension}`,
			);

			// Build FFmpeg command using the shared function
			const command = buildFfmpegCommand({
				globalOptions,
				inputOptions,
				deviceIdentifier,
				outputOptions,
				outputPath,
			});

			sendStatus({
				title: '🎤 Setting Up',
				description: 'Initializing FFmpeg recording session...',
			});

			// Use command service to spawn FFmpeg process
			// This will now throw if FFmpeg exits immediately with an error
			const { data: process, error: startError } = await services.command.spawn(
				asShellCommand(command),
			);

			if (startError) {
				// The spawn function already caught the FFmpeg error and extracted the message
				return RecorderServiceErr({
					message: 'Failed to start recording',
					context: { command },
					cause: startError,
				});
			}

			// Store the Child object and output path in memory
			activeChild = process;
			activeOutputPath = outputPath;

			sendStatus({
				title: '🎙️ Recording',
				description: 'FFmpeg is now recording audio...',
			});

			return Ok(deviceOutcome);
		},

		stopRecording: async ({
			sendStatus,
		}): Promise<Result<Blob, RecorderServiceError>> => {
			if (!activeChild || !activeOutputPath) {
				return RecorderServiceErr({
					message: 'No active recording to stop',
					cause: undefined,
				});
			}

			sendStatus({
				title: '⏹️ Stopping',
				description: 'Stopping FFmpeg recording...',
			});

			// Helper: Schedule backup force kill in case FFmpeg hangs
			const scheduleBackupKill = (delayMs: number) => {
				setTimeout(() => {
					activeChild?.kill().catch(() => {
						// Expected: process may have already exited gracefully
					});
				}, delayMs);
			};

			// Stop FFmpeg gracefully using SIGINT
			const { error: stopError } = await tryAsync({
				try: async () => {
					await sendSigint(activeChild.pid);
					scheduleBackupKill(2000);
				},
				catch: (error) =>
					RecorderServiceErr({
						message: `Failed to stop FFmpeg process: ${extractErrorMessage(error)}`,
						cause: error,
					}),
			});

			if (stopError) {
				sendStatus({
					title: '❌ Error Stopping Recording',
					description:
						"We couldn't stop the recording properly. Attempting to recover your audio...",
				});
			}

			const outputPath = activeOutputPath;

			// Clear state
			activeChild = null;
			activeOutputPath = null;

			// Poll for file stabilization
			const MAX_WAIT_TIME = 3000; // 3 seconds max
			const POLL_INTERVAL = 100; // Check every 100ms
			const startTime = Date.now();
			let lastSize = -1;
			let stableChecks = 0;
			const STABLE_THRESHOLD = 2; // File size must be stable for 2 checks

			while (Date.now() - startTime < MAX_WAIT_TIME) {
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

				await tryAsync({
					try: async () => {
						const fileExists = await exists(outputPath);
						if (fileExists) {
							const stats = await stat(outputPath);
							const currentSize = stats.size;

							// Check if file size has stabilized
							if (currentSize > 0 && currentSize === lastSize) {
								stableChecks++;
								if (stableChecks >= STABLE_THRESHOLD) {
									// File is stable, FFmpeg has finished
									return;
								}
							} else {
								// Size changed, reset stability counter
								stableChecks = 0;
								lastSize = currentSize;
							}
						}
					},
					catch: () => Ok(undefined), // File might not exist yet, continue polling
				});

				// Break if file is stable
				if (stableChecks >= STABLE_THRESHOLD) break;
			}

			// Read the recorded file
			sendStatus({
				title: '📁 Reading Recording',
				description: 'Loading your recording from disk...',
			});

			const { data: blob, error: readError } =
				await services.fs.pathToBlob(outputPath);

			if (readError) {
				return RecorderServiceErr({
					message: 'Unable to read recording file',
					cause: readError,
				});
			}

			// Validate the blob has actual content
			if (!blob || blob.size === 0) {
				return RecorderServiceErr({
					message: 'Recording file is empty',
					context: { blobSize: blob?.size },
					cause: undefined,
				});
			}

			return Ok(blob);
		},

		cancelRecording: async ({
			sendStatus,
		}): Promise<Result<CancelRecordingResult, RecorderServiceError>> => {
			if (!activeChild) {
				return Ok({ status: 'no-recording' });
			}

			sendStatus({
				title: '🛑 Cancelling',
				description: 'Stopping FFmpeg recording and cleaning up...',
			});

			const pathToCleanup = activeOutputPath;

			// Kill the process
			await tryAsync({
				try: async () => {
					await activeChild.kill();
					console.log('Killed FFmpeg process during cancellation');
				},
				catch: () => Ok(undefined),
			});

			// Clear state
			activeChild = null;
			activeOutputPath = null;

			// Delete the output file if it exists
			if (pathToCleanup) {
				const { error: removeError } = await tryAsync({
					try: async () => {
						const fileExists = await exists(pathToCleanup);
						if (fileExists) await remove(pathToCleanup);
					},
					catch: (error) =>
						RecorderServiceErr({
							message: 'Failed to delete recording file',
							context: { path: pathToCleanup },
							cause: error,
						}),
				});

				if (removeError) {
					sendStatus({
						title: '❌ Error Deleting Recording File',
						description:
							"We couldn't delete the recording file. Continuing with the cancellation process...",
					});
				}
			}

			return Ok({ status: 'cancelled' });
		},
	};
}

/**
 * FFmpeg recorder service that uses FFmpeg command-line tool for recording.
 * Only available in desktop environment.
 */
export const FfmpegRecorderServiceLive = createFfmpegRecorderService();

/**
 * Parse FFmpeg device enumeration output based on platform
 */
function parseDevices(output: string): Device[] {
	// Platform-specific parsing configuration
	const platformConfig = {
		macos: {
			// macOS format: [AVFoundation input device @ 0x...] [0] Built-in Microphone
			regex: /\[AVFoundation.*?\]\s+\[(\d+)\]\s+(.+)/,
			extractDevice: (match) => ({
				id: asDeviceIdentifier(match[2].trim()),
				label: match[2].trim(),
			}),
		},
		windows: {
			// Windows DirectShow format: [dshow @ 0x...] "Microphone Name" (audio)
			regex: /\[dshow[^\]]*\]\s+"(.+?)"\s+\(audio\)/,
			extractDevice: (match) => ({
				id: asDeviceIdentifier(match[1]),
				label: match[1],
			}),
		},
		linux: {
			// Linux ALSA format: hw:0,0 Device Name
			regex: /^(hw:\d+,\d+)\s+(.+)/,
			extractDevice: (match) => ({
				id: asDeviceIdentifier(match[1]),
				label: match[2].trim(),
			}),
		},
	} satisfies Record<
		string,
		{ regex: RegExp; extractDevice: (match: RegExpMatchArray) => Device }
	>;

	// Select configuration based on platform
	const config = platformConfig[PLATFORM_TYPE];

	// Parse all devices
	const allDevices = output.split('\n').reduce<Device[]>((devices, line) => {
		const match = line.match(config.regex);
		if (match) devices.push(config.extractDevice(match));
		return devices;
	}, []);

	// Deduplicate devices based on ID (important for macOS where devices appear in both video and audio sections)
	const seenIds = new Set<string>();
	return allDevices.filter((device) => {
		if (seenIds.has(device.id)) return false;
		seenIds.add(device.id);
		return true;
	});
}

/**
 * Format device identifier for platform-specific FFmpeg input
 * @param deviceId The device identifier to format
 * @returns The formatted device string for FFmpeg -i parameter
 */
export function formatDeviceForPlatform(deviceId: string) {
	switch (PLATFORM_TYPE) {
		case 'macos':
			return `:${deviceId}`; // macOS uses :deviceName
		case 'windows':
			return `audio="${deviceId}"`; // Windows DirectShow requires quoted device names
		case 'linux':
			return deviceId; // Linux uses device directly
	}
}

/**
 * Build the complete FFmpeg command string.
 * This is the single source of truth for command construction.
 *
 * @param params Command parameters
 * @returns Complete FFmpeg command string
 */
export function buildFfmpegCommand({
	globalOptions,
	inputOptions,
	deviceIdentifier,
	outputOptions,
	outputPath,
}: {
	globalOptions: string;
	inputOptions: string;
	deviceIdentifier: DeviceIdentifier;
	outputOptions: string;
	outputPath: string;
}): string {
	// Format device for platform
	const formattedDevice = formatDeviceForPlatform(deviceIdentifier);

	// Apply platform-specific defaults if input options are empty
	const finalInputOptions = inputOptions.trim() || FFMPEG_DEFAULT_INPUT_OPTIONS;

	// Windows DirectShow uses a special syntax: audio="Device Name"
	// The quotes are part of the DirectShow parameter, not shell quoting
	// For other platforms, wrap the device in quotes for shell safety
	const deviceParam =
		PLATFORM_TYPE === 'windows' ? formattedDevice : `"${formattedDevice}"`;

	// Build command using template string - much simpler!
	// Filter out empty parts inline
	const parts = [
		'ffmpeg',
		globalOptions.trim(),
		finalInputOptions,
		'-i',
		deviceParam,
		outputOptions.trim(),
		`"${outputPath}"`,
	].filter((part) => part); // Remove empty strings

	return parts.join(' ');
}

/**
 * Determines the appropriate file extension from FFmpeg output options.
 * Analyzes the codec specified in the options and returns the corresponding file extension.
 *
 * @param outputOptions - FFmpeg output options string (e.g., "-c:a libopus -b:a 32k")
 * @returns The appropriate file extension without the dot (e.g., "opus", "mp3", "wav")
 *
 * @example
 * getFileExtensionFromFfmpegOptions('-c:a libopus -b:a 32k') // returns 'opus'
 * getFileExtensionFromFfmpegOptions('-c:a libmp3lame -b:a 128k') // returns 'mp3'
 */
export function getFileExtensionFromFfmpegOptions(outputOptions: string) {
	if (outputOptions.includes('libopus')) return 'opus';
	if (outputOptions.includes('libmp3lame')) return 'mp3';
	if (outputOptions.includes('libvorbis')) return 'ogg';
	if (outputOptions.includes('aac')) return 'm4a';
	if (outputOptions.includes('pcm_')) return 'wav';

	// Default to wav for maximum compatibility
	return 'wav';
}

type SignalResult = {
	success: boolean;
	message: string;
};

/**
 * Send a SIGINT signal to a process by PID (equivalent to Ctrl+C).
 * This is the preferred method for gracefully stopping console applications
 * like FFmpeg, as they're designed to handle Ctrl+C properly.
 *
 * On Unix systems, this sends the actual SIGINT signal.
 * On Windows, this attempts to send a Ctrl+C event to the console process.
 */
async function sendSigint(pid: number): Promise<SignalResult> {
	return invoke<SignalResult>('send_sigint', { pid });
}
