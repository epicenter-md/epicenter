import { parse as csvParse } from 'csv-parse';
import { unzipSync } from 'fflate';
import type { ParsedRedditExport } from './index';

/**
 * CSV record shape directly from export files
 * We keep fields loose (string | undefined) and coerce downstream.
 */
type RawRecord = Record<string, string | undefined>;

// Result type comes from ArkType schema in index.ts
// We return a ParsedRedditExport object, matching parseSchema.

export async function parseRedditExport(
	file: Blob,
): Promise<ParsedRedditExport> {
	// Read entire zip as Uint8Array
	const ab = await file.arrayBuffer();
	const zipMap = unzipSync(new Uint8Array(ab)); // { [filename]: Uint8Array }

	// Read+parse helpers
	const decode = (bytes: Uint8Array) =>
		new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);

	const readCsvText = (name: string): string => {
		const bytes = zipMap[name];
		return bytes ? decode(bytes) : '';
	};

	const readCsv = async (name: string): Promise<RawRecord[]> =>
		parseCsv(readCsvText(name));

	// Parse CSVs used today
	const postsRecords = await readCsv('posts.csv');
	const commentsRecords = await readCsv('comments.csv');

	// Map to normalized shapes with coercions/derivations
	const posts = postsRecords
		.map((r) => mapPost(r))
		.filter((p) => p !== undefined);

	const comments = commentsRecords
		.map((r) => mapComment(r))
		.filter((c) => c !== undefined);

	// Lightly mapped datasets (string fields only; optional everywhere)
	const post_headers = (await readCsv('post_headers.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		subreddit: u(r.subreddit),
		gildings: numOrUndefined(r.gildings),
		url: u(r.url),
	}));

	const comment_headers = (await readCsv('comment_headers.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		subreddit: u(r.subreddit),
		gildings: numOrUndefined(r.gildings),
		link: u(r.link),
		parent: u(r.parent),
	}));

	const post_votes = (await readCsv('post_votes.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		direction: u(r.direction),
	}));

	const comment_votes = (await readCsv('comment_votes.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		direction: u(r.direction),
	}));

	const saved_posts = (await readCsv('saved_posts.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
	}));

	const saved_comments = (await readCsv('saved_comments.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
	}));

	const hidden_posts = (await readCsv('hidden_posts.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
	}));

	const message_headers = (await readCsv('message_headers.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		thread_id: u(r.thread_id),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		from: u(r.from),
		to: u(r.to),
	}));

	const messages = (await readCsv('messages.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		thread_id: u(r.thread_id),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		from: u(r.from),
		to: u(r.to),
		subject: u(r.subject),
		body: u(r.body),
	}));

	const messages_archive_headers = (
		await readCsv('messages_archive_headers.csv')
	).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		thread_id: u(r.thread_id),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		from: u(r.from),
		to: u(r.to),
	}));

	const messages_archive = (await readCsv('messages_archive.csv')).map((r) => ({
		id: u(r.id),
		permalink: u(r.permalink),
		thread_id: u(r.thread_id),
		date: toDate(u(r.date)),
		ip: u(r.ip),
		from: u(r.from),
		to: u(r.to),
		subject: u(r.subject),
		body: u(r.body),
	}));

	const chat_history = (await readCsv('chat_history.csv')).map((r) => ({
		message_id: u(r.message_id),
		created_at: toDate(u(r.created_at)),
		updated_at: toDate(u(r.updated_at)),
		username: u(r.username),
		message: u(r.message),
		thread_parent_message_id: u(r.thread_parent_message_id),
		channel_url: u(r.channel_url),
		subreddit: u(r.subreddit),
		channel_name: u(r.channel_name),
		conversation_type: u(r.conversation_type),
	}));

	const account_gender = (await readCsv('account_gender.csv')).map((r) => ({
		account_gender: u(r.account_gender),
	}));

	const sensitive_ads_preferences = (
		await readCsv('sensitive_ads_preferences.csv')
	).map((r) => ({
		type: u(r.type),
		preference: u(r.preference),
	}));

	const birthdate = (await readCsv('birthdate.csv')).map((r) => ({
		birthdate: toDate(u(r.birthdate)),
		verified_birthdate: toDate(u(r.verified_birthdate)),
		verification_state: u(r.verification_state),
		verification_method: u(r.verification_method),
	}));

	const user_preferences = (await readCsv('user_preferences.csv')).map((r) => ({
		preference: u(r.preference),
		value: u(r.value),
	}));

	const linked_identities = (await readCsv('linked_identities.csv')).map(
		(r) => ({
			issuer_id: u(r.issuer_id),
			subject_id: u(r.subject_id),
		}),
	);

	const linked_phone_number = (await readCsv('linked_phone_number.csv')).map(
		(r) => ({
			phone_number: u(r.phone_number),
		}),
	);

	const twitter = (await readCsv('twitter.csv')).map((r) => ({
		username: u(r.username),
	}));

	const approved_submitter_subreddits = (
		await readCsv('approved_submitter_subreddits.csv')
	).map((r) => ({
		subreddit: u(r.subreddit),
	}));

	const moderated_subreddits = (await readCsv('moderated_subreddits.csv')).map(
		(r) => ({
			subreddit: u(r.subreddit),
		}),
	);

	const subscribed_subreddits = (
		await readCsv('subscribed_subreddits.csv')
	).map((r) => ({
		subreddit: u(r.subreddit),
	}));

	const multireddits = (await readCsv('multireddits.csv')).map((r) => ({
		id: u(r.id),
		display_name: u(r.display_name),
		date: toDate(u(r.date)),
		description: u(r.description),
		privacy: u(r.privacy),
		subreddits: u(r.subreddits),
		image_url: u(r.image_url),
		is_owner: u(r.is_owner),
		favorited: u(r.favorited),
		followers: u(r.followers),
	}));

	const purchases = (await readCsv('purchases.csv')).map((r) => ({
		processor: u(r.processor),
		transaction_id: u(r.transaction_id),
		product: u(r.product),
		date: toDate(u(r.date)),
		cost: u(r.cost),
		currency: u(r.currency),
		status: u(r.status),
	}));

	const subscriptions = (await readCsv('subscriptions.csv')).map((r) => ({
		processor: u(r.processor),
		subscription_id: u(r.subscription_id),
		product: u(r.product),
		product_id: u(r.product_id),
		product_name: u(r.product_name),
		status: u(r.status),
		start_date: toDate(u(r.start_date)),
		end_date: toDate(u(r.end_date)),
	}));

	const payouts = (await readCsv('payouts.csv')).map((r) => ({
		payout_amount_usd: u(r.payout_amount_usd),
		date: toDate(u(r.date)),
		payout_id: u(r.payout_id),
	}));

	const stripe = (await readCsv('stripe.csv')).map((r) => ({
		stripe_account_id: u(r.stripe_account_id),
	}));

	const announcements = (await readCsv('announcements.csv')).map((r) => ({
		announcement_id: u(r.announcement_id),
		sent_at: toDate(u(r.sent_at)),
		read_at: toDate(u(r.read_at)),
		from_id: u(r.from_id),
		from_username: u(r.from_username),
		subject: u(r.subject),
		body: u(r.body),
		url: u(r.url),
	}));

	const drafts = (await readCsv('drafts.csv')).map((r) => ({
		id: u(r.id),
		title: u(r.title),
		body: u(r.body),
		kind: u(r.kind),
		created: toDate(u(r.created)),
		spoiler: u(r.spoiler),
		nsfw: u(r.nsfw),
		original_content: u(r.original_content),
		content_category: u(r.content_category),
		flair_id: u(r.flair_id),
		flair_text: u(r.flair_text),
		send_replies: u(r.send_replies),
		subreddit: u(r.subreddit),
		is_public_link: u(r.is_public_link),
	}));

	const friends = (await readCsv('friends.csv')).map((r) => ({
		username: u(r.username),
		note: u(r.note),
	}));

	const gilded_content = (await readCsv('gilded_content.csv')).map((r) => ({
		content_link: u(r.content_link),
		award: u(r.award),
		amount: u(r.amount),
		date: toDate(u(r.date)),
	}));

	const gold_received = (await readCsv('gold_received.csv')).map((r) => ({
		content_link: u(r.content_link),
		gold_received: u(r.gold_received),
		gilder_username: u(r.gilder_username),
		date: toDate(u(r.date)),
	}));

	const ip_logs = (await readCsv('ip_logs.csv')).map((r) => ({
		date: toDate(u(r.date)),
		ip: u(r.ip),
	}));

	const persona = (await readCsv('persona.csv')).map((r) => ({
		persona_inquiry_id: u(r.persona_inquiry_id),
	}));

	const poll_votes = (await readCsv('poll_votes.csv')).map((r) => ({
		post_id: u(r.post_id),
		user_selection: u(r.user_selection),
		text: u(r.text),
		image_url: u(r.image_url),
		is_prediction: u(r.is_prediction),
		stake_amount: u(r.stake_amount),
	}));

	const scheduled_posts = (await readCsv('scheduled_posts.csv')).map((r) => ({
		scheduled_post_id: u(r.scheduled_post_id),
		subreddit: u(r.subreddit),
		title: u(r.title),
		body: u(r.body),
		url: u(r.url),
		submission_time: toDate(u(r.submission_time)),
		recurrence: u(r.recurrence),
	}));

	const statistics = (await readCsv('statistics.csv')).map((r) => ({
		statistic: u(r.statistic),
		value: u(r.value),
	}));

	const checkfile = (await readCsv('checkfile.csv')).map((r) => ({
		filename: u(r.filename),
		sha256: u(r.sha256),
	}));

	return {
		// Core content
		posts: dropEmptyRows(posts),
		post_headers: dropEmptyRows(post_headers),
		comments: dropEmptyRows(comments),
		comment_headers: dropEmptyRows(comment_headers),

		// Votes / visibility / saves
		post_votes: dropEmptyRows(post_votes),
		comment_votes: dropEmptyRows(comment_votes),
		saved_posts: dropEmptyRows(saved_posts),
		saved_comments: dropEmptyRows(saved_comments),
		hidden_posts: dropEmptyRows(hidden_posts),

		// Messaging
		message_headers: dropEmptyRows(message_headers),
		messages: dropEmptyRows(messages),
		messages_archive_headers: dropEmptyRows(messages_archive_headers),
		messages_archive: dropEmptyRows(messages_archive),

		// Chat
		chat_history: dropEmptyRows(chat_history),

		// Account and preferences
		account_gender: dropEmptyRows(account_gender),
		sensitive_ads_preferences: dropEmptyRows(sensitive_ads_preferences),
		birthdate: dropEmptyRows(birthdate),
		user_preferences: dropEmptyRows(user_preferences),
		linked_identities: dropEmptyRows(linked_identities),
		linked_phone_number: dropEmptyRows(linked_phone_number),
		twitter: dropEmptyRows(twitter),

		// Moderation / subscriptions / subreddits
		approved_submitter_subreddits: dropEmptyRows(approved_submitter_subreddits),
		moderated_subreddits: dropEmptyRows(moderated_subreddits),
		subscribed_subreddits: dropEmptyRows(subscribed_subreddits),
		multireddits: dropEmptyRows(multireddits),

		// Commerce and payouts
		purchases: dropEmptyRows(purchases),
		subscriptions: dropEmptyRows(subscriptions),
		payouts: dropEmptyRows(payouts),
		stripe: dropEmptyRows(stripe),

		// Misc
		announcements: dropEmptyRows(announcements),
		drafts: dropEmptyRows(drafts),
		friends: dropEmptyRows(friends),
		gilded_content: dropEmptyRows(gilded_content),
		gold_received: dropEmptyRows(gold_received),
		ip_logs: dropEmptyRows(ip_logs),
		persona: dropEmptyRows(persona),
		poll_votes: dropEmptyRows(poll_votes),
		scheduled_posts: dropEmptyRows(scheduled_posts),
		statistics: dropEmptyRows(statistics),
		checkfile: dropEmptyRows(checkfile),
	};
}

