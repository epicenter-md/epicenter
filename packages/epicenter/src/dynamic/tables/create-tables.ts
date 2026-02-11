import type * as Y from 'yjs';
import type { TableDefinition } from '../schema';
import type { TableById } from '../schema/fields/types';
import { createTableHelper, type TableHelper } from './table-helper';

// Re-export types for public API
export type {
	GetResult,
	InvalidRowResult,
	RowResult,
	TableHelper,
	ValidRowResult,
} from './table-helper';

/**
 * Object type for accessing tables.
 *
 * The tables object provides table access via `tables.get('posts')`.
 * Utility methods are properties: `tables.has()`, `tables.names()`, etc.
 *
 * This pattern eliminates collision risk between user-defined table names and
 * utility methods, since user names only appear as method arguments.
 */
export type TablesFunction<
	TTableDefinitions extends readonly TableDefinition[],
> = {
	// ════════════════════════════════════════════════════════════════════
	// TABLE ACCESS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Get a table helper by name.
	 *
	 * Only tables defined in the schema are accessible. Throws an error
	 * if the table name is not found in the definition.
	 *
	 * @example
	 * ```typescript
	 * tables.get('posts').getAll()  // Row[] - fully typed
	 * ```
	 *
	 * @throws Error if the table name is not in the definition
	 */
	get<K extends TTableDefinitions[number]['id']>(
		name: K,
	): TableHelper<string, TableById<TTableDefinitions, K>['fields']>;

	// ════════════════════════════════════════════════════════════════════
	// EXISTENCE & ENUMERATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Check if a defined table has any data in YJS storage.
	 *
	 * Only checks tables that are in the definition. Returns false for
	 * tables not in the definition.
	 */
	has(name: string): boolean;

	/**
	 * Get all defined table names that have data in YJS storage.
	 */
	names(): string[];

	// ════════════════════════════════════════════════════════════════════
	// BULK OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Clear all rows in defined tables.
	 */
	clear(): void;

	// ════════════════════════════════════════════════════════════════════
	// METADATA
	// ════════════════════════════════════════════════════════════════════

	/**
	 * The raw table definitions passed to createTables.
	 */
	definitions: TTableDefinitions;

	// ════════════════════════════════════════════════════════════════════
	// UTILITIES
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Serialize all tables to JSON.
	 */
	toJSON(): Record<string, unknown[]>;
};

/**
 * Create an Epicenter database wrapper with table helpers from an existing Y.Doc.
 * This is a pure function that doesn't handle persistence - it only wraps
 * the Y.Doc with type-safe table operations.
 *
 * The returned object provides table access via the `.get()` method.
 * Utility methods are properties on the object itself.
 *
 * ## API Design
 *
 * Tables are accessed via: `tables.get('posts')`.
 * Utilities are properties: `tables.has()`, `tables.clear()`, etc.
 * This eliminates collision risk between user table names and utility methods.
 *
 * @param ydoc - An existing Y.Doc instance (already loaded/initialized)
 * @param tableDefinitions - Table definitions (use `table()` helper for ergonomic definitions)
 * @returns Object with table helpers and utility methods
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc({ guid: 'workspace-123' });
 * const tables = createTables(ydoc, [
 *   table({
 *     id: 'posts',
 *     name: 'Posts',
 *     fields: [id(), text({ id: 'title' }), boolean({ id: 'published' })],
 *   }),
 *   table({
 *     id: 'users',
 *     name: 'Users',
 *     description: 'User accounts',
 *     icon: '👤',
 *     fields: [id(), text({ id: 'name' }), boolean({ id: 'active' })],
 *   }),
 * ]);
 *
 * // Tables are accessed via get()
 * tables.get('posts').upsert({ id: '1', title: 'Hello', published: false });
 * tables.get('posts').getAll();
 *
 * // Clear all tables
 * tables.clear();
 *
 * // With destructuring (unchanged ergonomics)
 * const posts = tables.get('posts');
 * posts.upsert({ id: '1', title: 'Hello', published: false });
 * ```
 */
export function createTables<
	const TTableDefinitions extends readonly TableDefinition[],
