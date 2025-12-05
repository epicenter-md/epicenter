import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	DateWithTimezone,
	date,
	defineMutation,
	defineWorkspace,
	generateId,
	id,
	markdownIndex,
	select,
	sqliteIndex,
	tags,
	text,
} from '@epicenter/hq';
import { readMarkdownFile } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';

/**
 * Pages workspace
 * Manages page content with rich metadata (blogs, articles, guides, tutorials, news)
 */
export const pages = defineWorkspace({
	id: 'pages',

	schema: {
		pages: {
			// Core fields
			id: id(),
			title: text(),
			content: text(),
			subtitle: text({ nullable: true }),

			// Timestamps with timezone support
			created_at: date({ nullable: true }),
			updated_at: date({ nullable: true }),
			date: date({ nullable: true }),
			timezone: text({ nullable: true }),

			// Status tracking
			status: select({
				options: [
					'Needs Scaffolding',
					'Needs Polishing',
					'Backlog',
					'Draft',
					'Published',
					'Archived',
				],
				nullable: true,
			}),
			status_transcripts_complete: select({
				options: ['TRUE', 'FALSE'],
				nullable: true,
			}),

			// Categorization (tags allows multiple values)
			type: tags({
				options: [
					// Folder-based categories
					'_misc',
					'_family_and_carrie_journal',
					'_frontend_coding_tips',
					'_functional_journal',
					'_gap_thesis',
					'_janktable_revamp',
					'_video_comments',
					'_video_excerpts',
					'_yale_meals',
					'_yale_tales',
					'_Epicenter_Progress',
					'_my_favorite_foods',
					'_notable_yale_alumni',
					'_misc_false',
					// Content types
					'blog',
					'article',
					'guide',
					'tutorial',
					'news',
				],
				nullable: true,
			}),

			tags: tags({
				// options: [
				// 	'Yale',
				// 	'Advice/Original',
				// 	'Epicenter',
				// 	'YC',
				// 	'College Students',
				// 	'High School Students',
				// 	'Coding',
				// 	'Productivity',
				// 	'Ethics',
				// 	'Writing',
				// 	'Tech',
				// 	'Lifestyle',
				// 	'Business',
				// 	'Education',
				// 	'Entertainment',
				// ],
				nullable: true,
			}),

			// Publishing metadata
			url: text({ nullable: true }),
			visibility: select({
				options: ['public', 'private', 'unlisted'],
				nullable: true,
			}),
			resonance: text({ nullable: true }),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) => markdownIndex(c),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => {
		/**
		 * Transform ISO 8601 date string with timezone to DateWithTimezone format
		 * Only transforms if BOTH isoDate AND timezone are provided (no defaults)
		 */
		function transformDate(
			isoDate: string | undefined,
			timezone: string | undefined,
		): string | null {
			if (!isoDate || !timezone) return null;

			try {
				const date = new Date(isoDate);
				if (Number.isNaN(date.getTime())) return null;

				return DateWithTimezone({ date, timezone }).toJSON();
			} catch {
				return null;
			}
		}

		return {
			...db.pages,
			pullToMarkdown: indexes.markdown.pullToMarkdown,
			pushFromMarkdown: indexes.markdown.pushFromMarkdown,
			pullToSqlite: indexes.sqlite.pullToSqlite,
			pushFromSqlite: indexes.sqlite.pushFromSqlite,

			/**
			 * Migrate pages from EpicenterHQ format
			 *
			 * Reads markdown files from the specified directory, parses frontmatter,
			 * transforms dates with timezone, and inserts into the database.
			 */
			migrateFromEpicenterMd: defineMutation({
				input: type({
					sourcePath: 'string',
					'dryRun?': 'boolean',
				}),
				handler: async ({ sourcePath, dryRun = false }) => {
					const { data: files, error: readError } = await tryAsync({
						try: () => readdir(sourcePath, { recursive: true }),
						catch: (error) =>
							Err({
								message: 'Failed to read source directory',
								context: {
									sourcePath,
									error: extractErrorMessage(error),
								},
							}),
					});

					if (readError) return Err(readError);

					const markdownFiles = files
						.filter((file) => file.endsWith('.md'))
						.map((file) => join(sourcePath, file));

					console.log(`📂 Found ${markdownFiles.length} markdown files`);

					const stats = {
						total: 0,
						success: 0,
						errors: [] as Array<{ file: string; error: string }>,
					};

					for (const file of markdownFiles) {
						stats.total++;

						const parseResult = await readMarkdownFile(file);

						if (parseResult.error) {
							stats.errors.push({
								file,
								error: extractErrorMessage(parseResult.error),
							});
							continue;
						}

						const { data: frontmatter, body } = parseResult.data;
						const timezone = frontmatter.timezone as string | undefined;

						const page = {
							id: (frontmatter.id as string) || generateId(),
							title: (frontmatter.title as string) || 'Untitled',
							content:
								body ||
								(frontmatter.content_draft as string) ||
								(frontmatter.content as string) ||
								'',
							subtitle: (frontmatter.subtitle as string | null) || null,
							created_at: transformDate(
								frontmatter.created_at as string | undefined,
								timezone,
							),
							updated_at: transformDate(
								frontmatter.updated_at as string | undefined,
								timezone,
							),
							date: transformDate(
								frontmatter.date as string | undefined,
								timezone,
							),
							timezone: timezone || null,
							status: (frontmatter.status as string | null) || null,
							status_transcripts_complete:
								(frontmatter.status_transcripts_complete as string | null) ||
								null,
							type:
								Array.isArray(frontmatter.type) && frontmatter.type.length > 0
									? (frontmatter.type as string[])
									: null,
							tags:
								Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0
									? (frontmatter.tags as string[])
									: Array.isArray(frontmatter.on) && frontmatter.on.length > 0
										? (frontmatter.on as string[])
										: null,
							url: (frontmatter.url as string | null) || null,
							visibility: (frontmatter.visibility as string | null) || null,
							resonance: (frontmatter.resonance as string | null) || null,
						};

						if (!dryRun) {
							db.pages.insert(page);
						}

						stats.success++;
					}

					console.log('\n📊 Migration Statistics:');
					console.log(`  ✅ Success: ${stats.success}`);
					console.log(`  ❌ Errors: ${stats.errors.length}`);

					if (stats.errors.length > 0) {
						console.log('\n⚠️  Errors:');
						for (const { file, error } of stats.errors.slice(0, 10)) {
							console.log(`  - ${file}: ${error}`);
						}
						if (stats.errors.length > 10) {
							console.log(`  ... and ${stats.errors.length - 10} more`);
						}
					}

					return Ok({
						total: stats.total,
						success: stats.success,
						errorCount: stats.errors.length,
						errors: stats.errors,
					});
				},
			}),
		};
	},
});
