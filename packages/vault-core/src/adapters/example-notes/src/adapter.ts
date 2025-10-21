/**
 * Example Notes adapter refined to mirror Reddit adapter patterns.
 *
 * - Uses Drizzle schema helpers with intuitive types
 * - created_at is an integer (epoch ms) via Drizzle integer timestamp column (typed as number)
 * - tags is a TEXT column storing a JSON array string, default "[]"
 * - Exposes an arktype-backed StandardSchemaV1-compatible validator
 * - Keeps table prefix: example_notes_items
 */

import { defineAdapter } from '@repo/vault-core';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AdapterMetadata } from '../../../core/adapter';
import { exampleNotesTransforms } from '../migrations/transforms';
import { exampleNotesVersions } from '../migrations/versions';

/**
 * Drizzle schema for the example_notes adapter.
 * Table names are prefixed with the adapter id: `example_notes_items`
 */
export const schema = {
	example_notes_items: sqliteTable('example_notes_items', {
		id: text('id').primaryKey(),
		title: text('title'),
		body: text('body'),
		// JSON array string (canonical format) with default []
		tags: text('tags').default('[]').$type<string[]>(),
		// JSON array string (canonical format) of Entity IDs, default []
		entity_links: text('entity_links').notNull().default('[]'),
		// Epoch milliseconds as integer; typed as number in TS
		created_at: integer('created_at', { mode: 'timestamp' }),
		public_id: text('public_id'),
	}),
} as const;

/**
 * Human-friendly metadata for adapter tables/columns.
 */
export const metadata = {
	example_notes_items: {
		id: 'Primary key',
		title: 'Note title',
		body: 'Note body',
		tags: 'JSON array stored as TEXT (default "[]")',
		entity_links:
			'JSON array (string[]) of Entity IDs from entity_index_entities, stored as TEXT JSON (default "[]")',
		created_at: 'Creation time in epoch milliseconds (SQLite integer)',
		public_id: 'Optional stable public id for cross-adapter linking',
	},
} satisfies AdapterMetadata<typeof schema>;

/**
 * Export the adapter definition. No ingestors for this example.
 */
export const exampleNotesAdapter = defineAdapter(() => ({
	id: 'example_notes',
	schema,
	metadata,
	versions: exampleNotesVersions,
	transforms: exampleNotesTransforms,
}));
