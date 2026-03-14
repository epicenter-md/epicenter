import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite table mirroring {@link FileRow} from the Yjs files table.
 *
 * This is a read-only index—never the source of truth. Rebuilt from Yjs
 * on every page load and kept in sync via debounced observation.
 *
 * Adds two derived columns not present in FileRow:
 * - `path`: materialized POSIX path computed from the parentId chain
 * - `content`: serialized text from the per-file Y.Doc (null for folders)
 */
export const files = sqliteTable(
	'files',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		parentId: text('parent_id'),
		type: text('type').notNull(),
		path: text('path'),
		size: integer('size').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		trashedAt: integer('trashed_at'),
		content: text('content'),
	},
	(t) => [
		index('parent_idx').on(t.parentId),
		index('type_idx').on(t.type),
		index('path_idx').on(t.path),
		index('updated_idx').on(t.updatedAt),
	],
);
