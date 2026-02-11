/**
 * Reddit Workspace Definition
 *
 * Static API workspace with 1:1 CSV → table mapping for Reddit GDPR export data.
 * (Singleton/settings-like CSVs map to the KV store instead of tables.)
 * Uses arktype schemas for type validation and inference.
 */

import { type } from 'arktype';
import { defineKv, defineTable, defineWorkspace } from '../../static/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * posts.csv
 */
const posts = defineTable(
	type({
		id: 'string',
		permalink: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		subreddit: 'string',
		gildings: 'number',
		'title?': 'string',
		'url?': 'string',
		'body?': 'string',
	}),
);

/**
 * comments.csv
 */
const comments = defineTable(
	type({
		id: 'string', // Composite: `${targetType}:${targetId}`
		permalink: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		subreddit: 'string',
		gildings: 'number',
		link: 'string',
		'parent?': 'string',
		'body?': 'string',
		'media?': 'string',
	}),
);

/**
 * drafts.csv
 */
const drafts = defineTable(
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
	}),
);

/**
 * post_votes.csv
 */
const postVotes = defineTable(
	type({
		id: 'string',
		permalink: 'string',
		direction: "'up' | 'down' | 'none' | 'removed'",
	}),
);

/**
 * comment_votes.csv
 */
const commentVotes = defineTable(
	type({
		id: 'string',
		permalink: 'string',
		direction: "'up' | 'down' | 'none' | 'removed'",
	}),
);

/**
 * poll_votes.csv
 */
const pollVotes = defineTable(
	type({
		id: 'string', // Composite: `${post_id}:${user_selection ?? ''}:${text ?? ''}`
		post_id: 'string',
		'user_selection?': 'string',
		'text?': 'string',
		'image_url?': 'string',
		'is_prediction?': 'string',
		'stake_amount?': 'string',
	}),
);

/**
 * saved_posts.csv
 */
const savedPosts = defineTable(
	type({
		id: 'string',
		permalink: 'string',
	}),
);

/**
 * saved_comments.csv
 */
const savedComments = defineTable(
	type({
		id: 'string',
		permalink: 'string',
	}),
);

/**
 * hidden_posts.csv
 */
const hiddenPosts = defineTable(
	type({
		id: 'string',
		permalink: 'string',
	}),
);

/**
 * messages.csv (optional)
 */
const messages = defineTable(
	type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	}),
);

/**
 * messages_archive.csv
 */
const messagesArchive = defineTable(
	type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | null',
		date: 'string | null',
		ip: 'string | null',
		'from?': 'string',
		'to?': 'string',
		'subject?': 'string',
		'body?': 'string',
	}),
);

/**
 * chat_history.csv
 */
const chatHistory = defineTable(
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
	}),
);

/**
 * subscribed_subreddits.csv
 */
const subscribedSubreddits = defineTable(
	type({
		id: 'string', // subreddit
		subreddit: 'string',
	}),
);

/**
 * moderated_subreddits.csv
 */
const moderatedSubreddits = defineTable(
	type({
		id: 'string', // subreddit
		subreddit: 'string',
	}),
);

/**
 * approved_submitter_subreddits.csv
 */
const approvedSubmitterSubreddits = defineTable(
	type({
		id: 'string', // subreddit
		subreddit: 'string',
	}),
);

/**
 * multireddits.csv
 */
const multireddits = defineTable(
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
	}),
);

/**
 * gilded_content.csv
 */
const gildedContent = defineTable(
	type({
		id: 'string', // Composite: `${content_link}:${date ?? ''}:${award ?? ''}:${amount ?? ''}`
		content_link: 'string',
		'award?': 'string',
		'amount?': 'string',
		date: 'string | null',
	}),
);

/**
 * gold_received.csv
 */
const goldReceived = defineTable(
	type({
		id: 'string', // Composite: `${content_link}:${date ?? ''}:${gold_received ?? ''}:${gilder_username ?? ''}`
		content_link: 'string',
		'gold_received?': 'string',
		'gilder_username?': 'string',
		date: 'string | null',
	}),
);

/**
 * purchases.csv
 */
const purchases = defineTable(
	type({
		id: 'string', // transaction_id
		'processor?': 'string',
		transaction_id: 'string',
		'product?': 'string',
		date: 'string | null',
		'cost?': 'string',
		'currency?': 'string',
		'status?': 'string',
	}),
);

/**
 * subscriptions.csv
 */
const subscriptions = defineTable(
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
	}),
);

/**
 * payouts.csv
 */
const payouts = defineTable(
	type({
		id: 'string', // payout_id ?? date
		'payout_amount_usd?': 'string',
		date: 'string | null',
		'payout_id?': 'string',
	}),
);

/**
 * friends.csv
 */
const friends = defineTable(
	type({
		id: 'string', // username
		username: 'string',
		'note?': 'string',
	}),
);

/**
 * linked_identities.csv
 */
const linkedIdentities = defineTable(
	type({
		id: 'string', // `${issuer_id}:${subject_id}`
		issuer_id: 'string',
		subject_id: 'string',
	}),
);

/**
 * announcements.csv
 */
const announcements = defineTable(
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
	}),
);

/**
 * scheduled_posts.csv
 */
const scheduledPosts = defineTable(
	type({
		id: 'string', // scheduled_post_id from CSV
		scheduled_post_id: 'string',
		'subreddit?': 'string',
		'title?': 'string',
		'body?': 'string',
		'url?': 'string',
		submission_time: 'string | null',
		'recurrence?': 'string',
	}),
);

/**
 * ip_logs.csv
 */
const ipLogs = defineTable(
	type({
		id: 'string', // `${date}:${ip}`
		date: 'string',
		ip: 'string',
	}),
);

/**
 * sensitive_ads_preferences.csv
 */
const sensitiveAdsPreferences = defineTable(
	type({
		id: 'string', // type field as ID
		type: 'string',
		'preference?': 'string',
	}),
);

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export const redditWorkspace = defineWorkspace({
	id: 'reddit',

	tables: {
		posts,
		comments,
		drafts,
		postVotes,
		commentVotes,
		pollVotes,
		savedPosts,
		savedComments,
		hiddenPosts,
		messages,
		messagesArchive,
		chatHistory,
		subscribedSubreddits,
		moderatedSubreddits,
		approvedSubmitterSubreddits,
		multireddits,
		gildedContent,
		goldReceived,
		purchases,
		subscriptions,
		payouts,
		friends,
		linkedIdentities,
		announcements,
		scheduledPosts,
		ipLogs,
		sensitiveAdsPreferences,
	},

	kv: {
		// Singleton values from CSV files
		accountGender: defineKv(type('string | null')),
		birthdate: defineKv(type('string | null')),
		verifiedBirthdate: defineKv(type('string | null')),
		phoneNumber: defineKv(type('string | null')),
		stripeAccountId: defineKv(type('string | null')),
		personaInquiryId: defineKv(type('string | null')),
		twitterUsername: defineKv(type('string | null')),
		// Key-value pairs stored as JSON
		statistics: defineKv(type('Record<string, string> | null')),
		preferences: defineKv(type('Record<string, string> | null')),
	},
});

export type RedditWorkspace = typeof redditWorkspace;
