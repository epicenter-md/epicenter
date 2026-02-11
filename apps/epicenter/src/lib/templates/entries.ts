/**
 * Entries workspace template.
 *
 * A general-purpose content management schema with:
 * - id: unique identifier
 * - title: entry title
 * - content: entry body text
 * - type: categorization tags
 * - tags: additional tagging
 */

import {
	id,
	table,
	tags,
	text,
	type WorkspaceDefinition,
} from '@epicenter/hq/dynamic';

export const ENTRIES_TEMPLATE = {
	id: 'epicenter.entries',
	name: 'Entries',
	description: '',
	icon: null,
	tables: [
		table({
			id: 'entries',
			name: 'Entries',
			icon: '📝',
			description: 'General-purpose content entries',
			fields: [
				id(),
				text({ id: 'title', name: 'Title', description: 'Entry title' }),
				text({
					id: 'content',
					name: 'Content',
					description: 'Entry body text',
				}),
				tags({ id: 'type', name: 'Type', description: 'Entry type/category' }),
				tags({ id: 'tags', name: 'Tags', description: 'Additional tags' }),
			],
		}),
	],
	kv: [],
} as const satisfies WorkspaceDefinition;
