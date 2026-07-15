import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { customFetch } from '#platform/http';

export const GoogleTranscriptionError = defineErrors({
	MissingApiKey: () => ({ message: 'Google API key is required' }),
	FileTooLarge: ({ sizeMb, maxMb }: { sizeMb: number; maxMb: number }) => ({
		message: `File size ${sizeMb.toFixed(1)}MB exceeds ${maxMb}MB limit`,
		sizeMb,
		maxMb,
	}),
	FileConversionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to process audio for transcription: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ApiError: ({ message, status }: { message: string; status: number }) => ({
		message: `Google API Error (${status}): ${message}`,
		status,
	}),
	InvalidResponse: () => ({
		message: 'Google API returned an invalid response format',
	}),
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type GoogleTranscriptionError = InferErrors<
	typeof GoogleTranscriptionError
>;

export const GoogleTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		options: {
			prompt: string;
			spokenLanguage: string;
			apiKey: string;
			modelName: string;
		},
	): Promise<Result<string, GoogleTranscriptionError>> {
		if (!options.apiKey) return GoogleTranscriptionError.MissingApiKey();

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > 19) {
			// Google payload limit via REST JSON inlineData is ~20MB
			return GoogleTranscriptionError.FileTooLarge({ sizeMb, maxMb: 19 });
		}

		let base64Data: string;
		try {
			const arrayBuffer = await audioBlob.arrayBuffer();
			const buffer = new Uint8Array(arrayBuffer);
			// Convert to base64 safely without call stack limits for large buffers
			let binary = '';
			const len = buffer.byteLength;
			for (let i = 0; i < len; i++) {
				binary += String.fromCharCode(buffer[i]!);
			}
			base64Data = btoa(binary);
		} catch (cause) {
			return GoogleTranscriptionError.FileConversionFailed({ cause });
		}

		let instructions =
			'Transcribe the following audio accurately. Output ONLY the transcription text without any conversational filler, markdown formatting, or explanations.';
		if (options.spokenLanguage && options.spokenLanguage !== 'auto') {
			instructions += ` The spoken language is ${options.spokenLanguage}.`;
		}
		if (options.prompt) {
			instructions += ` Ensure that you follow these instructions/glossary for context: ${options.prompt}.`;
		}

		const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.modelName}:generateContent?key=${options.apiKey}`;

		const { data: response, error: fetchError } = await tryAsync({
			try: () =>
				(customFetch ?? fetch)(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						contents: [
							{
								parts: [
									{ text: instructions },
									{
										inlineData: {
											mimeType: audioBlob.type || 'audio/ogg',
											data: base64Data,
										},
									},
								],
							},
						],
					}),
				}),
			catch: (cause) => GoogleTranscriptionError.Unexpected({ cause }),
		});

		if (fetchError) return Err(fetchError);

		if (!response.ok) {
			let errorMessage = response.statusText;
			try {
				const errorJson = await response.json();
				if (errorJson.error?.message) {
					errorMessage = errorJson.error.message;
				}
			} catch (e) {
				// Ignore JSON parse errors
			}
			return GoogleTranscriptionError.ApiError({
				message: errorMessage,
				status: response.status,
			});
		}

		let responseJson;
		try {
			responseJson = await response.json();
		} catch (cause) {
			return GoogleTranscriptionError.InvalidResponse();
		}

		const text = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (typeof text !== 'string') {
			return GoogleTranscriptionError.InvalidResponse();
		}

		return Ok(text.trim());
	},
};
