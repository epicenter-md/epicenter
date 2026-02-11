import { ZIP } from '../../../utils/archive/zip';
import { CSV } from '../../../utils/format/csv';

export async function parseRedditExport(file: Blob) {
	// Read entire zip as Uint8Array
	const ab = await file.arrayBuffer();
	const zipMap = await ZIP.unpack(new Uint8Array(ab)); // { [filename]: Uint8Array }

	// Read+parse helpers
	const decode = (bytes: Uint8Array) =>
		new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);

	const readCsv = async (name: string) => {
		const bytes = zipMap[name];
		const csvText = bytes ? decode(bytes) : '';
		return CSV.parse(csvText);
	};

	const files = [
		'posts',
		'comments',
		'post_headers',
		'comment_headers',
		'post_votes',
		'comment_votes',
		'saved_posts',
		'saved_comments',
		'hidden_posts',
		'message_headers',
		'messages',
		'messages_archive_headers',
		'messages_archive',
		'chat_history',
		'account_gender',
		'sensitive_ads_preferences',
		'birthdate',
		'user_preferences',
		'linked_identities',
		'linked_phone_number',
		'twitter',
		'approved_submitter_subreddits',
		'moderated_subreddits',
		'subscribed_subreddits',
		'multireddits',
		'purchases',
		'subscriptions',
		'payouts',
		'stripe',
		'announcements',
		'drafts',
		'friends',
		'gilded_content',
		'gold_received',
		'ip_logs',
		'persona',
		'poll_votes',
		'scheduled_posts',
		'statistics',
		'checkfile',
	] as const;

	return Object.fromEntries<Record<string, unknown>[]>(
		await Promise.all(
			files.map(async (f) => [f, await readCsv(`${f}.csv`)] as const),
		),
	);
}
