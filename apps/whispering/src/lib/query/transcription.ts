import {
	WhisperingErr,
	WhisperingWarningErr,
	type WhisperingError,
} from '$lib/result';
import * as services from '$lib/services';
import type { Recording } from '$lib/services/db';
import { settings } from '$lib/stores/settings.svelte';
import { Err, Ok, type Result, partitionResults } from 'wellcrafted/result';
import { defineMutation, queryClient } from './_client';
import { notify } from './notify';
import { recordings } from './recordings';
import { rpc } from './';
import {
	RECORDING_COMPATIBILITY_MESSAGE,
	hasLocalTranscriptionCompatibilityIssue,
} from '../../routes/+layout/check-ffmpeg';
import { goto } from '$app/navigation';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

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
		resultMutationFn: async (
			recording: Recording,
		): Promise<Result<string, WhisperingError>> => {
			if (!recording.blob) {
				return WhisperingErr({
					title: '⚠️ Recording blob not found',
					description: "Your recording doesn't have a blob to transcribe.",
				});
			}
			const { error: setRecordingTranscribingError } =
				await recordings.updateRecording.execute({
					...recording,
					transcriptionStatus: 'TRANSCRIBING',
				});
			if (setRecordingTranscribingError) {
				notify.warning.execute({
					title:
						'⚠️ Unable to set recording transcription status to transcribing',
					description: 'Continuing with the transcription process...',
					action: {
						type: 'more-details',
						error: setRecordingTranscribingError,
					},
				});
			}
			const { data: transcribedText, error: transcribeError } =
				await transcribeBlob(recording.blob);
			if (transcribeError) {
				const { error: setRecordingTranscribingError } =
					await recordings.updateRecording.execute({
						...recording,
						transcriptionStatus: 'FAILED',
					});
				if (setRecordingTranscribingError) {
					notify.warning.execute({
						title: '⚠️ Unable to update recording after transcription',
						description:
							"Transcription failed but unable to update recording's transcription status in database",
						action: {
							type: 'more-details',
							error: setRecordingTranscribingError,
						},
					});
				}
				return Err(transcribeError);
			}

			const { error: setRecordingTranscribedTextError } =
				await recordings.updateRecording.execute({
					...recording,
					transcribedText,
					transcriptionStatus: 'DONE',
				});
			if (setRecordingTranscribedTextError) {
				notify.warning.execute({
					title: '⚠️ Unable to update recording after transcription',
					description:
						"Transcription completed but unable to update recording's transcribed text and status in database",
					action: {
						type: 'more-details',
						error: setRecordingTranscribedTextError,
					},
				});
			}
			return Ok(transcribedText);
		},
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		resultMutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map(async (recording) => {
					if (!recording.blob) {
						return WhisperingErr({
							title: '⚠️ Recording blob not found',
							description: "Your recording doesn't have a blob to transcribe.",
						});
					}
					return await transcribeBlob(recording.blob);
				}),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};

async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

	// Log transcription request
	const startTime = Date.now();
	rpc.analytics.logEvent.execute({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Compress audio if enabled, else pass through original blob
	let audioToTranscribe = blob;
	if (settings.value['transcription.compressionEnabled']) {
		const { data: compressedBlob, error: compressionError } =
			await services.ffmpeg.compressAudioBlob(
				blob,
				settings.value['transcription.compressionOptions'],
			);

		if (compressionError) {
			// Log compression failure but continue with original blob
			console.warn(
				'Audio compression failed, using original audio:',
				compressionError,
			);
			rpc.analytics.logEvent.execute({
				type: 'compression_failed',
				provider: selectedService,
				error_message: compressionError.message,
			});
		} else {
			// Use compressed blob and log success
			audioToTranscribe = compressedBlob;
			console.log(
				`Audio compressed successfully: ${blob.size} bytes → ${compressedBlob.size} bytes (${Math.round((1 - compressedBlob.size / blob.size) * 100)}% reduction)`,
			);
			rpc.analytics.logEvent.execute({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: compressedBlob.size,
				compression_ratio: Math.round(
					(1 - compressedBlob.size / blob.size) * 100,
				),
			});
		}
	}

	const transcriptionResult: Result<string, WhisperingError> =
		await (async () => {
			switch (selectedService) {
				case 'OpenAI':
					return await services.transcriptions.openai.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							apiKey: settings.value['apiKeys.openai'],
							modelName: settings.value['transcription.openai.model'],
						},
					);
				case 'Groq':
					return await services.transcriptions.groq.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							apiKey: settings.value['apiKeys.groq'],
							modelName: settings.value['transcription.groq.model'],
						},
					);
				case 'speaches':
					return await services.transcriptions.speaches.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							modelId: settings.value['transcription.speaches.modelId'],
							baseUrl: settings.value['transcription.speaches.baseUrl'],
						},
					);
				case 'ElevenLabs':
					return await services.transcriptions.elevenlabs.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							apiKey: settings.value['apiKeys.elevenlabs'],
							modelName: settings.value['transcription.elevenlabs.model'],
						},
					);
				case 'Deepgram':
					return await services.transcriptions.deepgram.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							apiKey: settings.value['apiKeys.deepgram'],
							modelName: settings.value['transcription.deepgram.model'],
						},
					);
				case 'Mistral':
					return await services.transcriptions.mistral.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							prompt: settings.value['transcription.prompt'],
							temperature: settings.value['transcription.temperature'],
							apiKey: settings.value['apiKeys.mistral'],
							modelName: settings.value['transcription.mistral.model'],
						},
					);
				case 'whispercpp': {
					const { data: isFFmpegInstalled, error: checkFfmpegInstalledError } =
						await rpc.ffmpeg.checkFfmpegInstalled.ensure();
					if (checkFfmpegInstalledError) return Err(checkFfmpegInstalledError);
					if (hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled })) {
						return WhisperingErr({
							title: 'Recording Settings Incompatible',
							description: RECORDING_COMPATIBILITY_MESSAGE,
							action: {
								type: 'link',
								label: 'Go to Recording Settings',
								href: '/settings/recording',
							},
						});
					}
					return await services.transcriptions.whispercpp.transcribe(
						audioToTranscribe,
						{
							outputLanguage: settings.value['transcription.outputLanguage'],
							modelPath: settings.value['transcription.whispercpp.modelPath'],
						},
					);
				}
				case 'parakeet': {
					const { data: isFFmpegInstalled, error: checkFfmpegInstalledError } =
						await rpc.ffmpeg.checkFfmpegInstalled.ensure();
					if (checkFfmpegInstalledError) return Err(checkFfmpegInstalledError);
					if (hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled })) {
						return WhisperingErr({
							title: 'Recording Settings Incompatible',
							description: RECORDING_COMPATIBILITY_MESSAGE,
							action: {
								type: 'link',
								label: 'Go to Recording Settings',
								href: '/settings/recording',
							},
						});
					}
					return await services.transcriptions.parakeet.transcribe(
						audioToTranscribe,
						{ modelPath: settings.value['transcription.parakeet.modelPath'] },
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
		rpc.analytics.logEvent.execute({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: transcriptionResult.error.title,
			error_description: transcriptionResult.error.description,
		});
	} else {
		rpc.analytics.logEvent.execute({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}
