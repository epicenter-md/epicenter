import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { rpc } from '$lib/query';
import { settings } from '$lib/stores/settings.svelte';

export const COMPRESSION_RECOMMENDED_MESSAGE =
	"Since you're using CPAL recording with cloud transcription, we recommend enabling audio compression to reduce file sizes and upload times.";

export const NAVIGATOR_LOCAL_TRANSCRIPTION_MESSAGE =
	'Browser API recording produces compressed audio that requires FFmpeg for local transcription. Switch to CPAL recording or install FFmpeg.';

export const RECORDING_COMPATIBILITY_MESSAGE =
	'Browser API recording produces compressed audio that requires FFmpeg for local transcription. Switch to CPAL recording, install FFmpeg, or use a cloud transcription service.';

function isUsingLocalTranscription(): boolean {
	const service = settings.value['transcription.selectedTranscriptionService'];
	return service === 'whispercpp' || service === 'parakeet';
}

/**
 * Checks if the current recording + transcription configuration will work
 * @returns true if Navigator recording is used with local transcription but FFmpeg is not installed
 */
export function hasNavigatorLocalTranscriptionIssue({
	isFFmpegInstalled,
}: {
	isFFmpegInstalled: boolean;
}): boolean {
	if (!window.__TAURI_INTERNALS__) return false;

	const isUsingNavigator = settings.value['recording.method'] === 'navigator';
	const isUsingLocalTranscription =
		settings.value['transcription.selectedTranscriptionService'] ===
			'whispercpp' ||
		settings.value['transcription.selectedTranscriptionService'] === 'parakeet';

	return isUsingNavigator && isUsingLocalTranscription && !isFFmpegInstalled;
}

/**
 * Compression is RECOMMENDED when using CPAL + cloud transcription AND compression is not enabled
 * @returns true when compression should be recommended to the user
 */
export function isCompressionRecommended(): boolean {
	return (
		settings.value['recording.method'] === 'cpal' &&
		!isUsingLocalTranscription() &&
		!settings.value['transcription.compressionEnabled']
	);
}

/**
 * Checks if FFmpeg recording method is selected but FFmpeg is not installed.
 * Shows a warning toast prompting the user to install FFmpeg when this incompatibility is detected.
 *
 * This function is specifically for validating the FFmpeg recording method selection.
 * It ensures users who have explicitly chosen FFmpeg as their recording method have it installed.
 *
 * @returns Promise<void> - Shows toast notification if FFmpeg method is selected but not installed
 */
export async function checkFfmpegRecordingMethodCompatibility() {
	if (!window.__TAURI_INTERNALS__) return;

	// Only check if FFmpeg recording method is selected
	if (settings.value['recording.method'] !== 'ffmpeg') return;

	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();
	if (ffmpegInstalled) return; // FFmpeg is installed, all good

	// FFmpeg recording method selected but not installed
	toast.warning('FFmpeg Required for FFmpeg Recording Method', {
		description:
			'You have selected FFmpeg as your recording method, but FFmpeg is not installed.',
		action: {
			label: 'Install FFmpeg',
			onClick: () => goto('/install-ffmpeg'),
		},
		duration: 15000,
	});
}

/**
 * Checks for compatibility issues between local transcription models and current recording settings.
 * Shows a warning toast with resolution options when incompatible settings are detected.
 *
 * Local transcription models (Whisper C++ and Parakeet) require audio in 16kHz mono WAV format.
 * This function detects when current recording settings won't produce compatible audio and offers
 * two solutions: installing FFmpeg for automatic conversion or switching to CPAL at 16kHz.
 *
 * @returns Promise<void> - Shows toast notification if local transcription has compatibility issues
 */
export async function checkLocalTranscriptionCompatibility() {
	if (!window.__TAURI_INTERNALS__) return;

	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();

	// Check if there are compatibility issues with local transcription
	if (
		!hasNavigatorLocalTranscriptionIssue({
			isFFmpegInstalled: ffmpegInstalled ?? false,
		})
	)
		return;

	// Recording compatibility issue with local transcription models
	toast.warning('Recording Settings Incompatible', {
		description: RECORDING_COMPATIBILITY_MESSAGE,
		action: {
			label: 'Go to Recording Settings',
			onClick: () => goto('/settings/recording'),
		},
		duration: 15000,
	});
}

/**
 * Checks if audio compression should be recommended for optimal cloud transcription performance.
 * Shows an info toast suggesting compression when using CPAL recording with cloud services.
 *
 * Compression is recommended when:
 * - Using CPAL recording method (which produces uncompressed WAV files)
 * - Using cloud transcription services (not local models)
 * - Compression is not already enabled
 *
 * This helps reduce file sizes and upload times for cloud transcription services.
 *
 * @returns Promise<void> - Shows toast notification if compression is recommended
 */
export async function checkCompressionRecommendation() {
	if (!window.__TAURI_INTERNALS__) return;

	// Check if compression should be recommended
	if (!isCompressionRecommended()) return;

	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();
	if (ffmpegInstalled) return; // FFmpeg is required for compression

	// FFmpeg is RECOMMENDED for compression
	toast.info('Enable Compression for Faster Uploads', {
		description: COMPRESSION_RECOMMENDED_MESSAGE,
		action: {
			label: 'Go to Transcription Settings',
			onClick: () => goto('/settings/transcription'),
		},
		duration: 10000,
	});
}
