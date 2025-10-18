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
			if (!recording.blob) {
				return WhisperingErr({
					title: '⚠️ Recording blob not found',
					description: "Your recording doesn't have a blob to download.",
				});
			}

			return await services.download.downloadBlob({
				name: `whispering_recording_${recording.id}`,
				blob: recording.blob,
			});
		},
	}),
};
