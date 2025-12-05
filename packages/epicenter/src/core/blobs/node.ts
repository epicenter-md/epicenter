import { join } from 'node:path';
import mime from 'mime';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import type { TableBlobStore } from './types.js';
import { BlobErr } from './types.js';
import { validateFilename } from './utils.js';

/**
 * Create a blob store for a table using Bun's filesystem APIs.
 * This implementation is used in Node/Bun environments.
 *
 * @param storageDir The base storage directory (absolute path)
 * @param tableName The table name (used as subdirectory)
 * @returns A TableBlobStore implementation
 */
export function createNodeTableBlobStore(
	storageDir: string,
	tableName: string,
): TableBlobStore {
	const tableDir = join(storageDir, tableName);

	return {
		async put(filename, data) {
			const validation = validateFilename(filename);
			if (validation.error) return validation;

			const filePath = join(tableDir, filename);

			return tryAsync({
				try: async () => {
					// Bun.write automatically creates parent directories
					await Bun.write(filePath, data);
				},
				catch: (error) =>
					BlobErr({
						message: `Failed to write blob "${filename}": ${extractErrorMessage(error)}`,
						context: { filename, code: 'WRITE_FAILED' },
					}),
			});
		},

		async get(filename) {
			const validation = validateFilename(filename);
			if (validation.error) return validation;

			const filePath = join(tableDir, filename);

			return tryAsync({
				try: async () => {
					const file = Bun.file(filePath);
					const exists = await file.exists();

					if (!exists) {
						return null;
					}

					const arrayBuffer = await file.arrayBuffer();
					const mimeType = mime.getType(filename) ?? 'application/octet-stream';
					return new Blob([arrayBuffer], { type: mimeType });
				},
				catch: (error) =>
					BlobErr({
						message: `Failed to read blob "${filename}": ${extractErrorMessage(error)}`,
						context: { filename, code: 'READ_FAILED' },
					}),
			});
		},

		async delete(filename) {
			const validation = validateFilename(filename);
			if (validation.error) return validation;

			const filePath = join(tableDir, filename);

			return tryAsync({
				try: async () => {
					const file = Bun.file(filePath);
					const exists = await file.exists();
					if (exists) {
						await file.delete();
					}
				},
				catch: (error) =>
					BlobErr({
						message: `Failed to delete blob "${filename}": ${extractErrorMessage(error)}`,
						context: { filename, code: 'DELETE_FAILED' },
					}),
			});
		},

		async exists(filename) {
			const validation = validateFilename(filename);
			if (validation.error) return validation;

			const filePath = join(tableDir, filename);

			return tryAsync({
				try: async () => {
					const file = Bun.file(filePath);
					return await file.exists();
				},
				catch: () => Ok(false),
			});
		},
	};
}
