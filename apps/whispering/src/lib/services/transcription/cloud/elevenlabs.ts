import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';

const MAX_FILE_SIZE_MB = 1000 as const;
const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

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
	ApiError: ({
		status,
		body,
	}: {
		status: number;
		body: string;
	}) => ({
		message: `ElevenLabs API error ${status}: ${body}`,
		status,
		body,
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

		const formData = new FormData();
		formData.append('file', audioBlob);
		formData.append('model_id', options.modelName);
		if (options.outputLanguage !== 'auto') {
			formData.append('language_code', options.outputLanguage);
		}
		formData.append('tag_audio_events', 'false');
		formData.append('diarize', 'true');
		// Remove filler words, false starts, and non-speech sounds. Only
		// supported on scribe_v2 per ElevenLabs API; ignored on other models.
		if (options.modelName === 'scribe_v2') {
			formData.append('no_verbatim', 'true');
		}

		const { data: response, error: fetchError } = await tryAsync({
			try: () =>
				fetch(ELEVENLABS_STT_URL, {
					method: 'POST',
					headers: { 'xi-api-key': options.apiKey },
					body: formData,
				}),
			catch: (cause) => ElevenLabsError.Unexpected({ cause }),
		});
		if (fetchError) return Err(fetchError);

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			return ElevenLabsError.ApiError({ status: response.status, body });
		}

		return tryAsync({
			try: async () => {
				const data = (await response.json()) as { text: string };
				return data.text.trim();
			},
			catch: (cause) => ElevenLabsError.Unexpected({ cause }),
		});
	},
};

export type ElevenLabsTranscriptionService =
	typeof ElevenLabsTranscriptionServiceLive;