>(
	ydoc: Y.Doc,
	tableDefinitions: TTableDefinitions,
): TablesFunction<TTableDefinitions> {
	// Build helpers map from array of table definitions
	const tableHelpers = Object.fromEntries(
		tableDefinitions.map((tableDefinition) => [
			tableDefinition.id,
			createTableHelper({
				ydoc,
				tableDefinition,
			}),
		]),
	) as {
		[K in TTableDefinitions[number]['id']]: TableHelper<
			string,
			TableById<TTableDefinitions, K>['fields']
		>;
	};

	// ════════════════════════════════════════════════════════════════════
	// BUILD TABLES OBJECT WITH METHODS
	// ════════════════════════════════════════════════════════════════════

	return {
		// ════════════════════════════════════════════════════════════════════
		// TABLE ACCESS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Get a table helper by name.
		 *
		 * Only tables defined in the schema are accessible.
		 *
		 * @example
		 * ```typescript
		 * tables.get('posts').upsert({ id: '1', title: 'Hello' });
		 * tables.get('posts').getAll();
		 * ```
		 *
		 * @throws Error if the table name is not in the definition
		 */
		get(
			name: string,
		): TableHelper<
			string,
			Extract<TTableDefinitions[number], { id: string }>['fields']
		> {
			if (name in tableHelpers) {
				return tableHelpers[name as keyof typeof tableHelpers];
			}
			throw new Error(
				`Table '${name}' not found in workspace definition. ` +
					`Available tables: ${tableDefinitions.map((t) => t.id).join(', ')}.`,
			);
		},

		// ════════════════════════════════════════════════════════════════════
		// EXISTENCE & ENUMERATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Check if a defined table has any data in YJS storage.
		 *
		 * Returns false for tables not in the definition.
		 * For defined tables, checks if the table's Y.Array has any rows.
		 *
		 * @example
		 * ```typescript
		 * if (tables.has('posts')) {
		 *   const rows = tables.get('posts').getAll()
		 * }
		 * ```
		 */
		has(name: string): boolean {
			if (name in tableHelpers) {
				return tableHelpers[name as keyof typeof tableHelpers].count() > 0;
			}
			return false;
		},

		/**
		 * Get all defined table names that have data in YJS storage.
		 *
		 * Returns names of defined tables that have at least one row.
		 * Empty tables are not returned.
		 *
		 * @example
		 * ```typescript
		 * tables.names()  // ['posts', 'users'] - only tables with data
		 * ```
		 */
		names(): string[] {
			const names: string[] = [];
			for (const tableDef of tableDefinitions) {
				if (
					tableHelpers[tableDef.id as keyof typeof tableHelpers].count() > 0
				) {
					names.push(tableDef.id);
				}
			}
			return names;
		},

		// ════════════════════════════════════════════════════════════════════
		// BULK OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Clear all rows in all defined tables.
		 */
		clear(): void {
			ydoc.transact(() => {
				for (const tableDef of tableDefinitions) {
					tableHelpers[tableDef.id as keyof typeof tableHelpers].clear();
				}
			});
		},

		// ════════════════════════════════════════════════════════════════════
		// METADATA & ESCAPE HATCHES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * The raw table definitions passed to createTables.
		 *
		 * Provides access to the table definitions including metadata
		 * (name, icon, description) and field schemas.
		 *
		 * @example
		 * ```typescript
		 * tables.definitions.posts.fields  // { id: {...}, title: {...} }
		 * ```
		 */
		definitions: tableDefinitions,

		// ════════════════════════════════════════════════════════════════════
		// UTILITIES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Serialize all defined tables to JSON.
		 *
		 * Returns an object where keys are table names and values are arrays
		 * of rows (as plain objects). Only includes tables with data.
		 *
		 * @example
		 * ```typescript
		 * const data = tables.toJSON();
		 * // { posts: [{ id: '1', title: 'Hello' }], users: [...] }
		 * ```
		 */
		toJSON(): Record<string, unknown[]> {
			const result: Record<string, unknown[]> = {};
			for (const tableDef of tableDefinitions) {
				const helper = tableHelpers[tableDef.id as keyof typeof tableHelpers];
				const rows = helper.getAllValid();
				if (rows.length > 0) {
					result[tableDef.id] = rows;
				}
			}
			return result;
		},
	} as TablesFunction<TTableDefinitions>;
}

/**
 * Type alias for the return type of createTables.
 * Useful for typing function parameters that accept a tables instance.
 */
export type Tables<TTableDefinitions extends readonly TableDefinition[]> =
	ReturnType<typeof createTables<TTableDefinitions>>;
