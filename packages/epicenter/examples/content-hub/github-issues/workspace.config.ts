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
	id,
	text,
	select,
	multiSelect,
	date,
} from '../../../src/index';
import { setupPersistence } from '../../../src/core/workspace/providers';
import { NICHES } from '../shared/niches';

/**
 * GitHub Issues workspace
 *
 * Manages GitHub issues for projects with tracking metadata.
 * Uses a custom schema specific to issue tracking needs.
 */
export const githubIssues = defineWorkspace({
	id: 'github-issues',
	version: 1,

	schema: {
		issues: {
			id: id(),
			repository: text(),
			title: text(),
			body: text(),
			status: select({ options: ['open', 'in-progress', 'closed'] }),
			labels: multiSelect({ options: ['bug', 'feature', 'documentation', 'enhancement', 'question'] }),
			niche: select({ options: NICHES }),
			createdAt: date(),
			updatedAt: date(),
		},
	},

	indexes: {
		sqlite: (db) => sqliteIndex(db),
	},

	providers: [setupPersistence],

	actions: ({ db, indexes }) => ({
		/**
		 * Get all GitHub issues
		 */
		getIssues: defineQuery({
			handler: async () => {
				const issues = await indexes.sqlite.db.select().from(indexes.sqlite.issues);
				return Ok(issues);
			},
		}),

		/**
		 * Get specific GitHub issue by ID
		 */
		getIssue: defineQuery({
			input: type({ id: "string" }),
			handler: async ({ id }) => {
				const issues = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.issues)
					.where(eq(indexes.sqlite.issues.id, id));
				return Ok(issues[0] ?? null);
			},
		}),

		/**
		 * Create new GitHub issue
		 */
		createIssue: defineMutation({
			input: type({
				repository: "string",
				title: "string",
				body: "string",
				"labels?": "('bug' | 'feature' | 'documentation' | 'enhancement' | 'question')[]",
				niche: "'personal' | 'epicenter' | 'y-combinator' | 'yale' | 'college-students' | 'high-school-students' | 'coding' | 'productivity' | 'ethics' | 'writing'",
			}),
			handler: async ({ repository, title, body, labels, niche }) => {
				const now = new Date();
				const issue = {
					id: generateId(),
					repository,
					title,
					body,
					status: 'open' as const,
					labels: labels ?? [],
					niche,
					createdAt: now,
					updatedAt: now,
				} satisfies Row<typeof db.schema.issues>;

				db.tables.issues.insert(issue);
				return Ok(issue);
			},
		}),

		/**
		 * Update GitHub issue
		 */
		updateIssue: defineMutation({
			input: type({
				id: "string",
				"title?": "string",
				"body?": "string",
				"status?": "'open' | 'in-progress' | 'closed'",
				"labels?": "('bug' | 'feature' | 'documentation' | 'enhancement' | 'question')[]",
				"niche?": "'personal' | 'epicenter' | 'y-combinator' | 'yale' | 'college-students' | 'high-school-students' | 'coding' | 'productivity' | 'ethics' | 'writing'",
			}),
			handler: async ({ id, ...fields }) => {
				const updates = {
					id,
					...fields,
					updatedAt: new Date(),
				};
				db.tables.issues.update(updates);
				const { row } = db.tables.issues.get(id);
				return Ok(row);
			},
		}),

		/**
		 * Close GitHub issue (sets status to closed)
		 */
		closeIssue: defineMutation({
			input: type({ id: "string" }),
			handler: async ({ id }) => {
				db.tables.issues.update({
					id,
					status: 'closed',
					updatedAt: new Date(),
				});
				const { row } = db.tables.issues.get(id);
				return Ok(row);
			},
		}),

		/**
		 * Get issues filtered by status
		 */
		getIssuesByStatus: defineQuery({
			input: type({
				status: "'open' | 'in-progress' | 'closed'",
			}),
			handler: async ({ status }) => {
				const issues = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.issues)
					.where(eq(indexes.sqlite.issues.status, status));
				return Ok(issues);
			},
		}),

		/**
		 * Get issues filtered by repository
		 */
		getIssuesByRepository: defineQuery({
			input: type({
				repository: "string",
			}),
			handler: async ({ repository }) => {
				const issues = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.issues)
					.where(eq(indexes.sqlite.issues.repository, repository));
				return Ok(issues);
			},
		}),
	}),
});
