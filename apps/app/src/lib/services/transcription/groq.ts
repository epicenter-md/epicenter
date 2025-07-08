import type { GroqModel } from '$lib/constants/transcription';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { Settings } from '$lib/settings';
import { getExtensionFromAudioBlob } from '$lib/utils';
import { Ok, tryAsync, trySync, type Result } from 'wellcrafted/result';

import Groq from 'groq-sdk';

const MAX_FILE_SIZE_MB = 25 as const;

export function createGroqTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				prompt: string;
				temperature: string;
				outputLanguage: Settings['transcription.outputLanguage'];
				apiKey: string;
				modelName: (string & {}) | GroqModel['name'];
			},
		): Promise<Result<string, WhisperingError>> {
			// Pre-validate API key
			if (!options.apiKey) {
				return WhisperingErr({
					title: '🔑 API Key Required',
					description: 'Please enter your Groq API key in settings.',
					action: {
						type: 'link',
						label: 'Add API key',
						href: '/settings/transcription',
					},
				});
			}

			if (!options.apiKey.startsWith('gsk_')) {
				return WhisperingErr({
					title: '🔑 Invalid API Key Format',
					description:
						'Your Groq API key should start with "gsk_". Please check and update your API key.',
					action: {
						type: 'link',
						label: 'Update API key',
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
				mapError: (error) =>
					({
						name: 'WhisperingError' as const,
						title: '📄 File Creation Failed',
						description:
							'Failed to create audio file for transcription. Please try again.',
						action: { type: 'more-details', error },
					}) satisfies WhisperingError,
			});

			if (fileError) return Err(fileError);

			// Make the transcription request
			const { data: transcription, error: groqApiError } = await tryAsync({
				try: () =>
					new Groq({
						apiKey: options.apiKey,
						dangerouslyAllowBrowser: true,
					}).audio.transcriptions.create({
						file,
						model: options.modelName,
						language:
							options.outputLanguage === 'auto'
								? undefined
								: options.outputLanguage,
						prompt: options.prompt ? options.prompt : undefined,
						temperature: options.temperature
							? Number.parseFloat(options.temperature)
							: undefined,
					}),
				mapError: (error) => {
					// Check if it's NOT a Groq API error
					if (!(error instanceof Groq.APIError)) {
						// This is an unexpected error type
						throw error;
					}
					// Return the error directly
					return error;
				},
			});

			if (groqApiError) {
				// Error handling follows https://www.npmjs.com/package/groq-sdk#error-handling
				const { status, name, message, error } = groqApiError;

				// 400 - BadRequestError
				if (status === 400) {
					return WhisperingErr({
						title: '❌ Bad Request',
						description:
							message ??
							`Invalid request to Groq API. ${error?.message ?? ''}`.trim(),
						action: { type: 'more-details', error: groqApiError },
					});
				}

				// 401 - AuthenticationError
				if (status === 401) {
					return WhisperingErr({
						title: '🔑 Authentication Required',
						description:
							message ??
							'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
						action: {
							type: 'link',
							label: 'Update API key',
							href: '/settings/transcription',
						},
					});
				}

				// 403 - PermissionDeniedError
				if (status === 403) {
					return WhisperingErr({
						title: '⛔ Permission Denied',
						description:
							message ??
							"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions.",
						action: { type: 'more-details', error: groqApiError },
					});
				}

				// 404 - NotFoundError
				if (status === 404) {
					return WhisperingErr({
						title: '🔍 Not Found',
						description:
							message ??
							'The requested resource was not found. This might indicate an issue with the model or API endpoint.',
						action: { type: 'more-details', error: groqApiError },
					});
				}

				// 422 - UnprocessableEntityError
				if (status === 422) {
					return WhisperingErr({
						title: '⚠️ Invalid Input',
						description:
							message ??
							'The request was valid but the server cannot process it. Please check your audio file and parameters.',
						action: {
							type: 'link',
							label: 'Update API key',
							href: '/settings/transcription',
						},
					});
				}

				// 429 - RateLimitError
				if (status === 429) {
					return WhisperingErr({
						title: '⏱️ Rate Limit Reached',
						description:
							message ?? 'Too many requests. Please try again later.',
						action: {
							type: 'link',
							label: 'Update API key',
							href: '/settings/transcription',
						},
					});
				}

				// >=500 - InternalServerError
				if (status && status >= 500) {
					return WhisperingErr({
						title: '🔧 Service Unavailable',
						description:
							message ??
							`The transcription service is temporarily unavailable (Error ${status}). Please try again in a few minutes.`,
						action: { type: 'more-details', error: groqApiError },
					});
				}

				// Handle APIConnectionError (no status code)
				if (!status && name === 'APIConnectionError') {
					return WhisperingErr({
						title: '🌐 Connection Issue',
						description:
							message ??
							'Unable to connect to the Groq service. This could be a network issue or temporary service interruption.',
						action: { type: 'more-details', error: groqApiError },
					});
				}

				// Return the error directly for other API errors
				return WhisperingErr({
					title: '❌ Unexpected Error',
					description:
						message ?? 'An unexpected error occurred. Please try again.',
					action: { type: 'more-details', error: groqApiError },
				});
			}

			return Ok(transcription.text.trim());
		},
	};
}

export type GroqTranscriptionService = ReturnType<
	typeof createGroqTranscriptionService
>;

export const GroqTranscriptionServiceLive = createGroqTranscriptionService();
