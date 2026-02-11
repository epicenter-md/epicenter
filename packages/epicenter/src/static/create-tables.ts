/**
 * createTables() - Lower-level API for binding table definitions to an existing Y.Doc.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createTables, defineTable } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string' }));
 *
 * // Builder pattern for multiple versions with migration (use _v discriminant)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '"1"' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     if (row._v === '1') return { ...row, views: 0, _v: '2' };
 *     return row;
 *   });
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const tables = createTables(ydoc, { users, posts });
 *
 * tables.users.set({ id: '1', email: 'test@example.com' });
 * tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
 * ```
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { TableKey } from '../shared/ydoc-keys.js';
import { createTableHelper } from './table-helper.js';
import type {
	InferTableRow,
	TableDefinition,
	TableDefinitions,
	TableHelper,
	TablesHelper,
} from './types.js';

/**
 * Binds table definitions to an existing Y.Doc.
 *
 * Creates a TablesHelper object with a TableHelper for each table definition.
 * Tables are stored in the Y.Doc under `table:{tableName}` arrays.
 *
 * @param ydoc - The Y.Doc to bind tables to
 * @param definitions - Map of table name to TableDefinition
 * @returns TablesHelper with type-safe access to each table
 */
export function createTables<TTableDefinitions extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: TTableDefinitions,
): TablesHelper<TTableDefinitions> {
	const helpers: Record<string, TableHelper<{ id: string }>> = {};

	for (const [name, definition] of Object.entries(definitions)) {
		// Each table gets its own Y.Array for isolation
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const ykv = new YKeyValueLww(yarray);

		helpers[name] = createTableHelper(ykv, definition);
	}

	return helpers as TablesHelper<TTableDefinitions>;
}

// Re-export types for convenience
export type { InferTableRow, TableDefinition, TableDefinitions, TablesHelper };
