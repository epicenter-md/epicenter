import {
	date,
	defineWorkspace,
	id,
	markdownIndex,
	select,
	sqliteIndex,
	tags,
	text,
	withBodyField,
} from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers';

/**
 * Journal workspace
 * Manages personal journal entries with temporal and reflective metadata
 */
export const journal = defineWorkspace({
	id: 'journal',

	schema: {
		journal: {
			// Core fields
			id: id(),
			title: text(),
			content: text(),

			// Timestamps with timezone support
			date: date(),
			timezone: text(),
			created_at: date({ nullable: true }),
			updated_at: date({ nullable: true }),

			// Categorization
			journal_type: select({
				options: ['family', 'friends', 'personal'],
				nullable: true,
			}),

			type: tags({
				nullable: true,
			}),

			tags: tags({
				nullable: true,
			}),

			// Emotional/reflective metadata
			mood: select({
				options: [
					'joyful',
					'content',
					'contemplative',
					'neutral',
					'melancholic',
					'frustrated',
					'anxious',
				],
				nullable: true,
			}),

			resonance: select({
				options: [
					'High',
					'Medium',
					'Moderate',
					'Mild',
					'Low',
					'Profound',
					'Transformative',
					'Extreme',
				],
				nullable: true,
			}),

			// Context
			location: text({ nullable: true }),

			// Meal tracking
			meal: select({
				options: ['breakfast', 'lunch', 'dinner', 'snack'],
				nullable: true,
			}),

			// Workflow/publishing fields (from migration)
			subtitle: text({ nullable: true }),
			alias: tags({ nullable: true }), // Array of alternative titles
			status: select({
				options: [
					'Done',
					'Needs Scaffolding',
					'Needs Polishing',
					'Imported from Todoist',
					'Draft',
					'Backlog',
				],
				nullable: true,
			}),
			visibility: select({
				options: ['Family', 'Public', 'Private'],
				nullable: true,
			}),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					// Keep null values for proper round-trip (no stripping)
					journal: withBodyField('content', { stripNulls: false }),
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => ({
		...db.journal,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,
	}),
});
