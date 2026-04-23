import { ElevenLabsClient } from 'elevenlabs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';

const MAX_FILE_SIZE_MB = 1000 as const;

export const ElevenLabsError = defineErrors({
	MissingApiKey: () => ({
		message: 'ElevenLabs API key is required',
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
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type ElevenLabsError = InferErrors<typeof ElevenLabsError>;

export const ElevenLabsTranscriptionServiceLive = {
	transcribe: async (
		audioBlob: Blob,
		options: {
			prompt: string;
			temperature: string;
			outputLanguage: string;
			apiKey: string;
			modelName: string;
		},
	): Promise<Result<string, ElevenLabsError>> => {
		if (!options.apiKey) return ElevenLabsError.MissingApiKey();

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > MAX_FILE_SIZE_MB) {
			return ElevenLabsError.FileTooLarge({
				sizeMb,
				maxMb: MAX_FILE_SIZE_MB,
			});
		}

		const client = new ElevenLabsClient({ apiKey: options.apiKey });

		return tryAsync({
			try: async () => {
				const transcription = await client.speechToText.convert({
					file: audioBlob,
					model_id: options.modelName,
					language_code:
						options.outputLanguage !== 'auto'
							? options.outputLanguage
							: undefined,
					tag_audio_events: false,
					diarize: true,
				});
				return transcription.text.trim();
			},
			catch: (error) => ElevenLabsError.Unexpected({ cause: error }),
		});
	},
};

export type ElevenLabsTranscriptionService =
	typeof ElevenLabsTranscriptionServiceLive;
