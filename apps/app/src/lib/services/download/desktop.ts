import { getExtensionFromAudioBlob } from '$lib/utils';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { DownloadService } from '.';
import { DownloadServiceError } from './types';

export function createDownloadServiceDesktop(): DownloadService {
	return {
		downloadBlob: async ({ name, blob }) => {
			const extension = getExtensionFromAudioBlob(blob);
			const { data: path, error: saveError } = await tryAsync({
				try: async () => {
					const path = await save({
						filters: [{ name, extensions: [extension] }],
					});
					return path;
				},
				mapError: (error) =>
					DownloadServiceError({
						message:
							'There was an error saving the recording using the Tauri Filesystem API. Please try again.',
						context: { name, blob },
						cause: error,
					}),
			});
			if (saveError) return Err(saveError);
			if (path === null) {
				return Err(
					DownloadServiceError({
						message: 'Please specify a path to save the recording.',
						context: { name, blob },
						cause: undefined,
					}),
				);
			}
			const { error: writeError } = await tryAsync({
				try: async () => {
					const contents = new Uint8Array(await blob.arrayBuffer());
					await writeFile(path, contents);
				},
				mapError: (error) =>
					DownloadServiceError({
						message:
							'There was an error saving the recording using the Tauri Filesystem API. Please try again.',
						context: { name, blob, path },
						cause: error,
					}),
			});
			if (writeError) return Err(writeError);
			return Ok(undefined);
		},
	};
}
