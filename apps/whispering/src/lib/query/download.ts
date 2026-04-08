import type { Result } from 'wellcrafted/result';
import { defineMutation } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import type { DownloadError } from '$lib/services/download';
import type { Recording } from '$lib/state/recordings.svelte';

export const download = {
	downloadRecording: defineMutation({
		mutationKey: ['download', 'downloadRecording'] as const,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<void, WhisperingError | DownloadError>> => {
			// Fetch audio blob by ID
			const { data: audioBlob, error: getAudioBlobError } =
				await services.db.recordings.getAudioBlob(recording.id);

			if (getAudioBlobError) {
				return WhisperingErr({
					title: '⚠️ Failed to fetch audio',
					description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
				});
			}

			return await services.download.downloadBlob({
				name: `whispering_recording_${recording.id}`,
				blob: audioBlob,
			});
		},
	}),
};
