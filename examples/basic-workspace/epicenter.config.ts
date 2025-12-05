import path from 'node:path';
import {
	defineEpicenter,
	defineMutation,
	defineQuery,
	defineWorkspace,
	eq,
	generateId,
	id,
	integer,
	isNotNull,
	markdownIndex,
	type SerializedRow,
	select,
	sqliteIndex,
	text,
} from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';

/**
 * Example blog workspace
 * Demonstrates the basic structure of an Epicenter workspace
 */

const blogWorkspace = defineWorkspace({
	id: 'blog',

	schema: {
		posts: {
			id: id(),
			title: text(),
			content: text({ nullable: true }),
			category: select({ options: ['tech', 'personal', 'tutorial'] }),
			views: integer({ default: 0 }),
			publishedAt: text({ nullable: true }),
		},
		comments: {
			id: id(),
			postId: text(),
			author: text(),
			content: text(),
			createdAt: text(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (context) =>
			markdownIndex(context, {
				tableConfigs: {
					posts: {
						serialize: ({ row: { id, content, ...row } }) => ({
							frontmatter: Object.fromEntries(
								Object.entries(row).filter(([_, v]) => v != null),
							),
							body: content ?? '',
							filename: `${id}.md`,
						}),
						deserialize: ({ frontmatter, body, filename, table }) => {
							// Extract id from filename
							const id = path.basename(filename, '.md');

							// Validate frontmatter using schema
							const FrontMatter = table.validators
								.toArktype()
								.omit('id', 'content');
							const frontmatterParsed = FrontMatter(frontmatter);

							if (frontmatterParsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for post ${id}`,
									context: {
										filename,
										id,
										reason: frontmatterParsed,
									},
								});
							}

							// Construct the full row
							const row = {
								id,
								content: body,
								...frontmatterParsed,
							} satisfies SerializedRow<typeof table.schema>;

							return Ok(row);
						},
					},
					comments: {
						serialize: ({ row: { id, ...row } }) => ({
							frontmatter: Object.fromEntries(
								Object.entries(row).filter(([_, v]) => v != null),
							),
							body: '',
							filename: `${id}.md`,
						}),
						deserialize: ({ frontmatter, filename, table }) => {
							// Extract id from filename
							const id = path.basename(filename, '.md');

							// Validate frontmatter using validators
							const FrontMatter = table.validators.toArktype().omit('id');
							const frontmatterParsed = FrontMatter(frontmatter);

							if (frontmatterParsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for comment ${id}`,
									context: { filename, id, reason: frontmatterParsed },
								});
							}

							// Construct the full row
							const row = {
								id,
								...frontmatterParsed,
							} satisfies SerializedRow<typeof table.schema>;

							return Ok(row);
						},
					},
				},
			}),
	},

	exports: ({ schema, db, indexes }) => ({
		// Query: Get all published posts
		getPublishedPosts: defineQuery({
			handler: async () => {
				const posts = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.posts)
					.where(isNotNull(indexes.sqlite.posts.publishedAt));
				return Ok(posts);
			},
		}),

		// Query: Get post by ID
		getPost: defineQuery({
			input: type({ id: 'string' }),
			handler: async ({ id }) => {
				const post = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.posts)
					.where(eq(indexes.sqlite.posts.id, id));
				return Ok(post);
			},
		}),

		// Query: Get comments for a post
		getPostComments: defineQuery({
			input: type({ postId: 'string' }),
			handler: async ({ postId }) => {
				const comments = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.comments)
					.where(eq(indexes.sqlite.comments.postId, postId));
				return Ok(comments);
			},
		}),

		// Mutation: Create a new post
		createPost: defineMutation({
			input: type({
				title: 'string',
				'content?': 'string',
				category: "'tech' | 'personal' | 'tutorial'",
			}),
			handler: async ({ title, content, category }) => {
				const post = {
					id: generateId(),
					title,
					content: content ?? '',
					category,
					views: 0,
					publishedAt: null,
				} satisfies typeof db.posts.$inferSerializedRow;
				db.posts.insert(post);
				return Ok(post);
			},
		}),

		// Mutation: Publish a post
		publishPost: defineMutation({
			input: type({ id: 'string' }),
			handler: async ({ id }) => {
				const { status, row } = db.posts.get({ id });
				if (status !== 'valid') {
					throw new Error(`Post ${id} not found`);
				}
				db.posts.update({
					id,
					publishedAt: new Date().toISOString(),
				});
				const { row: updatedPost } = db.posts.get({ id });
				return Ok(updatedPost);
			},
		}),

		// Mutation: Add a comment
		addComment: defineMutation({
			input: type({
				postId: 'string',
				author: 'string',
				content: 'string',
			}),
			handler: async ({ postId, author, content }) => {
				const comment = {
					id: generateId(),
					postId,
					author,
					content,
					createdAt: new Date().toISOString(),
				} satisfies typeof db.comments.$inferSerializedRow;
				db.comments.insert(comment);
				return Ok(comment);
			},
		}),

		// Mutation: Increment post views
		incrementViews: defineMutation({
			input: type({ id: 'string' }),
			handler: async ({ id }) => {
				const { status, row } = db.posts.get({ id });
				if (status !== 'valid') {
					throw new Error(`Post ${id} not found`);
				}
				db.posts.update({
					id,
					views: row.views + 1,
				});
				const { row: updatedPost } = db.posts.get({ id });
				return Ok(updatedPost);
			},
		}),
	}),

	// Use isomorphic persistence
	// Stores YJS document at .epicenter/blog.yjs (auto-resolved)
	providers: [setupPersistence],
});

export default defineEpicenter({
	id: 'basic-workspace-example',
	workspaces: [blogWorkspace],
});
