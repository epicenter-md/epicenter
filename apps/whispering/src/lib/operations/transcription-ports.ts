import type { Result } from 'wellcrafted/result';
import type { SupportedLanguage } from '$lib/constants/languages';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import type { Recording } from '$lib/workspace';

export type TranscriptionModelKey =
	| 'transcription.openai.model'
	| 'transcription.groq.model'
	| 'transcription.elevenlabs.model'
	| 'transcription.deepgram.model'
	| 'transcription.mistral.model';

export type TranscriptionSettings = {
	service(): TranscriptionServiceId;
	language(): SupportedLanguage;
	prompt(): string;
	dictionary(): string[];
	model(key: TranscriptionModelKey): string;
};

export type RecordingOutcomeWriter = {
	update(
		id: string,
		partial: Partial<Omit<Recording, 'id' | '_v'>>,
	): Result<Recording, unknown>;
};
