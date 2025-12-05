import path from 'node:path';
import {
	DateWithTimezone,
	DateWithTimezoneFromString,
	date,
	defineWorkspace,
	id,
	markdownIndex,
	select,
	type SerializedRow,
	sqliteIndex,
	tags,
	text,
	withBodyField,
} from '@epicenter/hq';
import { QUALITY_OPTIONS } from '../shared/quality';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';

/**
 * Path to the blog's content collection for articles
 * This is where Astro expects content collection markdown files
 */
const BLOG_ARTICLES_PATH = '/Users/braden/Code/blog/src/content/articles';

/**
 * Wiki workspace
 *
 * Evergreen knowledge base entries that serve as the source of truth.
 * Unlike pages (which have a publishing lifecycle), wiki entries are
 * permanent reference documents that are continuously updated.
 *
 * Content flow:
 *   wiki.entries (source of truth) → posts.* (distribution)
 *
 * Two markdown indexes:
 *   1. `markdown` - local storage for all wiki content
 *   2. `blog` - syncs entries to Astro blog content collection
 *
 * Wiki entries can link to each other using standard markdown links.
 * Each entry represents your authoritative take on a topic.
 */
export const wiki = defineWorkspace({
	id: 'wiki',

	schema: {
		entries: {
			id: id(),
			title: text(),
			content: text(),
			type: tags({ nullable: true }),
			tags: tags({ nullable: true }),
			resonance: select({ options: QUALITY_OPTIONS, nullable: true }),
			created_at: date(),
			updated_at: date(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),

		/**
		 * Local markdown storage for wiki entries
		 */
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					entries: withBodyField('content'),
				},
			}),

		/**
		 * Blog content collection sync
		 *
		 * Syncs wiki entries to Astro's content collection format.
		 * Field names are kept consistent (no remapping).
		 * Dates are serialized as Date objects, timezone stored separately.
		 */
		blog: (c) =>
			markdownIndex(c, {
				directory: BLOG_ARTICLES_PATH,
				tableConfigs: {
					entries: {
						serialize: ({ row }) => {
							const {
								id: rowId,
								content,
								title,
								type,
								tags,
								resonance,
								created_at,
								updated_at,
							} = row;

							// Destructure date and timezone from DateWithTimezoneString
							const { date: createdDate, timezone } =
								DateWithTimezoneFromString(created_at);
							const { date: updatedDate } =
								DateWithTimezoneFromString(updated_at);

							// Build frontmatter with consistent field names
							const frontmatter = {
								title,
								type,
								tags,
								resonance,
								timezone,
								created_at: createdDate,
								updated_at: updatedDate,
							};

							return {
								frontmatter,
								body: content,
								filename: `${rowId}.md`,
							};
						},

						deserialize: ({ frontmatter, body, filename, table }) => {
							const rowId = path.basename(filename, '.md');

							// Parse frontmatter with consistent field names
							const EntryFrontmatter = type({
								title: 'string',
								'type?': 'string[]',
								'tags?': 'string[]',
								'resonance?': 'string | null',
								timezone: 'string',
								created_at: 'Date',
								updated_at: 'Date',
							});

							const parsed = EntryFrontmatter(frontmatter);
							if (parsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for entry ${rowId}`,
									context: {
										filename,
										id: rowId,
										reason: parsed.summary,
									},
								});
							}

							const row = {
								id: rowId,
								title: parsed.title,
								content: body,
								type: parsed.type ?? null,
								tags: parsed.tags ?? null,
								resonance: parsed.resonance ?? null,
								created_at: DateWithTimezone({
									date: parsed.created_at,
									timezone: parsed.timezone,
								}).toJSON(),
								updated_at: DateWithTimezone({
									date: parsed.updated_at,
									timezone: parsed.timezone,
								}).toJSON(),
							} satisfies SerializedRow<typeof table.schema>;

							return Ok(row);
						},
					},
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db.entries,

		// Local markdown sync
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,

		// Blog content collection sync
		pullToBlog: indexes.blog.pullToMarkdown,
		pushFromBlog: indexes.blog.pushFromMarkdown,

		// SQLite sync
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,
	}),
});
