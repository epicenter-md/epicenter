import path from 'node:path';
import {
	date,
	defineWorkspace,
	id,
	markdownIndex,
	type SerializedRow,
	sqliteIndex,
	tags,
	text,
} from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';

/**
 * Email workspace
 *
 * Manages email messages with subject, body, and date tracking.
 * Stores email records for archival and reference purposes.
 */
export const email = defineWorkspace({
	id: 'email',

	schema: {
		emails: {
			id: id(),
			subject: text(),
			body: text(),
			description: text({ nullable: true }),
			tags: tags({
				options: [
					'Announcement',
					'Auditing',
					'Cambridge',
					'Cancellation',
					'Chinese',
					'Classes',
					'Courses',
					'Foreign Policy',
					'Gap',
					'Gapping',
					'Journal',
					'Leave of Absence',
					'Light Fellowship',
					'Project',
					'Request',
					'Superlatives',
					'Yale',
				],
				nullable: true,
			}),
			date: date(),
			created_at: date(),
			updated_at: date(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					emails: {
						serialize: ({ row: { body, id, ...row } }) => ({
							frontmatter: row,
							body,
							filename: `${id}.md`,
						}),
						deserialize: ({ frontmatter, body, filename, table }) => {
							const id = path.basename(filename, '.md');

							const FrontMatter = table.validators
								.toArktype()
								.omit('id', 'body');
							const frontmatterParsed = FrontMatter(frontmatter);
							if (frontmatterParsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for row ${id}`,
									context: {
										fileName: filename,
										id,
										reason: frontmatterParsed,
									},
								});
							}
							const row = {
								id,
								body,
								description: frontmatterParsed.description ?? null,
								tags: frontmatterParsed.tags ?? null,
								subject: frontmatterParsed.subject,
								date: frontmatterParsed.date,
								created_at: frontmatterParsed.created_at,
								updated_at: frontmatterParsed.updated_at,
							} satisfies SerializedRow<typeof table.schema>;
							return Ok(row);
						},
					},
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db.emails,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,
	}),
});
