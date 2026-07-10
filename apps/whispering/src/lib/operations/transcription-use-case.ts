import { InstantString } from '@epicenter/field';
import type { AnyTaggedError } from 'wellcrafted/error';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { recordings } from '$lib/state/recordings.svelte';

export type TranscriptionError = AnyTaggedError;
export type TranscriptionEngine = {
	transcribe(recordingId: string): Promise<Result<string, TranscriptionError>>;
};

/** Commit the one terminal recording outcome around a host-selected engine. */
export function createTranscriptionUseCase(engine: TranscriptionEngine) {
	return async function transcribeAndPersist(
		recordingId: string,
	): Promise<Result<string, TranscriptionError>> {
		const { data: text, error } = await engine.transcribe(recordingId);
		if (error) {
			recordings.update(recordingId, {
				transcription: {
					status: 'failed',
					completedAt: InstantString.now(),
					error: extractErrorMessage(error),
				},
			});
			return Err(error);
		}
		recordings.update(recordingId, {
			transcript: text,
			polishedTranscript: null,
			transcription: {
				status: 'completed',
				completedAt: InstantString.now(),
			},
		});
		return Ok(text);
	};
}
