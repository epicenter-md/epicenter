import path from 'node:path';
import {
	date,
	defineWorkspace,
	id,
	markdownIndex,
	type SerializedRow,
	select,
	text,
} from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';

/**
 * Epicenter workspace
 *
 * Manages company-related content including pitches and strategic documents.
 * Tracks pitch iterations and versions for the Epicenter company.
 */
export const epicenter = defineWorkspace({
	id: 'epicenter',

	schema: {
		pitches: {
			id: id(),
			slug: text(),
			title: text(),
			content: text(),
			rating: select({ options: ['decent', 'good', 'great', 'excellent'] }),
			created_at: date(),
			updated_at: date(),
		},
	},

	indexes: {
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					pitches: {
						serialize: ({ row: { content, slug, ...row }, table }) => ({
							frontmatter: row,
							body: content,
							filename: `${slug}.md`,
						}),
						deserialize: ({ frontmatter, body, filename, table }) => {
							const slug = path.basename(filename, '.md');
							const FrontMatter = table.validators
								.toArktype()
								.omit('content', 'slug');
							const frontmatterParsed = FrontMatter(frontmatter);
							if (frontmatterParsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for pitch with slug ${slug}`,
									context: {
										filename,
										slug,
										reason: frontmatterParsed,
									},
								});
							}
							const row = {
								slug,
								content: body,
								...frontmatterParsed,
							} satisfies SerializedRow<typeof table.schema>;
							return Ok(row);
						},
					},
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db.pitches,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
	}),
});
