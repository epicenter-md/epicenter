import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import mime from 'mime';
import { tryAsync } from 'wellcrafted/result';
import type { FsService } from './types';
import { FsServiceErr } from './types';

/** Get MIME type from file path. The mime library handles path parsing internally. */
function getMimeType(filePath: string): string {
	return mime.getType(filePath) ?? 'application/octet-stream';
}

export function createFsServiceDesktop(): FsService {
	return {
		pathToBlob: async (path: string) => {
			return tryAsync({
				try: async () => {
					const fileBytes = await readFile(path);
					const mimeType = getMimeType(path);
					return new Blob([fileBytes], { type: mimeType });
				},
				catch: (error) =>
					FsServiceErr({
						message: `Failed to read file as Blob: ${path}`,
						cause: error,
					}),
			});
		},

		pathToFile: async (path: string) => {
			return tryAsync({
				try: async () => {
					const fileBytes = await readFile(path);
					const fileName = await basename(path);
					const mimeType = getMimeType(path);
					return new File([fileBytes], fileName, { type: mimeType });
				},
				catch: (error) =>
					FsServiceErr({
						message: `Failed to read file as File: ${path}`,
						cause: error,
					}),
			});
		},

		pathsToFiles: async (paths: string[]) => {
			return tryAsync({
				try: async () => {
					const files: File[] = [];
					for (const path of paths) {
						const fileBytes = await readFile(path);
						const fileName = await basename(path);
						const mimeType = getMimeType(path);
						const file = new File([fileBytes], fileName, { type: mimeType });
						files.push(file);
					}
					return files;
				},
				catch: (error) =>
					FsServiceErr({
						message: `Failed to read files: ${paths.join(', ')}`,
						cause: error,
					}),
			});
		},
	};
}
