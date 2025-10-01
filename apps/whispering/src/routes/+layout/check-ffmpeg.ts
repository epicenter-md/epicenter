import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { rpc } from '$lib/query';
import { settings } from '$lib/stores/settings.svelte';

export const RECORDING_COMPATIBILITY_MESSAGE =
	'Whisper C++ requires audio in 16kHz WAV format. Install FFmpeg to convert your recordings or switch to CPAL 16kHz mode.';

export const COMPRESSION_RECOMMENDED_MESSAGE =
	"Since you're using CPAL recording with cloud transcription, we recommend enabling audio compression to reduce file sizes and upload times.";

/**
 * Switches recording settings to CPAL at 16kHz to resolve Whisper C++ compatibility
 */
export function switchToCpalAt16kHz() {
	settings.update({
		'recording.method': 'cpal',
		'recording.cpal.sampleRate': '16000',
	});
	toast.success('Recording settings updated', {
		description:
			'Switched to CPAL recording at 16kHz for Whisper C++ compatibility',
	});
}

function isUsingWhisperCpp(): boolean {
	return (
		settings.value['transcription.selectedTranscriptionService'] ===
		'whispercpp'
	);
}

function isUsing16kHz(): boolean {
	return settings.value['recording.cpal.sampleRate'] === '16000';
}

/**
 * Checks if there's a compatibility issue between recording and transcription settings.
 * This occurs when using Whisper C++ with any recording method except CPAL at 16kHz.
 * @returns true when there's a compatibility issue that needs to be resolved
 */
export function hasRecordingCompatibilityIssue(): boolean {
	if (!isUsingWhisperCpp()) return false;

	if (settings.value['recording.method'] === 'cpal' && isUsing16kHz()) {
		return false; // CPAL at 16kHz with Whisper C++ doesn't need FFmpeg
	}

	return true; // All other Whisper C++ combinations need FFmpeg
}

/**
 * Compression is RECOMMENDED when using CPAL + cloud transcription AND compression is not enabled
 * @returns true when compression should be recommended to the user
 */
export function isCompressionRecommended(): boolean {
	return (
		settings.value['recording.method'] === 'cpal' &&
		!isUsingWhisperCpp() &&
		!settings.value['transcription.compressionEnabled']
	);
}

/**
 * Checks for FFmpeg installation and shows an appropriate toast based on current settings.
 *
 * REQUIRED: Whisper C++ + any method except CPAL at 16kHz
 * RECOMMENDED: When compression is recommended (CPAL + cloud transcription + compression not enabled)
 */
export async function checkFfmpeg() {
	if (!window.__TAURI_INTERNALS__) return;

	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();
	if (ffmpegInstalled) return; // FFmpeg is installed, all good

	// FFmpeg recording method selected but not installed
	if (settings.value['recording.method'] === 'ffmpeg') {
		toast.warning('FFmpeg Required for FFmpeg Recording Method', {
			description:
				'You have selected FFmpeg as your recording method, but FFmpeg is not installed.',
			action: {
				label: 'Install FFmpeg',
				onClick: () => goto('/install-ffmpeg'),
			},
			duration: 15000,
		});
		return;
	}

	// Recording compatibility issue with Whisper C++ (except CPAL at 16kHz)
	if (hasRecordingCompatibilityIssue()) {
		toast.warning('Recording Settings Incompatible', {
			description: RECORDING_COMPATIBILITY_MESSAGE,
			action: {
				label: 'Go to Recording Settings',
				onClick: () => goto('/settings/recording'),
			},
			duration: 15000,
		});
		return;
	}

	// FFmpeg is RECOMMENDED for compression (CPAL + cloud transcription + compression not enabled)
	if (isCompressionRecommended()) {
		toast.info('Enable Compression for Faster Uploads', {
			description: COMPRESSION_RECOMMENDED_MESSAGE,
			action: {
				label: 'Go to Transcription Settings',
				onClick: () => goto('/settings/transcription'),
			},
			duration: 10000,
		});
		return;
	}
}
