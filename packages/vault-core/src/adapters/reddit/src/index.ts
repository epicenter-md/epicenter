import { defineAdapter } from '@repo/vault-core';
import { type } from 'arktype';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import drizzleConfig from './drizzle.config';
import { metadata } from './metadata';
import { parseRedditExport } from './parse';
import * as tables from './schema';
import { upsertRedditData } from './upsert';

// Expose all tables from schema module (runtime values only; TS types are erased)
export const schema = tables as unknown as Record<string, SQLiteTable>;

// ArkType parse schema
// Tight validation for posts and comments (parsed today),
// explicit object-array schemas for all other datasets to avoid 'unknown'.
export const parseSchema = type({
	// Core content
	posts: [
		{
			id: 'string',
			permalink: 'string',
			date: 'Date',
			created_utc: 'Date',
			ip: 'string | undefined',
			subreddit: 'string',
			gildings: 'number | undefined',
			title: 'string | undefined',
			url: 'string | undefined',
			body: 'string | undefined',
		},
	],
	post_headers: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			subreddit: 'string | undefined',
			gildings: 'number | undefined',
			url: 'string | undefined',
		},
	],
	comments: [
		{
			id: 'string',
			permalink: 'string',
			date: 'Date',
			created_utc: 'Date',
			ip: 'string | undefined',
			subreddit: 'string',
			gildings: 'number | undefined',
			link: 'string',
			post_id: 'string | undefined',
			parent: 'string | undefined',
			body: 'string | undefined',
			media: 'string | undefined',
		},
	],
	comment_headers: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			subreddit: 'string | undefined',
			gildings: 'number | undefined',
			link: 'string | undefined',
			parent: 'string | undefined',
		},
	],

	// Votes / visibility / saves
	post_votes: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			direction: 'string | undefined',
		},
	],
	comment_votes: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			direction: 'string | undefined',
		},
	],
	saved_posts: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
		},
	],
	saved_comments: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
		},
	],
	hidden_posts: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
		},
	],

	// Messaging
	message_headers: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			thread_id: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			from: 'string | undefined',
			to: 'string | undefined',
		},
	],
	messages: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			thread_id: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			from: 'string | undefined',
			to: 'string | undefined',
			subject: 'string | undefined',
			body: 'string | undefined',
		},
	],
	messages_archive_headers: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			thread_id: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			from: 'string | undefined',
			to: 'string | undefined',
		},
	],
	messages_archive: [
		{
			id: 'string | undefined',
			permalink: 'string | undefined',
			thread_id: 'string | undefined',
			date: 'Date | undefined',
			ip: 'string | undefined',
			from: 'string | undefined',
			to: 'string | undefined',
			subject: 'string | undefined',
			body: 'string | undefined',
		},
	],

	// Chat
	chat_history: [
		{
			message_id: 'string | undefined',
			created_at: 'Date | undefined',
			updated_at: 'Date | undefined',
			username: 'string | undefined',
			message: 'string | undefined',
			thread_parent_message_id: 'string | undefined',
			channel_url: 'string | undefined',
			subreddit: 'string | undefined',
			channel_name: 'string | undefined',
			conversation_type: 'string | undefined',
		},
	],

	// Account and preferences
	account_gender: [{ account_gender: 'string | undefined' }],
	sensitive_ads_preferences: [
		{ type: 'string | undefined', preference: 'string | undefined' },
	],
	birthdate: [
		{
			birthdate: 'Date | undefined',
			verified_birthdate: 'Date | undefined',
			verification_state: 'string | undefined',
			verification_method: 'string | undefined',
		},
	],
	user_preferences: [
		{ preference: 'string | undefined', value: 'string | undefined' },
	],
	linked_identities: [
		{ issuer_id: 'string | undefined', subject_id: 'string | undefined' },
	],
	linked_phone_number: [{ phone_number: 'string | undefined' }],
	twitter: [{ username: 'string | undefined' }],

	// Moderation / subscriptions / subreddits
	approved_submitter_subreddits: [{ subreddit: 'string | undefined' }],
	moderated_subreddits: [{ subreddit: 'string | undefined' }],
	subscribed_subreddits: [{ subreddit: 'string | undefined' }],
	multireddits: [
		{
			id: 'string | undefined',
			display_name: 'string | undefined',
			date: 'Date | undefined',
			description: 'string | undefined',
			privacy: 'string | undefined',
			subreddits: 'string | undefined',
			image_url: 'string | undefined',
			is_owner: 'string | undefined',
			favorited: 'string | undefined',
			followers: 'string | undefined',
		},
	],

	// Commerce and payouts
	purchases: [
		{
			processor: 'string | undefined',
			transaction_id: 'string | undefined',
			product: 'string | undefined',
			date: 'Date | undefined',
			cost: 'string | undefined',
			currency: 'string | undefined',
			status: 'string | undefined',
		},
	],
	subscriptions: [
		{
			processor: 'string | undefined',
			subscription_id: 'string | undefined',
			product: 'string | undefined',
			product_id: 'string | undefined',
			product_name: 'string | undefined',
			status: 'string | undefined',
			start_date: 'Date | undefined',
			end_date: 'Date | undefined',
		},
	],
	payouts: [
		{
			payout_amount_usd: 'string | undefined',
			date: 'Date | undefined',
			payout_id: 'string | undefined',
		},
	],
	stripe: [{ stripe_account_id: 'string | undefined' }],

	// Misc
	announcements: [
		{
			announcement_id: 'string | undefined',
			sent_at: 'Date | undefined',
			read_at: 'Date | undefined',
			from_id: 'string | undefined',
			from_username: 'string | undefined',
			subject: 'string | undefined',
			body: 'string | undefined',
			url: 'string | undefined',
		},
	],
	drafts: [
		{
			id: 'string | undefined',
			title: 'string | undefined',
			body: 'string | undefined',
			kind: 'string | undefined',
			created: 'Date | undefined',
			spoiler: 'string | undefined',
			nsfw: 'string | undefined',
			original_content: 'string | undefined',
			content_category: 'string | undefined',
			flair_id: 'string | undefined',
			flair_text: 'string | undefined',
			send_replies: 'string | undefined',
			subreddit: 'string | undefined',
			is_public_link: 'string | undefined',
		},
	],
	friends: [{ username: 'string | undefined', note: 'string | undefined' }],
	gilded_content: [
		{
			content_link: 'string | undefined',
			award: 'string | undefined',
			amount: 'string | undefined',
			date: 'Date | undefined',
		},
	],
	gold_received: [
		{
			content_link: 'string | undefined',
			gold_received: 'string | undefined',
			gilder_username: 'string | undefined',
			date: 'Date | undefined',
		},
	],
	ip_logs: [{ date: 'Date | undefined', ip: 'string | undefined' }],
	persona: [{ persona_inquiry_id: 'string | undefined' }],
	poll_votes: [
		{
			post_id: 'string | undefined',
			user_selection: 'string | undefined',
			text: 'string | undefined',
			image_url: 'string | undefined',
			is_prediction: 'string | undefined',
			stake_amount: 'string | undefined',
		},
	],
	scheduled_posts: [
		{
			scheduled_post_id: 'string | undefined',
			subreddit: 'string | undefined',
			title: 'string | undefined',
			body: 'string | undefined',
			url: 'string | undefined',
			submission_time: 'Date | undefined',
			recurrence: 'string | undefined',
		},
	],
	statistics: [
		{ statistic: 'string | undefined', value: 'string | undefined' },
	],
	checkfile: [{ filename: 'string | undefined', sha256: 'string | undefined' }],
});

// ArkType infers array schemas like `[ { ... } ]` as a tuple type with one element.
// Convert any such tuple properties into standard `T[]` arrays for our parser/upsert.
type Arrayify<T> = T extends readonly [infer E] ? E[] : T;
type Inferred = (typeof parseSchema)['infer'];
export type ParsedRedditExport = {
	[K in keyof Inferred]: Arrayify<Inferred[K]>;
};
// Back-compat for consumers still importing ParseResult from this module
export type ParseResult = ParsedRedditExport;

// Adapter export
export const redditAdapter = defineAdapter({
	name: 'Reddit Adapter',
	schema,
	metadata,
	parseSchema,
	drizzleConfig,
	parse: parseRedditExport,
	upsert: upsertRedditData,
});
