import { Ok } from 'wellcrafted/result';
import { BlobErr } from './types.js';

/**
 * Filename validation pattern.
 * - Must start with alphanumeric character
 * - Can contain dots, underscores, and hyphens
 * - Must end with a file extension
 *
 * Valid examples: "file.png", "file.tar.gz", "v1.2.3.zip", "my_file-2024.pdf"
 * Invalid examples: ".hidden", "-start.txt", "../traversal.txt"
 */
const FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+$/;

/**
 * Validate a filename for blob storage.
 *
 * Valid format: `[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+`
 * - Must start with alphanumeric character
 * - Middle can contain letters, numbers, dots, underscores, hyphens
 * - Must end with a file extension (e.g., `.png`, `.tar.gz`)
 * - No path separators (`/`, `\`) or traversal (`..`)
 *
 * @example
 * // Valid
 * validateFilename('avatar.png')      // Ok
 * validateFilename('file_v1.2.tar.gz') // Ok
 * validateFilename('my-file-2024.pdf') // Ok
 *
 * // Invalid
 * validateFilename('.hidden')          // Err (starts with dot)
 * validateFilename('path/to/file.txt') // Err (contains /)
 * validateFilename('../escape.txt')    // Err (path traversal)
 *
 * @param filename The filename to validate
 * @returns Ok(undefined) if valid, BlobErr if invalid
 */
export function validateFilename(filename: string) {
	// Security: prevent path traversal
	if (
		filename.includes('/') ||
		filename.includes('\\') ||
		filename.includes('..')
	) {
		return BlobErr({
			message: `Invalid filename: ${filename}. Path separators and traversal not allowed.`,
			context: { filename, code: 'INVALID_FILENAME' },
		});
	}

	if (!FILENAME_PATTERN.test(filename)) {
		return BlobErr({
			message: `Invalid filename: ${filename}. Must start with alphanumeric and end with extension (e.g., "file.png", "archive.tar.gz")`,
			context: { filename, code: 'INVALID_FILENAME' },
		});
	}

	return Ok(undefined);
}

