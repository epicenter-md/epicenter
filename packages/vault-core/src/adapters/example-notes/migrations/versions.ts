/**
 * Migration versions for the example_notes adapter.
 *
 * Single baseline version that mirrors the Drizzle-generated SQL for the schema
 * defined in src/adapter.ts. This follows the Reddit adapter pattern of inlining
 * the SQL artifacts for environment-agnostic startup migrations.
 */
import { defineVersions } from '../../../core/migrations';

export const exampleNotesVersions = defineVersions(
	{
		tag: '0000',
		sql: [
			`CREATE TABLE \`example_notes_items\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text,
	\`body\` text,
	\`tags\` text DEFAULT '[]',
	\`created_at\` integer,
	\`public_id\` text
);`,
		],
	},
	{
		tag: '0001',
		sql: [
			`ALTER TABLE example_notes_items ADD COLUMN entity_links text NOT NULL DEFAULT '[]';`,
		],
	},
);
