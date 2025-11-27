import path from 'node:path';
import {
	DateWithTimezone,
	DateWithTimezoneFromString,
	type SerializedRow,
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
		clippings: {
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
			wordCount: integer(),
			clippedAt: date(),
		},
		landingPages: {
			id: id(),
			url: text(),
			title: text(),
			designQuality: select({ options: QUALITY_OPTIONS }),
			addedAt: date(),
		},
		gitHubReadmes: {
			id: id(),
			url: text(),
			title: text(),
			description: text({ nullable: true }),
			content: text(),
			taste: select({ options: QUALITY_OPTIONS }),
			addedAt: date(),
		},
		docSites: {
			id: id(),
			url: text(),
			title: text(),
			quality: select({ options: QUALITY_OPTIONS }),
			addedAt: date(),
		},
		books: {
			id: id(),
			title: text(),
			author: text(),
			addedAt: date(),
			readAt: date({ nullable: true }),
		},
		bookClippings: {
			id: id(),
			bookId: text(),
			content: text(),
			comment: text({ nullable: true }),
			createdAt: date(),
			updatedAt: date(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					clippings: {
						serialize: ({ row: { content, id, ...row } }) => {
							// Strip null values for cleaner YAML
							const frontmatter = Object.fromEntries(
								Object.entries(row).filter(([_, value]) => value !== null),
							);
							return {
								frontmatter,
								body: content,
								filename: `${id}.md`,
							};
						},
						deserialize: ({ frontmatter, body, filename, table }) => {
							const rowId = path.basename(filename, '.md');

							// Stripped null values from serialize are restored via .default(null)
							const FrontMatter = table.validators
								.toArktype()
								.omit('id', 'content');
							const parsed = FrontMatter(frontmatter);

							if (parsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for row ${rowId}`,
									context: {
										fileName: filename,
										id: rowId,
										reason: parsed.summary,
									},
								});
							}

							const row = {
								id: rowId,
								content: body,
								...parsed,
							} satisfies SerializedRow<typeof table.schema>;

							return Ok(row);
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
			input: type({ url: 'string' }),
			handler: async ({ url }) => {
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
				db.clippings.insert({
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
					wordCount: result.wordCount,
					clippedAt: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Remove duplicate clippings
		 *
		 * Compares clippings by URL and keeps only the most recently clipped version.
		 * Deletes older duplicates based on clippedAt timestamp.
		 */
		removeDuplicates: defineMutation({
			handler: () => {
				type Clipping = typeof db.clippings.$inferSerializedRow;

				// Convert rows to JSON
				const clippings: Clipping[] = db.clippings
					.getAll()
					.map((row) => row.toJSON());

				// Group by URL
				const urlMap = new Map<string, Clipping[]>();
				for (const clipping of clippings) {
					if (!urlMap.has(clipping.url)) {
						urlMap.set(clipping.url, []);
					}
					urlMap.get(clipping.url)?.push(clipping);
				}

				// Collect IDs to delete (keep only the most recent for each URL)
				const idsToDelete = Array.from(urlMap.values()).flatMap(
					(duplicates) => {
						if (duplicates.length <= 1) {
							return [];
						}

						// Find the most recent clipping
						const newest = duplicates.reduce((max, current) => {
							const maxTime = DateWithTimezoneFromString(
								max.clippedAt,
							).date.getTime();
							const currentTime = DateWithTimezoneFromString(
								current.clippedAt,
							).date.getTime();
							return currentTime > maxTime ? current : max;
						});

						// Return IDs of all others
						return duplicates
							.filter((clipping) => clipping.id !== newest.id)
							.map((clipping) => clipping.id);
					},
				);

				// Delete all duplicates in one batch operation
				db.clippings.deleteMany({ ids: idsToDelete });

				return Ok({ deletedCount: idsToDelete.length });
			},
		}),

		/**
		 * Add a landing page
		 */
		addLandingPage: defineMutation({
			input: type({
				url: 'string',
				title: 'string',
				designQuality: type.enumerated(...QUALITY_OPTIONS),
			}),
			handler: async ({ url, title, designQuality }) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.landingPages.insert({
					id: generateId(),
					url,
					title,
					designQuality,
					addedAt: now,
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Add a GitHub repository
		 *
		 * Fetches the GitHub repo page, extracts the README content using Defuddle,
		 * and stores it with your taste rating.
		 */
		addGitHubRepo: defineMutation({
			input: type({
				url: 'string',
				taste: type.enumerated(...QUALITY_OPTIONS),
				title: 'string | null',
				description: 'string | null',
			}),
			handler: async ({ url, taste, title, description }) => {
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

				db.gitHubReadmes.insert({
					id: generateId(),
					url,
					title: finalTitle,
					description: description || result.description || null,
					content: result.content,
					taste,
					addedAt: now,
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

				db.docSites.insert({
					id: generateId(),
					url,
					title,
					quality,
					addedAt: now,
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
			input: type({
				title: 'string',
				author: 'string',
				'readAt?': 'string',
			}),
			handler: ({ title, author, readAt }) => {
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				const bookId = generateId();

				db.books.insert({
					id: bookId,
					title,
					author,
					addedAt: now,
					readAt: readAt
						? DateWithTimezone({
								date: new Date(readAt),
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							}).toJSON()
						: null,
				});

				return Ok({ bookId });
			},
		}),

		/**
		 * Add a clipping from a book
		 *
		 * Creates a new clipping associated with an existing book.
		 */
		addBookClipping: defineMutation({
			input: type({
				bookId: 'string',
				content: 'string',
				'comment?': 'string',
			}),
			handler: ({ bookId, content, comment }) => {
				// Verify the book exists
				const book = db.books.get(bookId);
				if (!book) {
					return Err({
						message: 'Book not found',
						context: { bookId },
					});
				}

				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				db.bookClippings.insert({
					id: generateId(),
					bookId,
					content,
					comment: comment ?? null,
					createdAt: now,
					updatedAt: now,
				});

				return Ok(undefined);
			},
		}),
	}),
});
