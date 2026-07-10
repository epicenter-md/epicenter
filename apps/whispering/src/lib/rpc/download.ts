import { defineKeys } from 'wellcrafted/query';
import { Err, type Result } from 'wellcrafted/result';
import type { BlobError } from '$lib/services/blob-store/types';
import type { DownloadError } from '$lib/services/download/types';
import { defineMutation } from '$lib/rpc/client';
import { services } from '$lib/services';
import type { Recording } from '$lib/state/recordings.svelte';

export const downloadKeys = defineKeys({
	downloadRecording: ['download', 'downloadRecording'],
});

export const download = {
	downloadRecording: defineMutation({
		mutationKey: downloadKeys.downloadRecording,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<void, BlobError | DownloadError>> => {
			const { data: audioBlob, error: getAudioBlobError } =
				await services.blobs.audio.getBlob(recording.id);

			if (getAudioBlobError) return Err(getAudioBlobError);

			return services.download.downloadBlob({
				name: `whispering_recording_${recording.id}`,
				blob: audioBlob,
			});
		},
	}),
};
