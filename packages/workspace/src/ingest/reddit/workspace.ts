/**
 * Reddit Workspace Definition
 *
 * Workspace definition with 1:1 CSV → table mapping for Reddit GDPR export data.
 * (Singleton/settings-like CSVs map to the KV store instead of tables.)
 * Uses arktype schemas for type validation and inference.
 */

import { type } from 'arktype';
import {
	defineKv,
	defineTable,
	defineWorkspace,
} from '../../workspace/index.js';

export const redditWorkspace = defineWorkspace({
	id: 'reddit',

	tables: {
		/** posts.csv */
		posts: defineTable(
			type({
				id: 'string',
				permalink: 'string | null',
				date: 'string | null',
				subreddit: 'string',
				gildings: 'number',
				'title?': 'string',
				'url?': 'string',
				'body?': 'string',
				_v: '1',
			}),
		),

		/** comments.csv */
		comments: defineTable(
			type({
				id: 'string', // Composite: `${targetType}:${targetId}`
				permalink: 'string | null',
				date: 'string | null',
				subreddit: 'string',
				gildings: 'number',
				link: 'string',
				'parent?': 'string',
				'body?': 'string',
				'media?': 'string',
				_v: '1',
			}),
		),

		/** drafts.csv */
		drafts: defineTable(
			type({
				id: 'string',
				'title?': 'string',
				'body?': 'string',
				'kind?': 'string',
				created: 'string | null',
				'spoiler?': 'string',
				'nsfw?': 'string',
				'original_content?': 'string',
				'content_category?': 'string',
				'flair_id?': 'string',
				'flair_text?': 'string',
				'send_replies?': 'string',
				'subreddit?': 'string',
				'is_public_link?': 'string',
				_v: '1',
			}),
		),

		/** post_votes.csv */
		postVotes: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				direction: "'up' | 'down' | 'none' | 'removed'",
				_v: '1',
			}),
		),

		/** comment_votes.csv */
		commentVotes: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				direction: "'up' | 'down' | 'none' | 'removed'",
				_v: '1',
			}),
		),

		/** poll_votes.csv */
		pollVotes: defineTable(
			type({
				id: 'string', // Composite: `${post_id}|${user_selection ?? ''}|${text ?? ''}`
				post_id: 'string',
				'user_selection?': 'string',
				'text?': 'string',
				'image_url?': 'string',
				'is_prediction?': 'string',
				'stake_amount?': 'string',
				_v: '1',
			}),
		),

		/** saved_posts.csv */
		savedPosts: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				_v: '1',
			}),
		),

		/** saved_comments.csv */
		savedComments: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				_v: '1',
			}),
		),

		/** hidden_posts.csv */
		hiddenPosts: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				_v: '1',
			}),
		),

		/** messages.csv (optional) */
		messages: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				thread_id: 'string | null',
				date: 'string | null',
				'from?': 'string',
				'to?': 'string',
				'subject?': 'string',
				'body?': 'string',
				_v: '1',
			}),
		),

		/** messages_archive.csv */
		messagesArchive: defineTable(
			type({
				id: 'string',
				permalink: 'string',
				thread_id: 'string | null',
				date: 'string | null',
				'from?': 'string',
				'to?': 'string',
				'subject?': 'string',
				'body?': 'string',
				_v: '1',
			}),
		),

		/** chat_history.csv */
		chatHistory: defineTable(
			type({
				id: 'string', // message_id from CSV
				created_at: 'string | null',
				updated_at: 'string | null',
				username: 'string | null',
				message: 'string | null',
				thread_parent_message_id: 'string | null',
				channel_url: 'string | null',
				subreddit: 'string | null',
				channel_name: 'string | null',
				conversation_type: 'string | null',
				_v: '1',
			}),
		),

		/** subscribed_subreddits.csv */
		subscribedSubreddits: defineTable(
			type({
				id: 'string', // subreddit
				subreddit: 'string',
				_v: '1',
			}),
		),

		/** moderated_subreddits.csv */
		moderatedSubreddits: defineTable(
			type({
				id: 'string', // subreddit
				subreddit: 'string',
				_v: '1',
			}),
		),

		/** approved_submitter_subreddits.csv */
		approvedSubmitterSubreddits: defineTable(
			type({
				id: 'string', // subreddit
				subreddit: 'string',
				_v: '1',
			}),
		),

		/** multireddits.csv */
		multireddits: defineTable(
			type({
				id: 'string',
				'display_name?': 'string',
				date: 'string | null',
				'description?': 'string',
				'privacy?': 'string',
				'subreddits?': 'string', // Comma-separated list
				'image_url?': 'string',
				'is_owner?': 'string',
				'favorited?': 'string',
				'followers?': 'string',
				_v: '1',
			}),
		),

		/** gilded_content.csv */
		gildedContent: defineTable(
			type({
				id: 'string', // Composite: `${content_link}|${date ?? ''}|${award ?? ''}|${amount ?? ''}`
				content_link: 'string',
				'award?': 'string',
				'amount?': 'string',
				date: 'string | null',
				_v: '1',
			}),
		),

		/** gold_received.csv */
		goldReceived: defineTable(
			type({
				id: 'string', // Composite: `${content_link}|${date ?? ''}|${gold_received ?? ''}|${gilder_username ?? ''}`
				content_link: 'string',
				'gold_received?': 'string',
				'gilder_username?': 'string',
				date: 'string | null',
				_v: '1',
			}),
		),

		/** purchases.csv */
		purchases: defineTable(
			type({
				id: 'string', // transaction_id
				'processor?': 'string',
				transaction_id: 'string',
				'product?': 'string',
				date: 'string | null',
				'cost?': 'string',
				'currency?': 'string',
				'status?': 'string',
				_v: '1',
			}),
		),

		/** subscriptions.csv */
		subscriptions: defineTable(
			type({
				id: 'string', // subscription_id
				'processor?': 'string',
				subscription_id: 'string',
				'product?': 'string',
				'product_id?': 'string',
				'product_name?': 'string',
				'status?': 'string',
				start_date: 'string | null',
				end_date: 'string | null',
				_v: '1',
			}),
		),

		/** payouts.csv */
		payouts: defineTable(
			type({
				id: 'string', // payout_id ?? date
				'payout_amount_usd?': 'string',
				date: 'string | null',
				'payout_id?': 'string',
				_v: '1',
			}),
		),

		/** friends.csv */
		friends: defineTable(
			type({
				id: 'string', // username
				username: 'string',
				'note?': 'string',
				_v: '1',
			}),
		),

		/** announcements.csv */
		announcements: defineTable(
			type({
				id: 'string', // announcement_id from CSV
				announcement_id: 'string',
				sent_at: 'string | null',
				read_at: 'string | null',
				from_id: 'string | null',
				from_username: 'string | null',
				subject: 'string | null',
				body: 'string | null',
				url: 'string | null',
				_v: '1',
			}),
		),

		/** scheduled_posts.csv */
		scheduledPosts: defineTable(
			type({
				id: 'string', // scheduled_post_id from CSV
				scheduled_post_id: 'string',
				'subreddit?': 'string',
				'title?': 'string',
				'body?': 'string',
				'url?': 'string',
				submission_time: 'string | null',
				'recurrence?': 'string',
				_v: '1',
			}),
		),
	},

	kv: {
		// Singleton values from CSV files
		statistics: defineKv(type('Record<string, string> | null'), null),
		preferences: defineKv(type('Record<string, string> | null'), null),
	},
});

export type RedditWorkspace = typeof redditWorkspace;
