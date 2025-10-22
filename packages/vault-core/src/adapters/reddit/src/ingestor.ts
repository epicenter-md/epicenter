import { defineIngestor } from '@repo/vault-core';
import { parseRedditExport as parse } from './parse';

/**
 * ZIP ingestor for Reddit GDPR export.
 * - Matches a single .zip File
 * - Parses via existing parseRedditExport (Blob-compatible)
 * - Returns normalized payload ready for validation/upsert
 */
export const redditZipIngestor = defineIngestor({
	matches(file) {
		return /\.zip$/i.test(file.name ?? '');
	},
	parse,
});
