import * as Y from 'yjs';
import type { WorkspaceSchema } from '../schema';
import { createWorkspaceValidators } from '../schema';
import {
	createTableHelpers,
	type TableHelper,
	type YRow,
} from './table-helper';

/**
 * Valid table name pattern: lowercase letters, numbers, and underscores, starting with a letter.
 *
 * Table names must satisfy constraints across three systems:
 *
 * **File System** (markdown index creates directories from table names):
 * - Cross-platform safety: Windows, macOS, and Linux all handle these characters
 * - Case-insensitivity: Windows/macOS treat "Posts" and "posts" as the same directory
 * - Avoids reserved names: No risk of collision with CON, PRN, AUX, NUL, etc.
 *
 * **SQLite** (sqlite index creates tables from table names):
 * - Valid unquoted identifier: No need for "quoted" table names in SQL
 * - Avoids reserved words: Starting with letter + limited charset avoids most conflicts
 * - Case-insensitive by default: Lowercase-only prevents subtle bugs
 *
 * **JavaScript** (table names become object properties for `db.tableName` access):
 * - Valid identifier: Enables dot notation instead of bracket notation
 * - No leading numbers: JS identifiers can't start with digits
 *
 * The pattern `/^[a-z][a-z0-9_]*$/` is the intersection of all three constraint sets.
 *
 * **Why not hyphens?** SQLite requires quoting (`"my-table"`), JS needs brackets (`db['my-table']`)
 * **Why not uppercase?** Case-sensitivity varies; lowercase-only is predictable everywhere
 * **Why start with letter?** SQL/JS identifiers starting with numbers need special handling
 */
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Valid column name pattern: same constraints as table names.
 *
 * Column names appear in the same three systems and have identical requirements:
 * - **SQLite**: Valid unquoted column identifier
 * - **JavaScript**: `row.columnName` dot notation access
 * - **YAML frontmatter**: Markdown index serializes columns to frontmatter keys
 *
 * @see TABLE_NAME_PATTERN for detailed constraint rationale
 */
const COLUMN_NAME_PATTERN = TABLE_NAME_PATTERN;

// Re-export TableHelper for public API
export type { TableHelper } from './table-helper';

/**
 * Create an Epicenter database wrapper with table helpers from an existing Y.Doc.
 * This is a pure function that doesn't handle persistence - it only wraps
 * the Y.Doc with type-safe table operations.
 *
 * ## API Design
 *
 * Tables are accessed directly on the db object. Utilities are prefixed with `$`.
 *
 * **Principle**: Everything with `$` is a utility. Everything without `$` is a table.
 *
 * @param ydoc - An existing Y.Doc instance (already loaded/initialized)
 * @param schema - Table schema definitions
 * @returns Object with flattened table helpers and `$`-prefixed utilities
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc({ guid: 'workspace-123' });
 * const db = createEpicenterDb(ydoc, {
 *   posts: {
 *     id: id(),
 *     title: text(),
 *     published: boolean(),
 *   }
 * });
 *
 * // Tables are accessed directly (no .tables namespace)
 * db.posts.insert({ id: '1', title: 'Hello', published: false });
 * db.posts.getAll();
 *
 * // Utilities are prefixed with $
 * db.$clearAll();
 * db.$transact(() => {
 *   db.posts.insert({ ... });
 *   db.comments.insert({ ... });
 * });
 * ```
 */
