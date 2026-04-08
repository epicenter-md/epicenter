import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { rpc } from '$lib/query';
import { defineMutation, queryClient } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { notify } from './notify';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

function getOutputLanguage(): SupportedLanguage {
	const language = settings.get('transcription.language');
	for (const supportedLanguage of SUPPORTED_LANGUAGES) {
		if (supportedLanguage === language) {
			return supportedLanguage;
		}
	}
	return 'auto';
}

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({
				mutationKey: transcriptionKeys.isTranscribing,
			}) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<string, WhisperingError>> => {
			// Fetch audio blob by ID
			const { data: audioBlob, error: getAudioBlobError } =
				await services.db.recordings.getAudioBlob(recording.id);

			if (getAudioBlobError) {
				return WhisperingErr({
					title: '⚠️ Failed to fetch audio',
					description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
				});
			}

			recordings.update(recording.id, { transcriptionStatus: 'TRANSCRIBING' });
			const { data: transcribedText, error: transcribeError } =
				await transcribeBlob(audioBlob);
			if (transcribeError) {
				recordings.update(recording.id, { transcriptionStatus: 'FAILED' });
				return Err(transcribeError);
			}

			recordings.update(recording.id, {
				transcribedText,
				transcriptionStatus: 'DONE',
			});
			return Ok(transcribedText);
		},
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map(async (recording) => {
					// Fetch audio blob by ID
					const { data: audioBlob, error: getAudioBlobError } =
						await services.db.recordings.getAudioBlob(recording.id);

					if (getAudioBlobError) {
						return WhisperingErr({
							title: '⚠️ Failed to fetch audio',
							description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
						});
					}

					return await transcribeBlob(audioBlob);
				}),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};

/**
 * Transcribe an audio blob directly without any database operations.
 * Use this when you need parallel execution and will handle DB updates separately.
 */
export async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService = settings.get('transcription.service');

	// Log transcription request
	const startTime = Date.now();
	rpc.analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Compress audio if enabled, else pass through original blob
	let audioToTranscribe = blob;
	if (settings.get('transcription.compressionEnabled')) {
		const { data: compressedBlob, error: compressionError } =
			await desktopServices.ffmpeg.compressAudioBlob(
				blob,
				settings.get('transcription.compressionOptions'),
			);

		if (compressionError) {
			// Notify user of compression failure but continue with original blob
			notify.warning({
				title: 'Audio compression failed',
				description: `${compressionError.message}. Using original audio for transcription.`,
			});
			rpc.analytics.logEvent({
				type: 'compression_failed',
				provider: selectedService,
				error_message: compressionError.message,
			});
		} else {
			// Use compressed blob and notify user of success
			audioToTranscribe = compressedBlob;
			const compressionRatio = Math.round(
				(1 - compressedBlob.size / blob.size) * 100,
			);
			notify.info({
				title: 'Audio compressed',
				description: `Reduced file size by ${compressionRatio}%`,
			});
			rpc.analytics.logEvent({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: compressedBlob.size,
				compression_ratio: compressionRatio,
			});
		}
	}

	// Diagnostic: log blob state to help debug 400 "Invalid file format" errors.
	// If size is 0 or type is empty, the blob is the problem—not the extension.
	console.debug('[Transcription] Blob diagnostics:', {
		size: audioToTranscribe.size,
		type: audioToTranscribe.type,
		sizeKb: Math.round(audioToTranscribe.size / 1024),
		service: selectedService,
	});
	const transcriptionResult: Result<string, WhisperingError> =
		await (async () => {
			const outputLanguage = getOutputLanguage();
			const prompt = settings.get('transcription.prompt');
			const temperature = String(settings.get('transcription.temperature'));

			switch (selectedService) {
				case 'OpenAI':
					return await services.transcriptions.openai.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.openai'),
							modelName: settings.get('transcription.openai.model'),
							baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
						},
					);
				case 'Groq':
					return await services.transcriptions.groq.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.groq'),
							modelName: settings.get('transcription.groq.model'),
							baseURL: deviceConfig.get('apiEndpoints.groq') || undefined,
						},
					);
				case 'speaches':
					return await services.transcriptions.speaches.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							modelId: deviceConfig.get('transcription.speaches.modelId'),
							baseUrl: deviceConfig.get('transcription.speaches.baseUrl'),
						},
					);
				case 'ElevenLabs':
					return await services.transcriptions.elevenlabs.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.elevenlabs'),
							modelName: settings.get('transcription.elevenlabs.model'),
						},
					);
				case 'Deepgram':
					return await services.transcriptions.deepgram.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.deepgram'),
							modelName: settings.get('transcription.deepgram.model'),
						},
					);
				case 'Mistral':
					return await services.transcriptions.mistral.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.mistral'),
							modelName: settings.get('transcription.mistral.model'),
						},
					);
				case 'whispercpp': {
					// Pure Rust audio conversion now handles most formats without FFmpeg
					// Only compressed formats (MP3, M4A) require FFmpeg, which will be
					// handled automatically as a fallback in the Rust conversion pipeline
					return await services.transcriptions.whispercpp.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							modelPath: deviceConfig.get('transcription.whispercpp.modelPath'),
							prompt,
						},
					);
				}
				case 'parakeet': {
					// Pure Rust audio conversion now handles most formats without FFmpeg
					// Only compressed formats (MP3, M4A) require FFmpeg, which will be
					// handled automatically as a fallback in the Rust conversion pipeline
					return await services.transcriptions.parakeet.transcribe(
						audioToTranscribe,
						{
							modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
						},
					);
				}
				case 'moonshine': {
					// Moonshine uses ONNX Runtime with encoder-decoder architecture
					// Variant is extracted from modelPath (e.g., "moonshine-tiny-en" → "tiny")
					return await services.transcriptions.moonshine.transcribe(
						audioToTranscribe,
						{
							modelPath: deviceConfig.get('transcription.moonshine.modelPath'),
						},
					);
				}
				default:
					return WhisperingErr({
						title: '⚠️ No transcription service selected',
						description: 'Please select a transcription service in settings.',
					});
			}
		})();

	// Log transcription result
	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		rpc.analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: transcriptionResult.error.title,
			error_description: transcriptionResult.error.description,
		});
	} else {
		rpc.analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}
