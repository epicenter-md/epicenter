/**
 * Reddit ZIP Parsing
 *
 * Phase 1 of the import pipeline: Parse ZIP → Record<string, Record<string, string>[]>
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
	'linked_identities.csv',
	'announcements.csv',
	'scheduled_posts.csv',
	'ip_logs.csv',
	'sensitive_ads_preferences.csv',
	'account_gender.csv',
	'birthdate.csv',
	'statistics.csv',
	'user_preferences.csv',
	'linked_phone_number.csv',
	'stripe.csv',
	'twitter.csv',
	'persona.csv',
	// Redundant but validate
	'post_headers.csv',
	'comment_headers.csv',
	'message_headers.csv',
	'messages_archive_headers.csv',
	// Metadata
	'checkfile.csv',
] as const;

// Required CSVs that must be present
const REQUIRED_CSV_FILES = [
	'posts.csv',
	'comments.csv',
	'post_votes.csv',
	'comment_votes.csv',
] as const;

// Optional CSVs (may be absent based on user activity)
const OPTIONAL_CSV_FILES = ['messages.csv', 'message_headers.csv'] as const;

/**
 * Convert CSV filename to schema key.
 * E.g., 'post_votes.csv' → 'post_votes'
 */
function csvNameToKey(filename: string): string {
	return filename.replace('.csv', '');
}

/**
 * Parse a Reddit GDPR export ZIP file.
 *
 * @param input - ZIP file as Blob, File, or ArrayBuffer
 * @returns Parsed CSV data as Record<csvKey, rows[]>
 */
export async function parseRedditZip(
	input: Blob | ArrayBuffer,
): Promise<Record<string, Record<string, string>[]>> {
	// Convert input to Uint8Array
	let bytes: Uint8Array;
	if (input instanceof Blob) {
		const buffer = await input.arrayBuffer();
		bytes = new Uint8Array(buffer);
	} else {
		bytes = new Uint8Array(input);
	}

	// Unpack ZIP
	const files = unzipSync(bytes);

	// Validate required CSVs exist
	for (const required of REQUIRED_CSV_FILES) {
		const found = Object.keys(files).some(
			(name) => name === required || name.endsWith('/' + required),
		);
		if (!found) {
			throw new Error(`Missing required CSV file: ${required}`);
		}
	}

	// Parse each CSV
	const result: Record<string, Record<string, string>[]> = {};

	for (const csvFile of TABLE_CSV_FILES) {
		const key = csvNameToKey(csvFile);

		// Find the file (may be in root or subdirectory)
		const entry = Object.entries(files).find(
			([name]) => name === csvFile || name.endsWith('/' + csvFile),
		);

		if (!entry) {
			// Handle optional files
			if (
				OPTIONAL_CSV_FILES.includes(
					csvFile as (typeof OPTIONAL_CSV_FILES)[number],
				)
			) {
				result[key] = [];
				continue;
			}
			// Non-optional files default to empty array
			result[key] = [];
			continue;
		}

		const [, content] = entry;
		const text = new TextDecoder().decode(content);
		const rows = CSV.parse<Record<string, string>>(text);
		result[key] = rows;
	}

	return result;
}
