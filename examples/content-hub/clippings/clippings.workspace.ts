import path from 'node:path';
import {
	DateWithTimezone,
	DateWithTimezoneFromString,
	DateWithTimezoneString,
	date,
	defineMutation,
	defineWorkspace,
	generateId,
	id,
	integer,
	markdownIndex,
	select,
	sqliteIndex,
	text,
	withBodyField,
} from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { QUALITY_OPTIONS } from '../shared/quality';

/**
 * Clippings workspace
 *
 * Manages saved web content (articles, blog posts, tutorials) with full content extraction.
 * Uses Defuddle to extract and clean article content from URLs.
 */
export const clippings = defineWorkspace({
	id: 'clippings',
	schema: {
		articles: {
			id: id(),
			url: text(),
			title: text(),
			description: text({ nullable: true }),
			author: text({ nullable: true }),
			domain: text({ nullable: true }),
			site: text({ nullable: true }),
			favicon: text({ nullable: true }),
			published: date({ nullable: true }),
			image: text({ nullable: true }),
			content: text(),
			word_count: integer(),
			quality: select({ options: QUALITY_OPTIONS, nullable: true }),
			hacker_news_url: text({ nullable: true }),
			saved_at: date(),
		},
		landing_pages: {
			id: id(),
			url: text(),
			title: text(),
			design_quality: select({ options: QUALITY_OPTIONS }),
			added_at: date(),
		},
		github_repos: {
			id: id(),
			url: text(),
			title: text(),
			description: text({ nullable: true }),
			content: text(),
			readme_quality: select({ options: QUALITY_OPTIONS, nullable: true }),
			impact: select({ options: QUALITY_OPTIONS, nullable: true }),
			hacker_news_url: text({ nullable: true }),
			added_at: date(),
		},
		doc_sites: {
			id: id(),
			url: text(),
			title: text(),
			quality: select({ options: QUALITY_OPTIONS }),
			added_at: date(),
		},
		article_excerpts: {
			id: id(),
			article_id: text(),
			content: text(),
			comment: text({ nullable: true }),
			created_at: date(),
			updated_at: date(),
		},
		essays: {
			id: id(),
			url: text(),
			title: text(),
			author: text({ nullable: true }),
			content: text(),
			word_count: integer(),
			resonance: select({ options: QUALITY_OPTIONS, nullable: true }),
			added_at: date(),
		},
		essay_excerpts: {
			id: id(),
			essay_id: text(),
			content: text(),
			comment: text({ nullable: true }),
			created_at: date(),
			updated_at: date(),
		},
		books: {
			id: id(),
			title: text(),
			author: text(),
			added_at: date(),
			read_at: date({ nullable: true }),
		},
		book_excerpts: {
			id: id(),
			book_id: text(),
			content: text(),
			comment: text({ nullable: true }),
			created_at: date(),
			updated_at: date(),
		},
		recipes: {
			id: id(),
			title: text(),
			description: text({ nullable: true }),
			source: text(), // URL or reference (e.g., "Grandma's cookbook")
			servings: integer({ nullable: true }),
			prep_time: text({ nullable: true }), // e.g., "20 min", "1 hour"
			cook_time: text({ nullable: true }), // e.g., "30 min", "overnight"
			ingredients: text(), // markdown list
			instructions: text(), // markdown steps
			rating: select({ options: QUALITY_OPTIONS, nullable: true }),
			notes: text({ nullable: true }), // personal notes, modifications
			added_at: date(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					articles: withBodyField('content'),
					essays: withBodyField('content'),
					github_repos: withBodyField('content'),
					article_excerpts: withBodyField('content'),
					/**
					 * Custom markdown config for recipes
					 *
					 * Serializes ingredients and instructions into the markdown body with sections:
					 * ```markdown
					 * ## Ingredients
					 * - item 1
					 * - item 2
					 *
					 * ## Instructions
					 * 1. step 1
					 * 2. step 2
					 * ```
					 *
					 * Deserializes by parsing these sections back into separate fields.
					 */
					recipes: {
						serialize: ({ row }) => {
							const { id: rowId, ingredients, instructions, ...rest } = row;

							// Build body with markdown sections
							const body = `## Ingredients

${ingredients}

## Instructions

${instructions}`;

							// Strip null values from frontmatter
							const frontmatter = Object.fromEntries(
								Object.entries(rest).filter(([_, value]) => value !== null),
							);

							return {
								frontmatter,
								body,
								filename: `${rowId}.md`,
							};
						},

						deserialize: ({ frontmatter, body, filename, table }) => {
							const rowId = path.basename(filename, '.md');

							// Parse sections from body
							const ingredientsMatch = body.match(
								/## Ingredients\s*\n([\s\S]*?)(?=\n## Instructions|$)/,
							);
							const instructionsMatch = body.match(
								/## Instructions\s*\n([\s\S]*?)$/,
							);

							if (!ingredientsMatch || !instructionsMatch) {
								return MarkdownIndexErr({
									message: `Recipe ${rowId} missing required sections`,
									context: {
										fileName: filename,
										id: rowId,
										reason:
											'Body must contain "## Ingredients" and "## Instructions" sections',
									},
								});
							}

							const ingredients = ingredientsMatch[1].trim();
							const instructions = instructionsMatch[1].trim();

							// Validate frontmatter (omit id, ingredients, instructions)
							const FrontMatter = table.validators
								.toArktype()
								.omit('id', 'ingredients', 'instructions');

							const parsed = FrontMatter(frontmatter);

							if (parsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for recipe ${rowId}`,
									context: {
										fileName: filename,
										id: rowId,
										reason: parsed.summary,
									},
								});
							}

							return Ok({
								id: rowId,
								ingredients,
								instructions,
								...parsed,
							});
						},
					},
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,

		/**
		 * Add a clipping from a URL
		 *
		 * Fetches the URL using JSDOM, extracts content using Defuddle, and saves it as a clipping.
		 * Uses JSDOM for efficient single-pass parsing and better URL handling.
		 */
		addFromUrl: defineMutation({
			input: type({
				url: 'string',
				'quality?': type.enumerated(...QUALITY_OPTIONS),
				'hacker_news_url?': 'string',
			}),
			handler: async ({ url, quality, hacker_news_url }) => {
				// Fetch and parse HTML using JSDOM
				const { data: dom, error: fetchError } = await tryAsync({
					try: () => JSDOM.fromURL(url),
					catch: (error) =>
						Err({
							message: 'Failed to fetch URL',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (fetchError) return Err(fetchError);

				// Extract content with Defuddle using the parsed DOM
				const { data: result, error: parseError } = await tryAsync({
					try: () => Defuddle(dom, url, { markdown: true }),
					catch: (error) =>
						Err({
							message: 'Failed to parse content',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (parseError) return Err(parseError);

				// Generate ID and timestamps
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				// Insert into database
				db.articles.insert({
					id: generateId(),
					url,
					title: result.title,
					description: result.description === '' ? null : result.description,
					author: result.author === '' ? null : result.author,
					domain: result.domain === '' ? null : result.domain,
					site: result.site === '' ? null : result.site,
					favicon: result.favicon === '' ? null : result.favicon,
					published: result.published
						? DateWithTimezone({
								date: new Date(result.published),
								timezone: 'UTC',
							}).toJSON()
						: null,
					image: result.image === '' ? null : result.image,
					content: result.content,
					word_count: result.wordCount,
					quality: quality ?? null,
					hacker_news_url: hacker_news_url ?? null,
					saved_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Remove duplicates across all URL-based tables
		 *
		 * Compares entries by URL and keeps the oldest version (first added).
		 * Deletes newer duplicates based on timestamp fields.
		 */
		removeDuplicates: defineMutation({
			handler: () => {
				let totalDeleted = 0;

				// Helper to find duplicates and return IDs to delete (keep oldest)
				const findDuplicateIds = <
					T extends { id: string; url: string; [key: string]: unknown },
				>(
					items: T[],
					timestampField: keyof T,
				): string[] => {
					const urlMap = new Map<string, T[]>();
					for (const item of items) {
						if (!urlMap.has(item.url)) {
							urlMap.set(item.url, []);
						}
						urlMap.get(item.url)?.push(item);
					}

					return Array.from(urlMap.values()).flatMap((duplicates) => {
						if (duplicates.length <= 1) return [];

						// Find the oldest item (keep this one)
						const oldest = duplicates.reduce((min, current) => {
							const minTime = DateWithTimezoneFromString(
								min[timestampField] as DateWithTimezoneString,
							).date.getTime();
							const currentTime = DateWithTimezoneFromString(
								current[timestampField] as DateWithTimezoneString,
							).date.getTime();
							return currentTime < minTime ? current : min;
						});

						// Return IDs of newer duplicates to delete
						return duplicates
							.filter((item) => item.id !== oldest.id)
							.map((item) => item.id);
					});
				};

				// Dedupe articles (timestamp: saved_at)
				const articleIds = findDuplicateIds(db.articles.getAll(), 'saved_at');
				db.articles.deleteMany({ ids: articleIds });
				totalDeleted += articleIds.length;

				// Dedupe github_repos (timestamp: added_at)
				const repoIds = findDuplicateIds(db.github_repos.getAll(), 'added_at');
				db.github_repos.deleteMany({ ids: repoIds });
				totalDeleted += repoIds.length;

				// Dedupe landing_pages (timestamp: added_at)
				const landingPageIds = findDuplicateIds(
					db.landing_pages.getAll(),
					'added_at',
				);
				db.landing_pages.deleteMany({ ids: landingPageIds });
				totalDeleted += landingPageIds.length;

				// Dedupe doc_sites (timestamp: added_at)
				const docSiteIds = findDuplicateIds(db.doc_sites.getAll(), 'added_at');
				db.doc_sites.deleteMany({ ids: docSiteIds });
				totalDeleted += docSiteIds.length;

				return Ok({ deletedCount: totalDeleted });
			},
		}),

		/**
		 * Add a landing page
		 */
		addLandingPage: defineMutation({
			input: type({
				url: 'string',
				title: 'string',
				design_quality: type.enumerated(...QUALITY_OPTIONS),
			}),
			handler: async ({ url, title, design_quality }) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.landing_pages.insert({
					id: generateId(),
					url,
					title,
					design_quality,
					added_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add a GitHub repository
		 *
		 * Fetches the GitHub repo page, extracts the README content using Defuddle,
		 * and stores it with your quality ratings.
		 */
		addGitHubRepo: defineMutation({
			input: type({
				url: 'string',
				'readme_quality?': type.enumerated(...QUALITY_OPTIONS),
				'impact?': type.enumerated(...QUALITY_OPTIONS),
				title: 'string | null',
				description: 'string | null',
				'hacker_news_url?': 'string',
			}),
			handler: async ({
				url,
				readme_quality,
				impact,
				title,
				description,
				hacker_news_url,
			}) => {
				// Fetch and parse GitHub page using JSDOM
				const { data: dom, error: fetchError } = await tryAsync({
					try: () => JSDOM.fromURL(url),
					catch: (error) =>
						Err({
							message: 'Failed to fetch GitHub repo',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (fetchError) return Err(fetchError);

				// Extract content with Defuddle using the parsed DOM
				const { data: result, error: parseError } = await tryAsync({
					try: () => Defuddle(dom, url, { markdown: true }),
					catch: (error) =>
						Err({
							message: 'Failed to extract README content',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (parseError) return Err(parseError);

				// Extract repo name from URL if title not provided
				let finalTitle = title;
				if (!finalTitle) {
					const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
					if (match) {
						finalTitle = `${match[1]}/${match[2]}`;
					} else {
						finalTitle = result.title;
					}
				}

				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.github_repos.insert({
					id: generateId(),
					url,
					title: finalTitle,
					description: description || result.description || null,
					content: result.content,
					readme_quality: readme_quality ?? null,
					impact: impact ?? null,
					hacker_news_url: hacker_news_url ?? null,
					added_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add a documentation website
		 */
		addDocSite: defineMutation({
			input: type({
				url: 'string',
				title: 'string',
				quality: type.enumerated(...QUALITY_OPTIONS),
			}),
			handler: async ({ url, title, quality }) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.doc_sites.insert({
					id: generateId(),
					url,
					title,
					quality,
					added_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add a book
		 *
		 * Creates a new book entry. Returns the book ID for use with addBookClipping.
		 */
		addBook: defineMutation({
			input: db.books.validators.toArktype().pick('title', 'author', 'read_at'),
			handler: ({ title, author, read_at }) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				const book_id = generateId();

				db.books.insert({
					id: book_id,
					title,
					author,
					added_at: now,
					read_at: read_at ?? null,
				});

				return Ok({ book_id });
			},
		}),

		/**
		 * Add an excerpt from a book
		 *
		 * Creates a new excerpt associated with an existing book.
		 */
		addBookExcerpt: defineMutation({
			input: db.book_excerpts.validators
				.toArktype()
				.pick('book_id', 'content', 'comment'),
			handler: ({ book_id, content, comment }) => {
				// Verify the book exists
				const book = db.books.get(book_id);
				if (!book) {
					return Err({
						message: 'Book not found',
						context: { book_id },
					});
				}

				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.book_excerpts.insert({
					id: generateId(),
					book_id,
					content,
					comment: comment ?? null,
					created_at: now,
					updated_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add an excerpt from an article
		 *
		 * Creates a new excerpt associated with an existing article.
		 */
		addArticleExcerpt: defineMutation({
			input: db.article_excerpts.validators
				.toArktype()
				.pick('article_id', 'content', 'comment'),
			handler: ({ article_id, content, comment }) => {
				// Verify the article exists
				const article = db.articles.get({ id: article_id });
				if (!article) {
					return Err({
						message: 'Article not found',
						context: { article_id },
					});
				}

				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.article_excerpts.insert({
					id: generateId(),
					article_id,
					content,
					comment: comment ?? null,
					created_at: now,
					updated_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add an essay from a URL
		 *
		 * Fetches the URL using JSDOM, extracts content using Defuddle, and saves it as an essay.
		 * Essays are long-form content rated by their resonance/impact rather than quality.
		 */
		addEssayFromUrl: defineMutation({
			input: type({
				url: 'string',
				'resonance?': type.enumerated(...QUALITY_OPTIONS),
			}),
			handler: async ({ url, resonance }) => {
				// Fetch and parse HTML using JSDOM
				const { data: dom, error: fetchError } = await tryAsync({
					try: () => JSDOM.fromURL(url),
					catch: (error) =>
						Err({
							message: 'Failed to fetch URL',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (fetchError) return Err(fetchError);

				// Extract content with Defuddle using the parsed DOM
				const { data: result, error: parseError } = await tryAsync({
					try: () => Defuddle(dom, url, { markdown: true }),
					catch: (error) =>
						Err({
							message: 'Failed to parse content',
							context: {
								url,
								error: extractErrorMessage(error),
							},
						}),
				});

				if (parseError) return Err(parseError);

				// Generate ID and timestamps
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				// Insert into database
				db.essays.insert({
					id: generateId(),
					url,
					title: result.title,
					author: result.author === '' ? null : result.author,
					content: result.content,
					word_count: result.wordCount,
					resonance: resonance ?? null,
					added_at: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add a new recipe
		 */
		addRecipe: defineMutation({
			input: type({
				title: 'string',
				'description?': 'string',
				source: 'string',
				'servings?': 'number',
				'prep_time?': 'string',
				'cook_time?': 'string',
				ingredients: 'string',
				instructions: 'string',
				'rating?': type.enumerated(...QUALITY_OPTIONS),
				'notes?': 'string',
			}),
			handler: ({
				title,
				description,
				source,
				servings,
				prep_time,
				cook_time,
				ingredients,
				instructions,
				rating,
				notes,
			}) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				const recipe_id = generateId();

				db.recipes.insert({
					id: recipe_id,
					title,
					description: description ?? null,
					source,
					servings: servings ?? null,
					prep_time: prep_time ?? null,
					cook_time: cook_time ?? null,
					ingredients,
					instructions,
					rating: rating ?? null,
					notes: notes ?? null,
					added_at: now,
				});

				return Ok({ recipe_id });
			},
		}),

		/**
		 * Update a recipe's rating
		 */
		updateRecipeRating: defineMutation({
			input: type({
				recipe_id: 'string',
				rating: type.enumerated(...QUALITY_OPTIONS).or('null'),
			}),
			handler: ({ recipe_id, rating }) => {
				const recipe = db.recipes.get(recipe_id);
				if (!recipe) {
					return Ok({ found: false });
				}

				db.recipes.update({
					id: recipe_id,
					rating: rating,
				});

				return Ok({ found: true });
			},
		}),
	}),
});
