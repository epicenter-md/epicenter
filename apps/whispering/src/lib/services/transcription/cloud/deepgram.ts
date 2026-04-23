import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { HttpServiceLive } from '$lib/services/http';
import type { HttpError } from '$lib/services/http/types';

const MAX_FILE_SIZE_MB = 500 as const;

const DeepgramResponse = type({
	results: {
		channels: type({
			alternatives: type({
				transcript: 'string',
				'confidence?': 'number',
			}).array(),
		}).array(),
	},
});

export const DeepgramError = defineErrors({
	MissingApiKey: () => ({
		message: 'Deepgram API key is required',
	}),
	FileTooLarge: ({
		sizeMb,
		maxMb,
	}: {
		sizeMb: number;
		maxMb: number;
	}) => ({
		message: `File size ${sizeMb.toFixed(1)}MB exceeds ${maxMb}MB limit`,
		sizeMb,
		maxMb,
	}),
	Connection: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	BadRequest: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	Unauthorized: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	Forbidden: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	PayloadTooLarge: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	UnsupportedMediaType: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	RateLimit: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	ServiceUnavailable: ({
		cause,
		status,
	}: {
		cause: HttpError;
		status: number;
	}) => ({
		message: cause.message,
		cause,
		status,
	}),
	Parse: ({ cause }: { cause: HttpError }) => ({
		message: cause.message,
		cause,
	}),
	NoTranscriptDetected: () => ({
		message: 'No speech was detected in the audio file',
	}),
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type DeepgramError = InferErrors<typeof DeepgramError>;

export const DeepgramTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		options: {
			prompt: string;
			temperature: string;
			outputLanguage: string;
			apiKey: string;
			modelName: string;
		},
	): Promise<Result<string, DeepgramError>> {
		if (!options.apiKey) return DeepgramError.MissingApiKey();

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > MAX_FILE_SIZE_MB) {
			return DeepgramError.FileTooLarge({ sizeMb, maxMb: MAX_FILE_SIZE_MB });
		}

		const params = new URLSearchParams({
			model: options.modelName,
			smart_format: 'true',
			punctuate: 'true',
			paragraphs: 'true',
		});

		if (options.outputLanguage !== 'auto') {
			params.append('language', options.outputLanguage);
		}

		if (options.prompt) {
			const isNova3 = options.modelName.toLowerCase().includes('nova-3');
			params.append(isNova3 ? 'keyterm' : 'keywords', options.prompt);
		}

		const { data: deepgramResponse, error: httpError } =
			await HttpServiceLive.post({
				url: `https://api.deepgram.com/v1/listen?${params.toString()}`,
				body: audioBlob,
				headers: {
					Authorization: `Token ${options.apiKey}`,
					'Content-Type': audioBlob.type || 'audio/*',
				},
				schema: DeepgramResponse,
			});

		if (httpError) {
			switch (httpError.name) {
				case 'Connection':
					return DeepgramError.Connection({ cause: httpError });
				case 'Parse':
					return DeepgramError.Parse({ cause: httpError });
				case 'Response': {
					const { status } = httpError;
					switch (status) {
						case 400:
							return DeepgramError.BadRequest({ cause: httpError });
						case 401:
							return DeepgramError.Unauthorized({ cause: httpError });
						case 403:
							return DeepgramError.Forbidden({ cause: httpError });
						case 413:
							return DeepgramError.PayloadTooLarge({ cause: httpError });
						case 415:
							return DeepgramError.UnsupportedMediaType({ cause: httpError });
						case 429:
							return DeepgramError.RateLimit({ cause: httpError });
						default:
							if (status >= 500) {
								return DeepgramError.ServiceUnavailable({
									cause: httpError,
									status,
								});
							}
							return DeepgramError.Unexpected({ cause: httpError });
					}
				}
			}
		}

		const transcript = deepgramResponse.results?.channels
			?.at(0)
			?.alternatives?.at(0)?.transcript;

		if (!transcript) return DeepgramError.NoTranscriptDetected();

		return Ok(transcript.trim());
	},
};

export type DeepgramTranscriptionService =
	typeof DeepgramTranscriptionServiceLive;
