import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';
import {
	defineWorkspace,
	sqliteIndex,
	defineQuery,
	defineMutation,
	generateId,
	eq,
	type Row,
} from '../../../src/index';
import { setupPersistence } from '../../../src/core/workspace/providers';
import { SHORT_FORM_VIDEO_SCHEMA } from '../shared/schemas';

/**
 * Instagram workspace
 *
 * Manages Instagram video/reel posts with metadata for distribution tracking.
 * Uses the shared SHORT_FORM_VIDEO_SCHEMA for consistency across video platforms.
 */
export const instagram = defineWorkspace({
	id: 'instagram',
	version: 1,

	schema: {
		posts: SHORT_FORM_VIDEO_SCHEMA,
	},

	indexes: {
		sqlite: (db) => sqliteIndex(db),
	},

	providers: [setupPersistence],

	actions: ({ db, indexes }) => ({
		/**
		 * Get all Instagram posts
		 */
		getPosts: defineQuery({
			handler: async () => {
				const posts = await indexes.sqlite.db.select().from(indexes.sqlite.posts);
				return Ok(posts);
			},
		}),

		/**
		 * Get specific Instagram post by ID
		 */
		getPost: defineQuery({
			input: type({ id: "string" }),
			handler: async ({ id }) => {
				const posts = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.posts)
					.where(eq(indexes.sqlite.posts.id, id));
				return Ok(posts[0] ?? null);
			},
		}),

		/**
		 * Create new Instagram post
		 */
		createPost: defineMutation({
			input: type({
				pageId: "string",
				title: "string",
				description: "string",
				niche: "'personal' | 'epicenter' | 'y-combinator' | 'yale' | 'college-students' | 'high-school-students' | 'coding' | 'productivity' | 'ethics' | 'writing'",
			}),
			handler: async ({ pageId, title, description, niche }) => {
				const now = new Date();
				const post = {
					id: generateId(),
					pageId,
					title,
					description,
					niche,
					postedAt: now,
					updatedAt: now,
				} satisfies Row<typeof db.schema.posts>;

				db.tables.posts.insert(post);
				return Ok(post);
			},
		}),

		/**
		 * Update Instagram post
		 */
		updatePost: defineMutation({
			input: type({
				id: "string",
				"title?": "string",
				"description?": "string",
				"niche?": "'personal' | 'epicenter' | 'y-combinator' | 'yale' | 'college-students' | 'high-school-students' | 'coding' | 'productivity' | 'ethics' | 'writing'",
			}),
			handler: async ({ id, ...fields }) => {
				const updates = {
					id,
					...fields,
					updatedAt: new Date(),
				};
				db.tables.posts.update(updates);
				const { row } = db.tables.posts.get(id);
				return Ok(row);
			},
		}),

		/**
		 * Delete Instagram post
		 */
		deletePost: defineMutation({
			input: type({ id: "string" }),
			handler: async ({ id }) => {
				db.tables.posts.delete(id);
				return Ok({ id });
			},
		}),

		/**
		 * Get posts filtered by niche
		 */
		getPostsByNiche: defineQuery({
			input: type({
				niche: "'personal' | 'epicenter' | 'y-combinator' | 'yale' | 'college-students' | 'high-school-students' | 'coding' | 'productivity' | 'ethics' | 'writing'",
			}),
			handler: async ({ niche }) => {
				const posts = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.posts)
					.where(eq(indexes.sqlite.posts.niche, niche));
				return Ok(posts);
			},
		}),
	}),
});
