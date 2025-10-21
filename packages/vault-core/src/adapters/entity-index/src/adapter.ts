import { defineAdapter } from '@repo/vault-core';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AdapterMetadata } from '../../../core/adapter';
import { entityIndexTransforms } from '../migrations/transforms';
import { entityIndexVersions } from '../migrations/versions';

/**
 * Drizzle schema for the entity_index adapter.
 * Table names must be prefixed with the adapter id.
 */
export const schema = {
	entity_index_entities: sqliteTable('entity_index_entities', {
		id: text('id').primaryKey(),
		name: text('name'),
		type: text('type'),
		description: text('description'),
		public_id: text('public_id'),
		// Epoch milliseconds as integer
		created_at: integer('created_at', { mode: 'timestamp' }),
	}),
	entity_index_occurrences: sqliteTable('entity_index_occurrences', {
		id: text('id').primaryKey(),
		entity_id: text('entity_id'),
		source_adapter_id: text('source_adapter_id'),
		source_table_name: text('source_table_name'),
		// JSON string (canonical) of the primary key from the source table
		source_pk_json: text('source_pk_json'),
		// Epoch milliseconds as integer
		discovered_at: integer('discovered_at', { mode: 'timestamp' }),
	}),
} as const;

/** Human-friendly column descriptions. */
export const metadata: AdapterMetadata<typeof schema> = {
	entity_index_entities: {
		id: 'Primary key',
		name: 'Entity name',
		type: 'Entity type/category',
		description: 'Optional description of the entity',
		public_id: 'Optional stable public id for cross-adapter linking',
		created_at: 'Creation time in epoch milliseconds (stored as INTEGER)',
	},
	entity_index_occurrences: {
		id: 'Primary key',
		entity_id:
			'Logical reference to entity_index_entities.id (no FK enforcement)',
		source_adapter_id: 'Adapter id where this occurrence was discovered',
		source_table_name: 'Source table name within the adapter',
		source_pk_json:
			'Canonical JSON string of the source primary key (e.g., {"id":"t3_abc"})',
		discovered_at: 'Discovery time in epoch milliseconds (stored as INTEGER)',
	},
};

/** Unified adapter export, no ingestors required for this adapter. */
export const entityIndexAdapter = defineAdapter(() => ({
	id: 'entity_index',
	schema,
	metadata,
	versions: entityIndexVersions,
	transforms: entityIndexTransforms,
}));