/**
 * csv-parse promise wrapper for convenience
 */
function parseCsv(input: string): Promise<RawRecord[]> {
	return new Promise((resolve, reject) => {
		if (!input || input.trim().length === 0) return resolve([]);
		csvParse(
			input,
			{
				columns: true,
				bom: true,
				skip_empty_lines: true,
				relax_column_count: true,
				trim: true,
			},
			(err: unknown | null, records: RawRecord[]) => {
				if (err) reject(err);
				else resolve(records);
			},
		);
	});
}

/**
 * Coercion helpers
 */
function u(v: string | undefined): string | undefined {
	return blankToUndefined(v);
}
function blankToUndefined(v: string | undefined): string | undefined {
	if (v == null) return undefined;
	const t = v.trim();
	return t === '' ? undefined : t;
}
function numOrUndefined(v: string | undefined): number | undefined {
	const t = blankToUndefined(v);
	if (t == null) return undefined;
	const n = Number(t);
	return Number.isFinite(n) ? n : undefined;
}
function toDate(dateStr: string | undefined): Date | undefined {
	const s = blankToUndefined(dateStr);
	if (!s) return undefined;
	const num = Number(s);
	if (Number.isFinite(num)) {
		const ms = num < 1e12 ? num * 1000 : num;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? undefined : d;
	}
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? undefined : d;
}
function extractPostIdFromUrl(urlStr: string | undefined): string | undefined {
	if (!urlStr) return undefined;
	try {
		const u = new URL(urlStr);
		// Example: /r/sveltejs/comments/1kp9tv3/transitions.../mswmz2d/
		const parts = u.pathname.split('/').filter(Boolean);
		const idx = parts.indexOf('comments');
		if (idx >= 0 && parts.length > idx + 1) {
			const candidate = parts[idx + 1]?.trim();
			if (candidate) return candidate;
		}
	} catch {
		// non-URL or malformed; ignore
	}
	return undefined;
}

