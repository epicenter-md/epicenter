import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { getExtensionFromAudioBlob } from '$lib/services/_utils';
import type { DownloadService } from '.';
import { DownloadServiceErr } from './types';

export function createDownloadServiceDesktop(): DownloadService {
	return {
		downloadBlob: async ({ name, blob }) => {
			const extension = getExtensionFromAudioBlob(blob);
			const { data: path, error: saveError } = await tryAsync({
				try: () =>
					save({
						filters: [{ name, extensions: [extension] }],
					}),
				catch: (error) =>
					DownloadServiceErr({
						message:
							'There was an error saving the recording using the Tauri Filesystem API. Please try again.',
						context: { name, blob },
						cause: error,
					}),
			});
			if (saveError) return Err(saveError);
			if (path === null) {
				return DownloadServiceErr({
					message: 'Please specify a path to save the recording.',
					context: { name, blob },
					cause: undefined,
				});
			}
			const { error: writeError } = await tryAsync({
				try: async () => {
					const contents = new Uint8Array(await blob.arrayBuffer());
					await writeFile(path, contents);
				},
				catch: (error) =>
					DownloadServiceErr({
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
