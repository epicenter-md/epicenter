import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { Settings } from '$lib/settings';
import { getExtensionFromAudioBlob } from '$lib/services/_utils';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { Mistral } from '@mistralai/mistralai';
export const MISTRAL_TRANSCRIPTION_MODELS = [
	{
		name: 'voxtral-mini-latest',
		description:
			'API-optimized Voxtral Mini model delivering unparalleled cost and latency efficiency. Supports multilingual transcription with high accuracy.',
		cost: '$0.12/hour',
	},
	{
		name: 'voxtral-small-latest',
		description:
			'Voxtral Small model for higher accuracy and broader language support. Suitable for most transcription needs with a balance of cost and performance.',
		cost: '$0.24/hour',
	},
] as const;

export type MistralModel = (typeof MISTRAL_TRANSCRIPTION_MODELS)[number];

const MAX_FILE_SIZE_MB = 25 as const;

export function createMistralTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				prompt: string;
				temperature: string;
				outputLanguage: Settings['transcription.outputLanguage'];
				apiKey: string;
				modelName: (string & {}) | MistralModel['name'];
			},
		): Promise<Result<string, WhisperingError>> {
			// Pre-validate API key
			if (!options.apiKey) {
				return WhisperingErr({
					title: '🔑 API Key Required',
					description: 'Please enter your Mistral API key in settings.',
					action: {
						type: 'link',
						label: 'Add API key',
						href: '/settings/transcription',
					},
				});
			}

			// Check file size
			const blobSizeInMb = audioBlob.size / (1024 * 1024);
			if (blobSizeInMb > MAX_FILE_SIZE_MB) {
				return WhisperingErr({
					title: `The file size (${blobSizeInMb}MB) is too large`,
					description: `Please upload a file smaller than ${MAX_FILE_SIZE_MB}MB.`,
				});
			}

			// Create file from blob
			const { data: file, error: fileError } = trySync({
				try: () =>
					new File(
						[audioBlob],
						`recording.${getExtensionFromAudioBlob(audioBlob)}`,
						{ type: audioBlob.type },
					),
				catch: (error) =>
					WhisperingErr({
						title: '📄 File Creation Failed',
						description:
							'Failed to create audio file for transcription. Please try again.',
						action: { type: 'more-details', error },
					}),
			});

			if (fileError) return Err(fileError);

			// Make the transcription request
			const { data: transcription, error: mistralApiError } = await tryAsync({
				try: () =>
					new Mistral({
						apiKey: options.apiKey,
					}).audio.transcriptions.complete({
						file,
						model: options.modelName,
						language:
							options.outputLanguage !== 'auto'
								? options.outputLanguage
								: undefined,
						temperature: options.temperature
							? Number.parseFloat(options.temperature)
							: undefined,
					}),
				catch: (error) => {
					// Return the error directly for processing
					return Err(error);
				},
			});

			if (mistralApiError) {
				// Handle Mistral API errors
				const errorMessage = mistralApiError instanceof Error ? mistralApiError.message : 'Unknown error occurred';

				// Check for common HTTP status codes
				if (
					errorMessage.includes('401') ||
					errorMessage.includes('Unauthorized')
				) {
					return WhisperingErr({
						title: '🔑 Authentication Required',
						description:
							'Your API key appears to be invalid or expired. Please update your API key in settings.',
						action: {
							type: 'link',
							label: 'Update API key',
							href: '/settings/transcription',
						},
					});
				}

				if (
					errorMessage.includes('429') ||
					errorMessage.includes('rate limit')
				) {
					return WhisperingErr({
						title: '⏱️ Rate Limit Reached',
						description: 'Too many requests. Please try again later.',
						action: { type: 'more-details', error: mistralApiError },
					});
				}

				if (
					errorMessage.includes('413') ||
					errorMessage.includes('too large')
				) {
					return WhisperingErr({
						title: '📦 Audio File Too Large',
						description:
							'Your audio file exceeds the maximum size limit. Try reducing the file size.',
						action: { type: 'more-details', error: mistralApiError },
					});
				}

				// Generic error fallback
				return WhisperingErr({
					title: '❌ Transcription Failed',
					description: errorMessage,
					action: { type: 'more-details', error: mistralApiError },
				});
			}

			// Check if transcription is valid
			if (!transcription || typeof transcription.text !== 'string') {
				return WhisperingErr({
					title: '❌ Invalid Transcription Response',
					description: 'Mistral API returned an invalid response format.',
				});
			}

			return Ok(transcription.text.trim());
		},
	};
}

export type MistralTranscriptionService = ReturnType<
	typeof createMistralTranscriptionService
>;

export const MistralTranscriptionServiceLive =
	createMistralTranscriptionService();
