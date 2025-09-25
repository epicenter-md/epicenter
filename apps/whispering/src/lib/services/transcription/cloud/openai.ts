import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { Settings } from '$lib/settings';
import { getExtensionFromAudioBlob } from '$lib/services/_utils';
import OpenAI from 'openai';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

export const OPENAI_TRANSCRIPTION_MODELS = [
	{
		name: 'whisper-1',
		description:
			"OpenAI's flagship speech-to-text model with multilingual support. Reliable and accurate transcription for a wide variety of use cases.",
		cost: '$0.36/hour',
	},
	{
		name: 'gpt-4o-transcribe',
		description:
			'GPT-4o powered transcription with enhanced understanding and context. Best for complex audio requiring deep comprehension.',
		cost: '$0.36/hour',
	},
	{
		name: 'gpt-4o-mini-transcribe',
		description:
			'Cost-effective GPT-4o mini transcription model. Good balance of performance and cost for standard transcription needs.',
		cost: '$0.18/hour',
	},
] as const satisfies {
	name: OpenAI.Audio.AudioModel;
	description: string;
	cost: string;
}[];

export type OpenAIModel = (typeof OPENAI_TRANSCRIPTION_MODELS)[number];

const MAX_FILE_SIZE_MB = 25 as const;

export function createOpenaiTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				prompt: string;
				temperature: string;
				outputLanguage: Settings['transcription.outputLanguage'];
				apiKey: string;
				modelName: (string & {}) | OpenAIModel['name'];
			},
		): Promise<Result<string, WhisperingError>> {
			// Pre-validation: Check API key
			if (!options.apiKey) {
				return WhisperingErr({
					title: '🔑 API Key Required',
					description:
						'Please enter your OpenAI API key in settings to use Whisper transcription.',
					action: {
						type: 'link',
						label: 'Add API key',
						href: '/settings/transcription',
					},
				});
			}

			if (!options.apiKey.startsWith('sk-')) {
				return WhisperingErr({
					title: '🔑 Invalid API Key Format',
					description:
						'Your OpenAI API key should start with "sk-". Please check and update your API key.',
					action: {
						type: 'link',
						label: 'Update API key',
						href: '/settings/transcription',
					},
				});
			}

			// Validate file size
			const blobSizeInMb = audioBlob.size / (1024 * 1024);
			if (blobSizeInMb > MAX_FILE_SIZE_MB) {
				return WhisperingErr({
					title: `The file size (${blobSizeInMb}MB) is too large`,
					description: `Please upload a file smaller than ${MAX_FILE_SIZE_MB}MB.`,
				});
			}

			// Create File object from blob
			const { data: file, error: fileError } = trySync({
				try: () =>
					new File(
						[audioBlob],
						`recording.${getExtensionFromAudioBlob(audioBlob)}`,
						{ type: audioBlob.type },
					),
				catch: (error) =>
					WhisperingErr({
						title: '📁 File Creation Failed',
						description:
							'Failed to create audio file for transcription. Please try again.',
					}),
			});

			if (fileError) return Err(fileError);

			// Call OpenAI API
			const { data: transcription, error: openaiApiError } = await tryAsync({
				try: () =>
					new OpenAI({
						apiKey: options.apiKey,
						dangerouslyAllowBrowser: true,
					}).audio.transcriptions.create({
						file,
						model: options.modelName,
						language:
							options.outputLanguage !== 'auto'
								? options.outputLanguage
								: undefined,
						prompt: options.prompt || undefined,
						temperature: options.temperature
							? Number.parseFloat(options.temperature)
							: undefined,
					}),
				catch: (error) => {
					// Check if it's NOT an OpenAI API error
					if (!(error instanceof OpenAI.APIError)) {
						// This is an unexpected error type
						throw error;
					}
					// Return the error directly
					return Err(error);
				},
			});

			if (openaiApiError) {
				// Error handling follows https://www.npmjs.com/package/openai#error-handling
				const { status, name, message, error } = openaiApiError;

				// 400 - BadRequestError
				if (status === 400) {
					return WhisperingErr({
						title: '❌ Bad Request',
						description:
							message ??
							`Invalid request to OpenAI API. ${error?.message ?? ''}`.trim(),
						action: { type: 'more-details', error: openaiApiError },
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
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// 404 - NotFoundError
				if (status === 404) {
					return WhisperingErr({
						title: '🔍 Not Found',
						description:
							message ??
							'The requested resource was not found. This might indicate an issue with the model or API endpoint.',
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// 413 - Request Entity Too Large
				if (status === 413) {
					return WhisperingErr({
						title: '📦 Audio File Too Large',
						description:
							message ??
							'Your audio file exceeds the maximum size limit (25MB). Try splitting it into smaller segments or reducing the audio quality.',
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// 415 - Unsupported Media Type
				if (status === 415) {
					return WhisperingErr({
						title: '🎵 Unsupported Format',
						description:
							message ??
							"This audio format isn't supported. Please convert your file to MP3, WAV, M4A, or another common audio format.",
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// 422 - UnprocessableEntityError
				if (status === 422) {
					return WhisperingErr({
						title: '⚠️ Invalid Input',
						description:
							message ??
							'The request was valid but the server cannot process it. Please check your audio file and parameters.',
						action: { type: 'more-details', error: openaiApiError },
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
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// Handle APIConnectionError (no status code)
				if (!status && name === 'APIConnectionError') {
					return WhisperingErr({
						title: '🌐 Connection Issue',
						description:
							message ??
							'Unable to connect to the OpenAI service. This could be a network issue or temporary service interruption.',
						action: { type: 'more-details', error: openaiApiError },
					});
				}

				// Return the error directly for other API errors
				return WhisperingErr({
					title: '❌ Unexpected Error',
					description:
						message ?? 'An unexpected error occurred. Please try again.',
					action: { type: 'more-details', error: openaiApiError },
				});
			}

			// Success - return the transcription text
			return Ok(transcription.text.trim());
		},
	};
}

export type OpenaiTranscriptionService = ReturnType<
	typeof createOpenaiTranscriptionService
>;

export const OpenaiTranscriptionServiceLive =
	createOpenaiTranscriptionService();