export function createEpicenterDb<TWorkspaceSchema extends WorkspaceSchema>(
	ydoc: Y.Doc,
	schema: TWorkspaceSchema,
) {
	// Validate table names
	for (const tableName of Object.keys(schema)) {
		if (tableName.startsWith('$')) {
			throw new Error(
				`Table name "${tableName}" is invalid: cannot start with "$" (reserved for utilities)`,
			);
		}
		if (!TABLE_NAME_PATTERN.test(tableName)) {
			throw new Error(
				`Table name "${tableName}" is invalid: must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (e.g., "posts", "user_sessions", "items2")`,
			);
		}
	}

	// Validate column names for each table
	for (const [tableName, tableSchema] of Object.entries(schema)) {
		for (const columnName of Object.keys(tableSchema)) {
			if (!COLUMN_NAME_PATTERN.test(columnName)) {
				throw new Error(
					`Column name "${columnName}" in table "${tableName}" is invalid: must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (e.g., "title", "created_at", "count2")`,
				);
			}
		}
	}

	// Create validators for all tables
	const validators = createWorkspaceValidators(schema);
	const ytables = ydoc.getMap<Y.Map<YRow>>('tables');

	// Initialize each table as a Y.Map<id, row> (only if not already present)
	// When loading from disk or syncing from network, tables may already exist
	for (const tableName of Object.keys(schema)) {
		if (!ytables.has(tableName)) {
			ytables.set(tableName, new Y.Map<YRow>());
		}
	}

	// Create table helpers
	const tableHelpers = createTableHelpers({
		ydoc,
		schema,
		validators,
		ytables,
	});

	return {
		// Spread table helpers directly onto the object (flattened access)
		...tableHelpers,

		/**
		 * The underlying YJS document.
		 * Exposed for persistence and sync providers.
		 *
		 * **Note**: This is an advanced/internal property. Most users won't need it.
		 */
		$ydoc: ydoc,

		/**
		 * Execute a function within a YJS transaction.
		 *
		 * Transactions bundle changes and ensure atomic updates. All changes within
		 * a transaction are sent as a single update to collaborators.
		 *
		 * **Nested Transactions:**
		 * YJS handles nested $transact() calls safely by reusing the outer transaction.
		 *
		 * @example
		 * ```typescript
		 * // Cross-table transaction
		 * db.$transact(() => {
		 *   db.posts.upsertMany([...]);
		 *   db.comments.insert({ ... });
		 * }, 'bulk-import');
		 * ```
		 */
		$transact(fn: () => void, origin?: string): void {
			ydoc.transact(fn, origin);
		},

		/**
		 * Clear all tables in a single transaction.
		 *
		 * @example
		 * ```typescript
		 * // Clear everything before importing fresh data
		 * db.$clearAll();
		 * db.posts.insertMany(importedPosts);
		 * ```
		 */
		$clearAll(): void {
			ydoc.transact(() => {
				for (const tableName of Object.keys(schema)) {
					tableHelpers[tableName as keyof typeof tableHelpers].clear();
				}
			});
		},

		/**
		 * Get all table helpers as an array for iteration.
		 *
		 * Each table helper includes `name`, `schema`, and `validators` properties,
		 * plus all CRUD operations (insert, update, get, getAll, etc.).
		 *
		 * @example
		 * ```typescript
		 * // Iterate over all tables
		 * for (const table of db.$tables()) {
		 *   console.log(table.name);
		 *   const validator = table.validators.toArktype();
		 *
		 *   table.observe({
		 *     onAdd: (result) => console.log(`Added to ${table.name}:`, result),
		 *   });
		 * }
		 * ```
		 */
		$tables(): TableHelper<TWorkspaceSchema[keyof TWorkspaceSchema]>[] {
			return Object.values(tableHelpers) as TableHelper<
				TWorkspaceSchema[keyof TWorkspaceSchema]
			>[];
		},
	};
}

/**
 * Type alias for the return type of createEpicenterDb.
 * Useful for typing function parameters that accept a database instance.
 *
 * @example
 * ```typescript
 * type MyDb = Db<typeof mySchema>;
 *
 * function doSomething(db: MyDb) {
 *   db.posts.insert(...);  // Direct table access
 *   db.$clearAll();        // Utility access
 * }
 * ```
 */
export type Db<TWorkspaceSchema extends WorkspaceSchema> = ReturnType<
	typeof createEpicenterDb<TWorkspaceSchema>
>;
