/**
 * Entity Index adapter migration versions.
 * Single baseline version derived from the Drizzle schema in src/adapter.ts.
 * SQL is inlined to keep migrations environment-agnostic (mirrors Reddit/Notes).
 */
import { defineVersions } from '../../../core/migrations';

export const entityIndexVersions = defineVersions({
	tag: '0000',
	sql: [
		`CREATE TABLE \`entity_index_entities\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text,
	\`type\` text,
	\`description\` text,
	\`public_id\` text,
	\`created_at\` integer
);`,
		`CREATE TABLE \`entity_index_occurrences\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`entity_id\` text,
	\`source_adapter_id\` text,
	\`source_table_name\` text,
	\`source_pk_json\` text,
	\`discovered_at\` integer
);`,
	],
});
