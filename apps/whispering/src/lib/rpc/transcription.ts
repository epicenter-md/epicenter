import { defineKeys } from 'wellcrafted/query';
import { Ok, partitionResults } from 'wellcrafted/result';
import { transcribeAndPersist } from '$lib/operations/transcribe';
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
			transcribeAndPersist(recording.id, recording.audioBlobId),
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map((recording) =>
					transcribeAndPersist(recording.id, recording.audioBlobId),
				),
			);
			return Ok(partitionResults(results));
		},
	}),
};
