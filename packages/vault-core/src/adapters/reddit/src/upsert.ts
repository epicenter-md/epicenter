import type {
	AnySQLiteColumn,
	BaseSQLiteDatabase,
	SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import type { ParsedRedditExport } from '.';
import {
	reddit_account_gender,
	reddit_announcements,
	reddit_approved_submitter_subreddits,
	reddit_birthdate,
	reddit_chat_history,
	reddit_checkfile,
	reddit_comment_headers,
	reddit_comment_votes,
	reddit_comments,
	reddit_drafts,
	reddit_friends,
	reddit_gilded_content,
	reddit_gold_received,
	reddit_hidden_posts,
	reddit_ip_logs,
	reddit_linked_identities,
	reddit_linked_phone_number,
	reddit_message_headers,
	reddit_messages,
	reddit_messages_archive,
	reddit_messages_archive_headers,
	reddit_moderated_subreddits,
	reddit_multireddits,
	reddit_payouts,
	reddit_persona,
	reddit_poll_votes,
	reddit_post_headers,
	reddit_post_votes,
	reddit_posts,
	reddit_purchases,
	reddit_saved_comments,
	reddit_saved_posts,
	reddit_scheduled_posts,
	reddit_sensitive_ads_preferences,
	reddit_statistics,
	reddit_stripe,
	reddit_subscribed_subreddits,
	reddit_subscriptions,
	reddit_twitter,
	reddit_user_preferences,
} from './schema';

// Parser now emits Date objects for all timestamp fields per parseSchema; no extra coercion needed here.

/**
 * Small utility to chunk arrays for batched inserts to keep statements reasonable.
 */
function chunk<T>(arr: T[], size: number): T[][] {
	if (size <= 0) return [arr];
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/**
 * Remove undefined/null fields from a row. If nothing remains, it's an "empty" row.
 */
function pruneRow<T extends Record<string, unknown>>(row: T): Partial<T> {
	const cleaned: Partial<T> = {};
	for (const [k, v] of Object.entries(row)) {
		if (v !== undefined && v !== null) {
			(cleaned as Record<string, unknown>)[k] = v;
		}
	}
	return cleaned;
}

/**
 * Generic, safe onConflict upsert for a single row object.
 * Falls back to per-row inserts to preserve idempotency and simplicity.
 */
async function upsertOne<T>(
	tx: unknown,
	table: SQLiteTable,
	row: T,
	target: unknown, // allow column or composite array
): Promise<void> {
	// Guard against empty CSV rows that parse into all-undefined fields.
	const cleaned = pruneRow(
		row as unknown as Record<string, unknown>,
	) as Partial<T>;
	if (Object.keys(cleaned).length === 0) {
		// Nothing to insert/update; skip silently.
		return;
	}
	const anyTx = tx as {
		insert: (tbl: SQLiteTable) => {
			values: (v: Partial<T>) => {
				onConflictDoUpdate: (args: {
					target: unknown;
					set: Partial<T>;
				}) => Promise<unknown>;
			};
		};
	};
	await anyTx.insert(table).values(cleaned).onConflictDoUpdate({
		target,
		set: cleaned,
	});
}

/**
 * Upsert many rows by iterating records with conflict handling.
 * Uses small per-row statements to stay simple and avoid driver limits.
 */
async function upsertMany<T>(
	tx: unknown,
	table: SQLiteTable,
	rows: T[],
	target: AnySQLiteColumn | readonly AnySQLiteColumn[],
): Promise<void> {
	for (const r of rows) {
		await upsertOne(tx, table, r, target);
	}
}

/**
 * Implement the Adapter.upsert contract.
 *
 * Notes:
 * - Upserts are performed in a single transaction.
 * - We intentionally avoid adding FKs in v1 per export inconsistencies.
 */
export async function upsertRedditData(
	db: BaseSQLiteDatabase<'sync' | 'async', Record<string, SQLiteTable>>,
	data: ParsedRedditExport,
): Promise<void> {
	const provider:
		| BaseSQLiteDatabase<'sync' | 'async', Record<string, SQLiteTable>>
		| { transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void> } =
		typeof (db as unknown as { transaction?: unknown }).transaction ===
		'function'
			? db
			: {
					transaction: async (fn: (tx: unknown) => Promise<void>) =>
						fn(db as unknown),
				};

	await provider.transaction(async (tx: unknown) => {
		// Parser already returns Date objects for timestamp fields. Use data as-is.
		const posts = data.posts ?? [];
		const post_headers = data.post_headers ?? [];
		const comments = data.comments ?? [];
		const comment_headers = data.comment_headers ?? [];
		const message_headers = data.message_headers ?? [];
		const messages = data.messages ?? [];
		const messages_archive_headers = data.messages_archive_headers ?? [];
		const messages_archive = data.messages_archive ?? [];
		const chat_history = data.chat_history ?? [];
		const birthdate = data.birthdate ?? [];
		const multireddits = data.multireddits ?? [];
		const purchases = data.purchases ?? [];
		const subscriptions = data.subscriptions ?? [];
		const payouts = data.payouts ?? [];
		const announcements = data.announcements ?? [];
		const drafts = data.drafts ?? [];
		const gilded_content = data.gilded_content ?? [];
		const gold_received = data.gold_received ?? [];
		const ip_logs = data.ip_logs ?? [];
		const scheduled_posts = data.scheduled_posts ?? [];
		// Core content
		if (posts?.length) {
			await upsertMany(tx, reddit_posts, posts, reddit_posts.id);
		}
		if (post_headers?.length) {
			await upsertMany(
				tx,
				reddit_post_headers,
				post_headers,
				reddit_post_headers.id,
			);
		}
		if (comments?.length) {
			await upsertMany(tx, reddit_comments, comments, reddit_comments.id);
		}
		if (comment_headers?.length) {
			await upsertMany(
				tx,
				reddit_comment_headers,
				comment_headers,
				reddit_comment_headers.id,
			);
		}

		// Votes / visibility / saves
		if (data.post_votes?.length) {
			// Use id as the conflict target to satisfy SQLite UNIQUE/PK requirements in v1
			await upsertMany(
				tx,
				reddit_post_votes,
				data.post_votes,
				reddit_post_votes.id,
			);
		}
		if (data.comment_votes?.length) {
			// Use id as the conflict target to satisfy SQLite UNIQUE/PK requirements in v1
			await upsertMany(
				tx,
				reddit_comment_votes,
				data.comment_votes,
				reddit_comment_votes.id,
			);
		}
		if (data.saved_posts?.length) {
			await upsertMany(
				tx,
				reddit_saved_posts,
				data.saved_posts,
				reddit_saved_posts.id,
			);
		}
		if (data.saved_comments?.length) {
			await upsertMany(
				tx,
				reddit_saved_comments,
				data.saved_comments,
				reddit_saved_comments.id,
			);
		}
		if (data.hidden_posts?.length) {
			await upsertMany(
				tx,
				reddit_hidden_posts,
				data.hidden_posts,
				reddit_hidden_posts.id,
			);
		}

		// Messaging
		if (message_headers?.length) {
			await upsertMany(
				tx,
				reddit_message_headers,
				message_headers,
				reddit_message_headers.id,
			);
		}
		if (messages?.length) {
			await upsertMany(tx, reddit_messages, messages, reddit_messages.id);
		}
		if (messages_archive_headers?.length) {
			await upsertMany(
				tx,
				reddit_messages_archive_headers,
				messages_archive_headers,
				reddit_messages_archive_headers.id,
			);
		}
		if (messages_archive?.length) {
			await upsertMany(
				tx,
				reddit_messages_archive,
				messages_archive,
				reddit_messages_archive.id,
			);
		}

		// Chat
		if (chat_history?.length) {
			await upsertMany(
				tx,
				reddit_chat_history,
				chat_history,
				reddit_chat_history.message_id,
			);
		}

		// Account & preferences
		if (data.account_gender?.length) {
			await upsertMany(
				tx,
				reddit_account_gender,
				data.account_gender,
				reddit_account_gender.id, // Single-row sentinel
			);
		}
		if (data.sensitive_ads_preferences?.length) {
			await upsertMany(
				tx,
				reddit_sensitive_ads_preferences,
				data.sensitive_ads_preferences,
				reddit_sensitive_ads_preferences.type,
			);
		}
		if (birthdate?.length) {
			// Single-row table; use sentinel primary key
			await upsertMany(tx, reddit_birthdate, birthdate, reddit_birthdate.id);
		}
		if (data.user_preferences?.length) {
			await upsertMany(
				tx,
				reddit_user_preferences,
				data.user_preferences,
				reddit_user_preferences.preference,
			);
		}
		if (data.linked_identities?.length) {
			await upsertMany(tx, reddit_linked_identities, data.linked_identities, [
				reddit_linked_identities.issuer_id,
				reddit_linked_identities.subject_id,
			]);
		}
		if (data.linked_phone_number?.length) {
			await upsertMany(
				tx,
				reddit_linked_phone_number,
				data.linked_phone_number,
				reddit_linked_phone_number.phone_number,
			);
		}
		if (data.twitter?.length) {
			await upsertMany(
				tx,
				reddit_twitter,
				data.twitter,
				reddit_twitter.username,
			);
		}

		// Moderation & subs
		if (data.approved_submitter_subreddits?.length) {
			await upsertMany(
				tx,
				reddit_approved_submitter_subreddits,
				data.approved_submitter_subreddits,
				reddit_approved_submitter_subreddits.subreddit,
			);
		}
		if (data.moderated_subreddits?.length) {
			await upsertMany(
				tx,
				reddit_moderated_subreddits,
				data.moderated_subreddits,
				reddit_moderated_subreddits.subreddit,
			);
		}
		if (data.subscribed_subreddits?.length) {
			await upsertMany(
				tx,
				reddit_subscribed_subreddits,
				data.subscribed_subreddits,
				reddit_subscribed_subreddits.subreddit,
			);
		}
		if (multireddits?.length) {
			await upsertMany(
				tx,
				reddit_multireddits,
				multireddits,
				reddit_multireddits.id,
			);
		}

		// Commerce & payouts
		if (purchases?.length) {
			await upsertMany(
				tx,
				reddit_purchases,
				purchases,
				reddit_purchases.transaction_id,
			);
		}
		if (subscriptions?.length) {
			await upsertMany(
				tx,
				reddit_subscriptions,
				subscriptions,
				reddit_subscriptions.subscription_id,
			);
		}
		if (payouts?.length) {
			await upsertMany(tx, reddit_payouts, payouts, [
				reddit_payouts.payout_id,
				reddit_payouts.date,
			]);
		}
		if (data.stripe?.length) {
			await upsertMany(
				tx,
				reddit_stripe,
				data.stripe,
				reddit_stripe.stripe_account_id,
			);
		}

		// Misc
		if (announcements?.length) {
			await upsertMany(
				tx,
				reddit_announcements,
				announcements,
				reddit_announcements.announcement_id,
			);
		}
		if (drafts?.length) {
			await upsertMany(tx, reddit_drafts, drafts, reddit_drafts.id);
		}
		if (data.friends?.length) {
			await upsertMany(
				tx,
				reddit_friends,
				data.friends,
				reddit_friends.username,
			);
		}
		if (gilded_content?.length) {
			await upsertMany(tx, reddit_gilded_content, gilded_content, [
				reddit_gilded_content.content_link,
				reddit_gilded_content.award,
				reddit_gilded_content.date,
			]);
		}
		if (gold_received?.length) {
			await upsertMany(tx, reddit_gold_received, gold_received, [
				reddit_gold_received.content_link,
				reddit_gold_received.date,
			]);
		}
		if (ip_logs?.length) {
			await upsertMany(tx, reddit_ip_logs, ip_logs, [
				reddit_ip_logs.date,
				reddit_ip_logs.ip,
			]);
		}
		if (data.persona?.length) {
			await upsertMany(
				tx,
				reddit_persona,
				data.persona,
				reddit_persona.persona_inquiry_id,
			);
		}
		if (data.poll_votes?.length) {
			await upsertMany(tx, reddit_poll_votes, data.poll_votes, [
				reddit_poll_votes.post_id,
				reddit_poll_votes.user_selection,
			]);
		}
		if (scheduled_posts?.length) {
			await upsertMany(
				tx,
				reddit_scheduled_posts,
				scheduled_posts,
				reddit_scheduled_posts.scheduled_post_id,
			);
		}
		if (data.statistics?.length) {
			await upsertMany(
				tx,
				reddit_statistics,
				data.statistics,
				reddit_statistics.statistic,
			);
		}
		if (data.checkfile?.length) {
			await upsertMany(
				tx,
				reddit_checkfile,
				data.checkfile,
				reddit_checkfile.filename,
			);
		}
	});
}
