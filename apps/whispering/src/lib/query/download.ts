import type { Result } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import * as services from '$lib/services';
import type { Recording } from '$lib/services/db';
import type { DownloadServiceError } from '$lib/services/download';
import { defineMutation } from './_client';

export const download = {
	downloadRecording: defineMutation({
		mutationKey: ['download', 'downloadRecording'] as const,
		resultMutationFn: async (
			recording: Recording,
		): Promise<Result<void, WhisperingError | DownloadServiceError>> => {
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
