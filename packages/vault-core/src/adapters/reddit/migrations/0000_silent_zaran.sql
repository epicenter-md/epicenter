CREATE TABLE `reddit_account_gender` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`account_gender` text
);
--> statement-breakpoint
CREATE TABLE `reddit_announcements` (
	`announcement_id` text PRIMARY KEY NOT NULL,
	`sent_at` integer,
	`read_at` integer,
	`from_id` text,
	`from_username` text,
	`subject` text,
	`body` text,
	`url` text
);
--> statement-breakpoint
CREATE TABLE `reddit_approved_submitter_subreddits` (
	`subreddit` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_birthdate` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`birthdate` integer,
	`verified_birthdate` integer,
	`verification_state` text,
	`verification_method` text
);
--> statement-breakpoint
CREATE TABLE `reddit_chat_history` (
	`message_id` text PRIMARY KEY NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`username` text,
	`message` text,
	`thread_parent_message_id` text,
	`channel_url` text,
	`subreddit` text,
	`channel_name` text,
	`conversation_type` text
);
--> statement-breakpoint
CREATE TABLE `reddit_checkfile` (
	`filename` text PRIMARY KEY NOT NULL,
	`sha256` text
);
--> statement-breakpoint
CREATE TABLE `reddit_comment_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`date` integer NOT NULL,
	`ip` text,
	`subreddit` text NOT NULL,
	`gildings` integer,
	`link` text NOT NULL,
	`parent` text
);
--> statement-breakpoint
CREATE TABLE `reddit_comment_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`direction` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`date` integer NOT NULL,
	`ip` text,
	`subreddit` text NOT NULL,
	`gildings` integer,
	`link` text NOT NULL,
	`parent` text,
	`body` text,
	`media` text
);
--> statement-breakpoint
CREATE TABLE `reddit_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`body` text,
	`kind` text,
	`created` integer,
	`spoiler` text,
	`nsfw` text,
	`original_content` text,
	`content_category` text,
	`flair_id` text,
	`flair_text` text,
	`send_replies` text,
	`subreddit` text,
	`is_public_link` text
);
--> statement-breakpoint
CREATE TABLE `reddit_friends` (
	`username` text PRIMARY KEY NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `reddit_gilded_content` (
	`content_link` text PRIMARY KEY NOT NULL,
	`award` text,
	`amount` text,
	`date` integer
);
--> statement-breakpoint
CREATE TABLE `reddit_gold_received` (
	`content_link` text PRIMARY KEY NOT NULL,
	`gold_received` text,
	`gilder_username` text,
	`date` integer
);
--> statement-breakpoint
CREATE TABLE `reddit_hidden_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_ip_logs` (
	`date` integer PRIMARY KEY NOT NULL,
	`ip` text
);
--> statement-breakpoint
CREATE TABLE `reddit_linked_identities` (
	`issuer_id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_linked_phone_number` (
	`phone_number` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_message_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`thread_id` text,
	`date` integer,
	`ip` text,
	`from` text,
	`to` text
);
--> statement-breakpoint
CREATE TABLE `reddit_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`thread_id` text,
	`date` integer,
	`ip` text,
	`from` text,
	`to` text,
	`subject` text,
	`body` text
);
--> statement-breakpoint
CREATE TABLE `reddit_messages_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`thread_id` text,
	`date` integer,
	`ip` text,
	`from` text,
	`to` text,
	`subject` text,
	`body` text
);
--> statement-breakpoint
CREATE TABLE `reddit_messages_archive_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`thread_id` text,
	`date` integer,
	`ip` text,
	`from` text,
	`to` text
);
--> statement-breakpoint
CREATE TABLE `reddit_moderated_subreddits` (
	`subreddit` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_multireddits` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`date` integer,
	`description` text,
	`privacy` text,
	`subreddits` text,
	`image_url` text,
	`is_owner` text,
	`favorited` text,
	`followers` text
);
--> statement-breakpoint
CREATE TABLE `reddit_payouts` (
	`payout_amount_usd` text,
	`date` integer PRIMARY KEY NOT NULL,
	`payout_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reddit_payouts_payout_date_uq` ON `reddit_payouts` (`payout_id`,`date`);--> statement-breakpoint
CREATE TABLE `reddit_persona` (
	`persona_inquiry_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_poll_votes` (
	`post_id` text PRIMARY KEY NOT NULL,
	`user_selection` text,
	`text` text,
	`image_url` text,
	`is_prediction` text,
	`stake_amount` text
);
--> statement-breakpoint
CREATE TABLE `reddit_post_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`date` integer NOT NULL,
	`ip` text,
	`subreddit` text NOT NULL,
	`gildings` integer,
	`url` text
);
--> statement-breakpoint
CREATE TABLE `reddit_post_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`direction` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL,
	`date` integer NOT NULL,
	`ip` text,
	`subreddit` text NOT NULL,
	`gildings` integer,
	`title` text,
	`url` text,
	`body` text
);
--> statement-breakpoint
CREATE TABLE `reddit_purchases` (
	`processor` text,
	`transaction_id` text PRIMARY KEY NOT NULL,
	`product` text,
	`date` integer,
	`cost` text,
	`currency` text,
	`status` text
);
--> statement-breakpoint
CREATE TABLE `reddit_saved_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_saved_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`permalink` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_scheduled_posts` (
	`scheduled_post_id` text PRIMARY KEY NOT NULL,
	`subreddit` text,
	`title` text,
	`body` text,
	`url` text,
	`submission_time` integer,
	`recurrence` text
);
--> statement-breakpoint
CREATE TABLE `reddit_sensitive_ads_preferences` (
	`type` text PRIMARY KEY NOT NULL,
	`preference` text
);
--> statement-breakpoint
CREATE TABLE `reddit_statistics` (
	`statistic` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `reddit_stripe` (
	`stripe_account_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_subscribed_subreddits` (
	`subreddit` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_subscriptions` (
	`processor` text,
	`subscription_id` text PRIMARY KEY NOT NULL,
	`product` text,
	`product_id` text,
	`product_name` text,
	`status` text,
	`start_date` integer,
	`end_date` integer
);
--> statement-breakpoint
CREATE TABLE `reddit_twitter` (
	`username` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reddit_user_preferences` (
	`preference` text PRIMARY KEY NOT NULL,
	`value` text
);
