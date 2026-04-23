import OpenAI from 'openai';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { customFetch } from '$lib/services/http';
import { getAudioExtension } from '$lib/services/transcription/utils';

const MAX_FILE_SIZE_MB = 25 as const;

type OpenAIAPIError = InstanceType<typeof OpenAI.APIError>;

export const OpenaiError = defineErrors({
	MissingApiKey: () => ({
		message: 'OpenAI API key is required',
	}),
	InvalidApiKeyFormat: () => ({
		message: 'OpenAI API keys must start with "sk-"',
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
	FileCreationFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create audio file for transcription: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BadRequest: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	Unauthorized: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	PermissionDenied: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	NotFound: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	PayloadTooLarge: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	UnsupportedMediaType: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	UnprocessableEntity: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	RateLimit: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	ServiceUnavailable: ({
		cause,
		status,
	}: {
		cause: OpenAIAPIError;
		status: number;
	}) => ({
		message: cause.message,
		cause,
		status,
	}),
	Connection: ({ cause }: { cause: OpenAIAPIError }) => ({
		message: cause.message,
		cause,
	}),
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type OpenaiError = InferErrors<typeof OpenaiError>;

export const OpenaiTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		options: {
			prompt: string;
			temperature: string;
			outputLanguage: string;
			apiKey: string;
			modelName: string;
			baseURL?: string;
		},
	): Promise<Result<string, OpenaiError>> {
		const isUsingCustomEndpoint = Boolean(options.baseURL);

		// Custom endpoints (reverse proxies, OpenAI-compatible servers) may have
		// different auth schemes or no auth — skip API-key format checks.
		if (!isUsingCustomEndpoint) {
			if (!options.apiKey) return OpenaiError.MissingApiKey();
			if (!options.apiKey.startsWith('sk-')) {
				return OpenaiError.InvalidApiKeyFormat();
			}
		}

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > MAX_FILE_SIZE_MB) {
			return OpenaiError.FileTooLarge({ sizeMb, maxMb: MAX_FILE_SIZE_MB });
		}

		const { data: file, error: fileError } = trySync({
			try: () =>
				new File(
					[audioBlob],
					`recording.${getAudioExtension(audioBlob.type)}`,
					{ type: audioBlob.type },
				),
			catch: (cause) => OpenaiError.FileCreationFailed({ cause }),
		});

		if (fileError) return Err(fileError);

		return tryAsync({
			try: async () => {
				const transcription = await new OpenAI({
					apiKey: options.apiKey,
					dangerouslyAllowBrowser: true,
					fetch: customFetch,
					...(options.baseURL && { baseURL: options.baseURL }),
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
				});
				return transcription.text.trim();
			},
			catch: (error) => {
				if (!(error instanceof OpenAI.APIError)) {
					return OpenaiError.Unexpected({ cause: error });
				}
				const { status, name } = error;
				if (!status && name === 'APIConnectionError') {
					return OpenaiError.Connection({ cause: error });
				}
				switch (status) {
					case 400:
						return OpenaiError.BadRequest({ cause: error });
					case 401:
						return OpenaiError.Unauthorized({ cause: error });
					case 403:
						return OpenaiError.PermissionDenied({ cause: error });
					case 404:
						return OpenaiError.NotFound({ cause: error });
					case 413:
						return OpenaiError.PayloadTooLarge({ cause: error });
					case 415:
						return OpenaiError.UnsupportedMediaType({ cause: error });
					case 422:
						return OpenaiError.UnprocessableEntity({ cause: error });
					case 429:
						return OpenaiError.RateLimit({ cause: error });
					default:
						if (status && status >= 500) {
							return OpenaiError.ServiceUnavailable({ cause: error, status });
						}
						return OpenaiError.Unexpected({ cause: error });
				}
			},
		});
	},
};

export type OpenaiTranscriptionService = typeof OpenaiTranscriptionServiceLive;
