import {
	date,
	defineWorkspace,
	id,
	markdownIndex,
	select,
	sqliteIndex,
	text,
} from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers';

const NICHES = [
	'personal',
	'epicenter',
	'y-combinator',
	'yale',
	'college-students',
	'high-school-students',
	'coding',
	'productivity',
	'ethics',
	'writing',
] as const;

/**
 * Schema for short-form video content (YouTube, Instagram, TikTok)
 * References wiki.entries via entry_id for source of truth.
 */
const SHORT_FORM_VIDEO_SCHEMA = {
	id: id(),
	entry_id: text(),
	title: text(),
	description: text(),
	niche: select({ options: NICHES }),
	posted_at: date(),
	updated_at: date(),
} as const;

/**
 * Schema for long-form text content (Medium, Substack, Personal Blog, Epicenter Blog)
 * References wiki.entries via entry_id for source of truth.
 */
const LONG_FORM_TEXT_SCHEMA = {
	id: id(),
	entry_id: text(),
	title: text(),
	subtitle: text(),
	content: text(),
	niche: select({ options: NICHES }),
	posted_at: date(),
	updated_at: date(),
} as const;

/**
 * Schema for short-form text content (Reddit, Twitter, Hacker News, Discord, Product Hunt, Bookface)
 * References wiki.entries via entry_id for source of truth.
 */
const SHORT_FORM_TEXT_SCHEMA = {
	id: id(),
	entry_id: text(),
	content: text(),
	title: text({ nullable: true }),
	niche: select({ options: NICHES }),
	posted_at: date(),
	updated_at: date(),
} as const;

/**
 * Posts workspace
 *
 * Distribution layer for social media content across platforms.
 * All posts reference wiki.entries via entry_id for source of truth.
 *
 * Content flow: wiki.entries (source) → posts.* (distribution)
 *
 * Organizes content by platform type:
 * - Video: youtube, tiktok, instagram
 * - Blogs: medium, substack, personal_blog, epicenter_blog
 * - Social: reddit, twitter, discord, hackernews, producthunt, bookface
 */
export const posts = defineWorkspace({
	id: 'posts',

	schema: {
		// Video platforms
		youtube: SHORT_FORM_VIDEO_SCHEMA,
		tiktok: SHORT_FORM_VIDEO_SCHEMA,
		instagram: SHORT_FORM_VIDEO_SCHEMA,

		// Blog platforms
		medium: LONG_FORM_TEXT_SCHEMA,
		substack: LONG_FORM_TEXT_SCHEMA,
		personal_blog: LONG_FORM_TEXT_SCHEMA,
		epicenter_blog: LONG_FORM_TEXT_SCHEMA,

		// Social platforms
		reddit: SHORT_FORM_TEXT_SCHEMA,
		twitter: SHORT_FORM_TEXT_SCHEMA,
		discord: SHORT_FORM_TEXT_SCHEMA,
		hackernews: SHORT_FORM_TEXT_SCHEMA,
		producthunt: SHORT_FORM_TEXT_SCHEMA,
		bookface: SHORT_FORM_TEXT_SCHEMA,
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) => markdownIndex(c),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,
	}),
});
