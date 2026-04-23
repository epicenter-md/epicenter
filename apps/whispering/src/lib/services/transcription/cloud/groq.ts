import Groq from 'groq-sdk';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { customFetch } from '$lib/services/http';
import { getAudioExtension } from '$lib/services/transcription/utils';

const MAX_FILE_SIZE_MB = 25 as const;

type GroqAPIError = InstanceType<typeof Groq.APIError>;

export const GroqError = defineErrors({
	MissingApiKey: () => ({
		message: 'Groq API key is required',
	}),
	InvalidApiKeyFormat: () => ({
		message: 'Groq API keys must start with "gsk_" or "xai-"',
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
	BadRequest: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	Unauthorized: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	PermissionDenied: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	NotFound: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	UnprocessableEntity: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	RateLimit: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	ServiceUnavailable: ({
		cause,
		status,
	}: {
		cause: GroqAPIError;
		status: number;
	}) => ({
		message: cause.message,
		cause,
		status,
	}),
	Connection: ({ cause }: { cause: GroqAPIError }) => ({
		message: cause.message,
		cause,
	}),
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type GroqError = InferErrors<typeof GroqError>;

export const GroqTranscriptionServiceLive = {
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
	): Promise<Result<string, GroqError>> {
		const isUsingCustomEndpoint = Boolean(options.baseURL);

		if (!isUsingCustomEndpoint) {
			if (!options.apiKey) return GroqError.MissingApiKey();
			const hasValidGroqKeyFormat =
				options.apiKey.startsWith('gsk_') || options.apiKey.startsWith('xai-');
			if (!hasValidGroqKeyFormat) return GroqError.InvalidApiKeyFormat();
		}

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > MAX_FILE_SIZE_MB) {
			return GroqError.FileTooLarge({ sizeMb, maxMb: MAX_FILE_SIZE_MB });
		}

		const { data: file, error: fileError } = trySync({
			try: () =>
				new File(
					[audioBlob],
					`recording.${getAudioExtension(audioBlob.type)}`,
					{ type: audioBlob.type },
				),
			catch: (cause) => GroqError.FileCreationFailed({ cause }),
		});

		if (fileError) return Err(fileError);

		return tryAsync({
			try: async () => {
				const transcription = await new Groq({
					apiKey: options.apiKey,
					dangerouslyAllowBrowser: true,
					fetch: customFetch,
					...(options.baseURL && { baseURL: options.baseURL }),
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
				});
				return transcription.text.trim();
			},
			catch: (error) => {
				if (!(error instanceof Groq.APIError)) {
					return GroqError.Unexpected({ cause: error });
				}
				const { status, name } = error;
				if (!status && name === 'APIConnectionError') {
					return GroqError.Connection({ cause: error });
				}
				switch (status) {
					case 400:
						return GroqError.BadRequest({ cause: error });
					case 401:
						return GroqError.Unauthorized({ cause: error });
					case 403:
						return GroqError.PermissionDenied({ cause: error });
					case 404:
						return GroqError.NotFound({ cause: error });
					case 422:
						return GroqError.UnprocessableEntity({ cause: error });
					case 429:
						return GroqError.RateLimit({ cause: error });
					default:
						if (status && status >= 500) {
							return GroqError.ServiceUnavailable({ cause: error, status });
						}
						return GroqError.Unexpected({ cause: error });
				}
			},
		});
	},
};

export type GroqTranscriptionService = typeof GroqTranscriptionServiceLive;
