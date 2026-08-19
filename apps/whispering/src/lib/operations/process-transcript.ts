import { report } from '$lib/report';
import type { WhisperingApp } from '$lib/whispering/app';
import type { RecordingId } from '$lib/workspace';
import { runTransformations } from './run-transformations';
import {
	saveRecordingHistory,
	type TranscriptionSuccess,
} from './transcription-history';

/**
 * Apply the current deterministic pipeline after raw persistence.
 *
 * Intermediate callers continue into Polish; final callers persist the
 * transformed text directly. In both cases an invalid Transformation is skipped
 * atomically, reported, and cannot block later groups or usable output.
 */
export function processTranscript(
	app: WhisperingApp,
	{
		recordingId,
		text,
		history,
		final,
	}: TranscriptionSuccess & {
		recordingId: RecordingId;
		final: boolean;
	},
): TranscriptionSuccess {
	const transformed = runTransformations(text, app.transformations.sorted);
	for (const failure of transformed.failures) {
		report.info({
			title: `Transformation skipped: ${failure.transformationName}`,
			description: `Step ${failure.stepPosition + 1}: ${failure.message}`,
		});
	}

	if (!final) return { text: transformed.text, history };
	const deliveredHistory = saveRecordingHistory(app, recordingId, {
		deliveredTranscript: transformed.text,
	});
	return {
		text: transformed.text,
		history: deliveredHistory.error === null ? history : deliveredHistory,
	};
}
