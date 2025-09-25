import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { HttpService } from '$lib/services/http';
import type { Settings } from '$lib/settings';
import { getExtensionFromAudioBlob } from '$lib/services/_utils';
import { Ok, type Result } from 'wellcrafted/result';
import { z } from 'zod';

const whisperApiResponseSchema = z.union([
	z.object({ text: z.string() }),
	z.object({ error: z.object({ message: z.string() }) }),
]);

export function createSpeachesTranscriptionService({
	HttpService,
}: {
	HttpService: HttpService;
}) {
	return {
		transcribe: async (
			audioBlob: Blob,
			options: {
				prompt: string;
				temperature: string;
				outputLanguage: Settings['transcription.outputLanguage'];
				modelId: string;
				baseUrl: string;
			},
		): Promise<Result<string, WhisperingError>> => {
			const formData = new FormData();
			formData.append(
				'file',
				new File(
					[audioBlob],
					`recording.${getExtensionFromAudioBlob(audioBlob)}`,
					{ type: audioBlob.type },
				),
			);
			formData.append('model', options.modelId);
			if (options.outputLanguage !== 'auto') {
				formData.append('language', options.outputLanguage);
			}
			if (options.prompt) formData.append('prompt', options.prompt);
			if (options.temperature)
				formData.append('temperature', options.temperature);

			const { data: whisperApiResponse, error: postError } =
				await HttpService.post({
					url: `${options.baseUrl}/v1/audio/transcriptions`,
					body: formData,
					headers: undefined, // No headers needed for Speaches
					schema: whisperApiResponseSchema,
				});

			if (postError) {
				switch (postError.name) {
					case 'ConnectionError': {
						return WhisperingErr({
							title: '🌐 Connection Issue',
							description:
								'Unable to connect to the transcription service. This could be a network issue or temporary service interruption. Please try again in a moment.',
							action: { type: 'more-details', error: postError.cause },
						});
					}

					case 'ResponseError': {
						const { status, message } = postError;

						if (status === 401) {
							return WhisperingErr({
								title: '🔑 Authentication Required',
								description:
									'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
								action: {
									type: 'link',
									label: 'Update API key',
									href: '/settings/transcription',
								},
							});
						}

						if (status === 403) {
							return WhisperingErr({
								title: '⛔ Access Restricted',
								description:
									"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions. Please check your account status.",
								action: { type: 'more-details', error: postError.cause },
							});
						}

						if (status === 413) {
							return WhisperingErr({
								title: '📦 Audio File Too Large',
								description:
									'Your audio file exceeds the maximum size limit (typically 25MB). Try splitting it into smaller segments or reducing the audio quality.',
								action: { type: 'more-details', error: postError.cause },
							});
						}

						if (status === 415) {
							return WhisperingErr({
								title: '🎵 Unsupported Format',
								description:
									"This audio format isn't supported. Please convert your file to MP3, WAV, M4A, or another common audio format.",
								action: { type: 'more-details', error: postError.cause },
							});
						}

						// Rate limiting
						if (status === 429) {
							return WhisperingErr({
								title: '⏱️ Rate Limit Reached',
								description: message,
								action: {
									type: 'link',
									label: 'Update API key',
									href: '/settings/transcription',
								},
							});
						}

						if (status >= 500) {
							return WhisperingErr({
								title: '🔧 Service Unavailable',
								description: `The transcription service is temporarily unavailable (Error ${status}). Please try again in a few minutes.`,
								action: { type: 'more-details', error: postError.cause },
							});
						}

						return WhisperingErr({
							title: '❌ Request Failed',
							description: `The request failed with error ${status}. This may be temporary - please try again. If the problem persists, please contact support.`,
							action: { type: 'more-details', error: postError.cause },
						});
					}

					case 'ParseError':
						return WhisperingErr({
							title: '🔍 Response Error',
							description:
								'Received an unexpected response from the transcription service. This is usually temporary - please try again.',
							action: { type: 'more-details', error: postError.cause },
						});

					default:
						return WhisperingErr({
							title: '❓ Unexpected Error',
							description:
								'An unexpected error occurred during transcription. Please try again, and contact support if the issue continues.',
							action: { type: 'more-details', error: postError },
						});
				}
			}

			if ('error' in whisperApiResponse) {
				return WhisperingErr({
					title: '🔧 Speaches Connection Issue',
					description: whisperApiResponse.error.message,
				});
			}

			return Ok(whisperApiResponse.text.trim());
		},
	};
}

export type SpeachesTranscriptionService = ReturnType<
	typeof createSpeachesTranscriptionService
>;

import { HttpServiceLive } from '$lib/services/http';

export const SpeachesTranscriptionServiceLive =
	createSpeachesTranscriptionService({
		HttpService: HttpServiceLive,
	});
