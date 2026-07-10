import { defineKeys } from 'wellcrafted/query';
import { Ok, partitionResults } from 'wellcrafted/result';
import { environment } from '#environment';
import { defineMutation, queryClient } from '$lib/rpc/client';
import type { Recording } from '$lib/state/recordings.svelte';

export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({
				mutationKey: transcriptionKeys.isTranscribing,
			}) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: (recording: Recording) =>
			environment.transcription.transcribeAndPersist(recording.id),
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map((recording) =>
					environment.transcription.transcribeAndPersist(recording.id),
				),
			);
			return Ok(partitionResults(results));
		},
	}),
};
