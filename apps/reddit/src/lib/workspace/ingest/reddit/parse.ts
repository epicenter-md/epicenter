/**
 * Reddit ZIP Parsing
 *
 * Phase 1 of the import pipeline: Parse ZIP → ParsedRedditData
 */

import { unzipSync } from 'fflate';
import { CSV } from '../utils/csv.js';

// CSV file names that map to table data
const TABLE_CSV_FILES = [
	'posts.csv',
	'comments.csv',
	'drafts.csv',
	'post_votes.csv',
	'comment_votes.csv',
	'poll_votes.csv',
	'saved_posts.csv',
	'saved_comments.csv',
	'hidden_posts.csv',
	'messages.csv',
	'messages_archive.csv',
	'chat_history.csv',
	'subscribed_subreddits.csv',
	'moderated_subreddits.csv',
	'approved_submitter_subreddits.csv',
	'multireddits.csv',
	'gilded_content.csv',
	'gold_received.csv',
	'purchases.csv',
	'subscriptions.csv',
	'payouts.csv',
	'friends.csv',
	'announcements.csv',
	'scheduled_posts.csv',
	'statistics.csv',
	'user_preferences.csv',
	// Intentionally excluded (see README.md):
	// - post_headers.csv, comment_headers.csv, message_headers.csv,
	//   messages_archive_headers.csv: strict subsets of their full counterparts (same rows, minus body)
	// - checkfile.csv: ZIP integrity checksums, not user data
	// - ip_logs.csv: login IP history. PII with no workspace value. Purely admin/security data.
	// - sensitive_ads_preferences.csv: Reddit ad targeting categories. Internal ad machinery, not user content.
	// - linked_identities.csv: opaque OAuth issuer/subject ID pairs. Internal identity metadata.
	// - linked_phone_number.csv, stripe.csv, persona.csv: opaque account identifiers (phone, Stripe, KYC).
	//   PII or internal IDs with no meaning outside Reddit.
	// - account_gender.csv, birthdate.csv, twitter.csv: profile metadata (gender, birthday, linked Twitter).
	//   Not essential to workspace: users already know these about themselves.
] as const;

/** CSV key derived from filename (e.g., 'posts.csv' → 'posts') */
type CsvFileName = (typeof TABLE_CSV_FILES)[number];
export type CsvKey = CsvFileName extends `${infer Name}.csv` ? Name : never;

/** Typed parse output: keys are the known CSV file stems */
export type ParsedRedditData = Record<CsvKey, Record<string, string>[]>;

/**
 * Convert CSV filename to schema key.
 * E.g., 'post_votes.csv' → 'post_votes'
 */
function csvNameToKey(filename: CsvFileName): CsvKey {
	return filename.replace('.csv', '') as CsvKey;
}

/**
 * Find all ZIP entries matching a CSV file name.
 * Matches both unsplit (`{name}.csv`) and batched (`{name}_{n}.csv`) variants,
 * with or without a subdirectory prefix.
 */
function findMatchingEntries(
	files: Record<string, Uint8Array>,
	csvFile: CsvFileName,
): Uint8Array[] {
	const stem = csvFile.replace('.csv', '');
	return Object.entries(files)
		.filter(([name]) => {
			const basename = name.includes('/')
				? (name.split('/').pop() ?? name)
				: name;
			return (
				basename === csvFile ||
				(basename.startsWith(`${stem}_`) && basename.endsWith('.csv'))
			);
		})
		.map(([, content]) => content);
}

/**
 * Parse a Reddit GDPR export ZIP file.
 *
 * @param input - ZIP file as Blob, File, or ArrayBuffer
 * @returns Parsed CSV data as Record<csvKey, rows[]>
 */
export async function parseRedditZip(
	input: Blob | ArrayBuffer,
): Promise<ParsedRedditData> {
	const bytes =
		input instanceof Blob ? await input.bytes() : new Uint8Array(input);

	// Unpack ZIP
	const files = unzipSync(bytes);

	// Parse each known CSV, defaulting to empty if absent
	const result: ParsedRedditData = {} as ParsedRedditData;

	for (const csvFile of TABLE_CSV_FILES) {
		const key = csvNameToKey(csvFile);

		// Find all matching files (handles batched CSVs like post_votes_1.csv, post_votes_2.csv)
		const entries = findMatchingEntries(files, csvFile);

		if (entries.length === 0) {
			result[key] = [];
			continue;
		}

		// Parse each file independently (each has its own header row) and concatenate rows
		const allRows: Record<string, string>[] = [];
		for (const content of entries) {
			let text = new TextDecoder().decode(content);
			text = text.replace(/^\uFEFF/, ''); // Strip UTF-8 BOM
			allRows.push(...CSV.parse<Record<string, string>>(text));
		}
		result[key] = allRows;
	}

	return result;
}
