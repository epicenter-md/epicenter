/**
 * Reddit Workspace Definition
 *
 * Workspace definition with 1:1 CSV → table mapping for Reddit GDPR export data.
 * (Singleton/settings-like CSVs map to the KV store instead of tables.)
 * Uses TypeBox `field.*` schemas for type validation and inference.
 */

import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineKv,
	defineTable,
	nullable,
} from '@epicenter/workspace';
import { Type } from 'typebox';

export function createRedditImport() {
	// no persistence/sync/encryption: in-memory-only importer target
	return createWorkspace({
		id: 'epicenter-reddit',
		tables: {
			/** posts.csv */
			posts: defineTable({
				id: field.string(),
				permalink: nullable(field.string()),
				date: nullable(field.string()),
				subreddit: field.string(),
				gildings: field.number(),
				title: nullable(field.string()),
				url: nullable(field.string()),
				body: nullable(field.string()),
			}),

			/** comments.csv */
			comments: defineTable({
				id: field.string(), // Composite: `${targetType}:${targetId}`
				permalink: nullable(field.string()),
				date: nullable(field.string()),
				subreddit: field.string(),
				gildings: field.number(),
				link: field.string(),
				parent: nullable(field.string()),
				body: nullable(field.string()),
				media: nullable(field.string()),
			}),

			/** drafts.csv */
			drafts: defineTable({
				id: field.string(),
				title: nullable(field.string()),
				body: nullable(field.string()),
				kind: nullable(field.string()),
				created: nullable(field.string()),
				spoiler: nullable(field.string()),
				nsfw: nullable(field.string()),
				original_content: nullable(field.string()),
				content_category: nullable(field.string()),
				flair_id: nullable(field.string()),
				flair_text: nullable(field.string()),
				send_replies: nullable(field.string()),
				subreddit: nullable(field.string()),
				is_public_link: nullable(field.string()),
			}),

			/** post_votes.csv */
			postVotes: defineTable({
				id: field.string(),
				permalink: field.string(),
				direction: field.select(['up', 'down', 'none', 'removed']),
			}),

			/** comment_votes.csv */
			commentVotes: defineTable({
				id: field.string(),
				permalink: field.string(),
				direction: field.select(['up', 'down', 'none', 'removed']),
			}),

			/** poll_votes.csv */
			pollVotes: defineTable({
				id: field.string(), // Composite: `${post_id}|${user_selection ?? ''}|${text ?? ''}`
				post_id: field.string(),
				user_selection: nullable(field.string()),
				text: nullable(field.string()),
				image_url: nullable(field.string()),
				is_prediction: nullable(field.string()),
				stake_amount: nullable(field.string()),
			}),

			/** saved_posts.csv */
			savedPosts: defineTable({
				id: field.string(),
				permalink: field.string(),
			}),

			/** saved_comments.csv */
			savedComments: defineTable({
				id: field.string(),
				permalink: field.string(),
			}),

			/** hidden_posts.csv */
			hiddenPosts: defineTable({
				id: field.string(),
				permalink: field.string(),
			}),

			/** messages.csv (optional) */
			messages: defineTable({
				id: field.string(),
				permalink: field.string(),
				thread_id: nullable(field.string()),
				date: nullable(field.string()),
				from: nullable(field.string()),
				to: nullable(field.string()),
				subject: nullable(field.string()),
				body: nullable(field.string()),
			}),

			/** messages_archive.csv */
			messagesArchive: defineTable({
				id: field.string(),
				permalink: field.string(),
				thread_id: nullable(field.string()),
				date: nullable(field.string()),
				from: nullable(field.string()),
				to: nullable(field.string()),
				subject: nullable(field.string()),
				body: nullable(field.string()),
			}),

			/** chat_history.csv */
			chatHistory: defineTable({
				id: field.string(), // message_id from CSV
				created_at: nullable(field.string()),
				updated_at: nullable(field.string()),
				username: nullable(field.string()),
				message: nullable(field.string()),
				thread_parent_message_id: nullable(field.string()),
				channel_url: nullable(field.string()),
				subreddit: nullable(field.string()),
				channel_name: nullable(field.string()),
				conversation_type: nullable(field.string()),
			}),

			/** subscribed_subreddits.csv */
			subscribedSubreddits: defineTable({
				id: field.string(), // subreddit
				subreddit: field.string(),
			}),

			/** moderated_subreddits.csv */
			moderatedSubreddits: defineTable({
				id: field.string(), // subreddit
				subreddit: field.string(),
			}),

			/** approved_submitter_subreddits.csv */
			approvedSubmitterSubreddits: defineTable({
				id: field.string(), // subreddit
				subreddit: field.string(),
			}),

			/** multireddits.csv */
			multireddits: defineTable({
				id: field.string(),
				display_name: nullable(field.string()),
				date: nullable(field.string()),
				description: nullable(field.string()),
				privacy: nullable(field.string()),
				subreddits: nullable(field.string()), // Comma-separated list
				image_url: nullable(field.string()),
				is_owner: nullable(field.string()),
				favorited: nullable(field.string()),
				followers: nullable(field.string()),
			}),

			/** gilded_content.csv */
			gildedContent: defineTable({
				id: field.string(), // Composite: `${content_link}|${date ?? ''}|${award ?? ''}|${amount ?? ''}`
				content_link: field.string(),
				award: nullable(field.string()),
				amount: nullable(field.string()),
				date: nullable(field.string()),
			}),

			/** gold_received.csv */
			goldReceived: defineTable({
				id: field.string(), // Composite: `${content_link}|${date ?? ''}|${gold_received ?? ''}|${gilder_username ?? ''}`
				content_link: field.string(),
				gold_received: nullable(field.string()),
				gilder_username: nullable(field.string()),
				date: nullable(field.string()),
			}),

			/** purchases.csv */
			purchases: defineTable({
				id: field.string(), // transaction_id
				processor: nullable(field.string()),
				transaction_id: field.string(),
				product: nullable(field.string()),
				date: nullable(field.string()),
				cost: nullable(field.string()),
				currency: nullable(field.string()),
				status: nullable(field.string()),
			}),

			/** subscriptions.csv */
			subscriptions: defineTable({
				id: field.string(), // subscription_id
				processor: nullable(field.string()),
				subscription_id: field.string(),
				product: nullable(field.string()),
				product_id: nullable(field.string()),
				product_name: nullable(field.string()),
				status: nullable(field.string()),
				start_date: nullable(field.string()),
				end_date: nullable(field.string()),
			}),

			/** payouts.csv */
			payouts: defineTable({
				id: field.string(), // payout_id ?? date
				payout_amount_usd: nullable(field.string()),
				date: nullable(field.string()),
				payout_id: nullable(field.string()),
			}),

			/** friends.csv */
			friends: defineTable({
				id: field.string(), // username
				username: field.string(),
				note: nullable(field.string()),
			}),

			/** announcements.csv */
			announcements: defineTable({
				id: field.string(), // announcement_id from CSV
				announcement_id: field.string(),
				sent_at: nullable(field.string()),
				read_at: nullable(field.string()),
				from_id: nullable(field.string()),
				from_username: nullable(field.string()),
				subject: nullable(field.string()),
				body: nullable(field.string()),
				url: nullable(field.string()),
			}),

			/** scheduled_posts.csv */
			scheduledPosts: defineTable({
				id: field.string(), // scheduled_post_id from CSV
				scheduled_post_id: field.string(),
				subreddit: nullable(field.string()),
				title: nullable(field.string()),
				body: nullable(field.string()),
				url: nullable(field.string()),
				submission_time: nullable(field.string()),
				recurrence: nullable(field.string()),
			}),
		},
		kv: {
			// Singleton values from CSV files
			statistics: defineKv(
				field.json(
					Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
				),
				(): Record<string, string> | null => null,
			),
			preferences: defineKv(
				field.json(
					Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
				),
				(): Record<string, string> | null => null,
			),
		},
	});
}

export const redditImport = createRedditImport();

export type RedditImport = typeof redditImport;
