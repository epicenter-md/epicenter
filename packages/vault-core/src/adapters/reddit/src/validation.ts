import { type } from 'arktype';

const date = type('string.date.parse');
const dateOpt = type('string')
	.pipe((v) => (v === '' ? undefined : v))
	.to('string.date.parse | undefined');
const registrationDate = type('string')
	.pipe((v) => (v === 'registration ip' ? undefined : v))
	.to('string.date.parse | undefined');

// ArkType parse schema
// explicit object-array schemas for all other datasets to avoid 'unknown'.
export const parseSchema = type({
	// Core content
	posts: type({
		id: 'string',
		permalink: 'string',
		date: date,
		created_utc: date,
		ip: 'string.ip',
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		title: 'string | undefined',
		url: 'string | undefined',
		body: 'string | undefined',
	}).array(),
	post_headers: type({
		id: 'string',
		permalink: 'string',
		date: date,
		ip: 'string.ip',
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		url: 'string | undefined',
	}).array(),
	comments: type({
		id: 'string',
		permalink: 'string',
		date: date,
		ip: 'string.ip',
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		link: 'string.url',
		parent: 'string | undefined',
		body: 'string | undefined',
		media: 'string | undefined',
	}).array(),
	comment_headers: type({
		id: 'string',
		permalink: 'string',
		date: date,
		ip: 'string.ip',
		subreddit: 'string',
		gildings: 'string.numeric.parse',
		link: 'string',
		parent: 'string | undefined',
	}).array(),

	// Votes / visibility / saves
	post_votes: type({
		id: 'string',
		permalink: 'string',
		direction: 'string',
	}).array(),
	comment_votes: type({
		id: 'string',
		permalink: 'string',
		direction: 'string',
	}).array(),
	saved_posts: type({
		id: 'string',
		permalink: 'string',
	}).array(),
	saved_comments: type({
		id: 'string',
		permalink: 'string',
	}).array(),
	hidden_posts: type({
		id: 'string',
		permalink: 'string',
	}).array(),

	// Messaging
	message_headers: type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | undefined',
		date: dateOpt,
		ip: 'string.ip',
		from: 'string | undefined',
		to: 'string | undefined',
	}).array(),
	messages: type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | undefined',
		date: dateOpt,
		ip: 'string.ip',
		from: 'string | undefined',
		to: 'string | undefined',
		subject: 'string | undefined',
		body: 'string | undefined',
	}).array(),
	messages_archive_headers: type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | undefined',
		date: dateOpt,
		ip: 'string.ip',
		from: 'string | undefined',
		to: 'string | undefined',
	}).array(),
	messages_archive: type({
		id: 'string',
		permalink: 'string',
		thread_id: 'string | undefined',
		date: dateOpt,
		ip: 'string.ip',
		from: 'string | undefined',
		to: 'string | undefined',
		subject: 'string | undefined',
		body: 'string | undefined',
	}).array(),

	// Chat
	chat_history: type({
		message_id: 'string',
		created_at: dateOpt,
		updated_at: dateOpt,
		username: 'string | undefined',
		message: 'string | undefined',
		thread_parent_message_id: 'string | undefined',
		channel_url: 'string | undefined',
		subreddit: 'string | undefined',
		channel_name: 'string | undefined',
		conversation_type: 'string | undefined',
	}).array(),

	// Account and preferences
	account_gender: type({
		account_gender: 'string | undefined',
	}).array(),
	sensitive_ads_preferences: type({
		type: 'string',
		preference: 'string | undefined',
	}).array(),
	birthdate: type({
		birthdate: dateOpt,
		verified_birthdate: dateOpt,
		verification_state: 'string | undefined',
		verification_method: 'string | undefined',
	}).array(),
	user_preferences: type({
		preference: 'string',
		value: 'string | undefined',
	}).array(),
	linked_identities: type({
		issuer_id: 'string',
		subject_id: 'string',
	}).array(),
	linked_phone_number: type({ phone_number: 'string' }).array(),
	twitter: type({ username: 'string' }).array(),

	// Moderation / subscriptions / subreddits
	approved_submitter_subreddits: type({
		subreddit: 'string',
	}).array(),
	moderated_subreddits: type({ subreddit: 'string' }).array(),
	subscribed_subreddits: type({ subreddit: 'string' }).array(),
	multireddits: type({
		id: 'string',
		display_name: 'string | undefined',
		date: dateOpt,
		description: 'string | undefined',
		privacy: 'string | undefined',
		subreddits: 'string | undefined',
		image_url: 'string | undefined',
		is_owner: 'string | undefined',
		favorited: 'string | undefined',
		followers: 'string | undefined',
	}).array(),

	// Commerce and payouts
	purchases: type({
		processor: 'string | undefined',
		transaction_id: 'string',
		product: 'string | undefined',
		date: dateOpt,
		cost: 'string | undefined',
		currency: 'string | undefined',
		status: 'string | undefined',
	}).array(),
	subscriptions: type({
		processor: 'string | undefined',
		subscription_id: 'string',
		product: 'string | undefined',
		product_id: 'string | undefined',
		product_name: 'string | undefined',
		status: 'string | undefined',
		start_date: dateOpt,
		end_date: dateOpt,
	}).array(),
	payouts: type({
		payout_amount_usd: 'string | undefined',
		date: date,
		payout_id: 'string | undefined',
	}).array(),
	stripe: type({ stripe_account_id: 'string' }).array(),

	// Misc
	announcements: type({
		announcement_id: 'string',
		sent_at: dateOpt,
		read_at: dateOpt,
		from_id: 'string | undefined',
		from_username: 'string | undefined',
		subject: 'string | undefined',
		body: 'string | undefined',
		url: 'string | undefined',
	}).array(),
	drafts: type({
		id: 'string',
		title: 'string | undefined',
		body: 'string | undefined',
		kind: 'string | undefined',
		created: dateOpt,
		spoiler: 'string | undefined',
		nsfw: 'string | undefined',
		original_content: 'string | undefined',
		content_category: 'string | undefined',
		flair_id: 'string | undefined',
		flair_text: 'string | undefined',
		send_replies: 'string | undefined',
		subreddit: 'string | undefined',
		is_public_link: 'string | undefined',
	}).array(),
	friends: type({
		username: 'string',
		note: 'string | undefined',
	}).array(),
	gilded_content: type({
		content_link: 'string',
		award: 'string | undefined',
		amount: 'string | undefined',
		date: dateOpt,
	}).array(),
	gold_received: type({
		content_link: 'string',
		gold_received: 'string | undefined',
		gilder_username: 'string | undefined',
		date: dateOpt,
	}).array(),
	ip_logs: type({ date: registrationDate, ip: 'string.ip' }).array(),
	persona: type({ persona_inquiry_id: 'string' }).array(),
	poll_votes: type({
		post_id: 'string',
		user_selection: 'string | undefined',
		text: 'string | undefined',
		image_url: 'string | undefined',
		is_prediction: 'string | undefined',
		stake_amount: 'string | undefined',
	}).array(),
	scheduled_posts: type({
		scheduled_post_id: 'string',
		subreddit: 'string | undefined',
		title: 'string | undefined',
		body: 'string | undefined',
		url: 'string | undefined',
		submission_time: dateOpt,
		recurrence: 'string | undefined',
	}).array(),
	statistics: type({
		statistic: 'string',
		value: 'string | undefined',
	}).array(),
	checkfile: type({
		filename: 'string',
		sha256: 'string | undefined',
	}).array(),
});
