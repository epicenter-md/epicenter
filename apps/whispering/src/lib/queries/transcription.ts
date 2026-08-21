import { defineKeys } from 'wellcrafted/query';
import { Ok, partitionResults } from 'wellcrafted/result';
import { processTranscript } from '$lib/operations/process-transcript';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export function createTranscriptionQueries(
	app: WhisperingApp,
	{
		defineMutation,
		queryClient,
	}: Pick<WhisperingQueryRuntime, 'defineMutation' | 'queryClient'>,
) {
	async function transcribeOne(recording: Recording) {
		const result = await transcribeAndPersist(
			app,
			recording.id,
			recording.audioBlobId,
		);
		if (result.error !== null) return result;
		return Ok(
			processTranscript(app, {
				recordingId: recording.id,
				...result.data,
				final: true,
			}),
		);
	}

	return {
		isCurrentlyTranscribing() {
			return (
				queryClient.isMutating({
					mutationKey: transcriptionKeys.isTranscribing,
				}) > 0
			);
		},
		transcribeRecording: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: transcribeOne,
		}),

		transcribeRecordings: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: async (recordings: Recording[]) => {
				const results = await Promise.all(recordings.map(transcribeOne));
				return Ok(partitionResults(results));
			},
		}),
	};
}