/**
 * Filter helpers to remove rows that are entirely empty after coercion
 * (i.e., every property is undefined or null). This protects downstream upserts
 * from generating "No values to set" when a CSV contains a single blank row.
 */
function isNonEmptyRow(obj: Record<string, unknown>): boolean {
	for (const v of Object.values(obj)) {
		if (v !== undefined && v !== null) return true;
	}
	return false;
}
function dropEmptyRows<T extends Record<string, unknown>>(rows: T[]): T[] {
	return rows.filter((r) => isNonEmptyRow(r as Record<string, unknown>));
}

/**
 * Mapping: posts.csv
 * Headers: id,permalink,date,ip,subreddit,gildings,title,url,body
 */
function mapPost(
	r: RawRecord,
): ParsedRedditExport['posts'][number] | undefined {
	const id = u(r.id);
	const permalink = u(r.permalink);
	const dateStr = u(r.date);
	const subreddit = u(r.subreddit);

	if (!id || !permalink || !dateStr || !subreddit) return undefined;

	const date = toDate(dateStr);
	if (date == null) return undefined;

	const created_utc = date;

	return {
		id,
		permalink,
		date,
		created_utc,
		ip: u(r.ip),
		subreddit,
		gildings: numOrUndefined(r.gildings),
		title: u(r.title),
		url: u(r.url),
		body: u(r.body),
	};
}

/**
 * Mapping: comments.csv
 * Headers: id,permalink,date,ip,subreddit,gildings,link,parent,body,media
 */
function mapComment(
	r: RawRecord,
): ParsedRedditExport['comments'][number] | undefined {
	const id = u(r.id);
	const permalink = u(r.permalink);
	const dateStr = u(r.date);
	const subreddit = u(r.subreddit);
	const link = u(r.link);

	if (!id || !permalink || !dateStr || !subreddit || !link) return undefined;

	const date = toDate(dateStr);
	if (date == null) return undefined;

	const created_utc = date;
	const post_id = extractPostIdFromUrl(link) ?? extractPostIdFromUrl(permalink);

	return {
		id,
		permalink,
		date,
		created_utc,
		ip: u(r.ip),
		subreddit,
		gildings: numOrUndefined(r.gildings),
		link,
		post_id,
		parent: u(r.parent),
		body: u(r.body),
		media: u(r.media),
	};
}
