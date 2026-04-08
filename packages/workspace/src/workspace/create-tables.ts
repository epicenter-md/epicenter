/**
 * createTables() - Internal convenience for binding table definitions to an existing Y.Doc.
 *
 * Not part of the public API. Used by tests that need lightweight table setup
 * without full createWorkspace ceremony. createWorkspace inlines this logic
 * directly so it can retain store references for encryption coordination.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { defineTable } from '@epicenter/workspace';
 * import { createTables } from './create-tables.js';
 * import { type } from 'arktype';
 *
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const tables = createTables(ydoc, { users, posts });
 *
 * tables.users.set({ id: '1', email: 'test@example.com', _v: 1 });
 * tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
 * ```
 */

import type * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createTable } from './create-table.js';
import type {
	BaseRow,
	TableDefinitions,
	TableHelper,
	TablesHelper,
} from './types.js';
import { TableKey } from './ydoc-keys.js';

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
	const helpers: Record<string, TableHelper<BaseRow>> = {};

	for (const [name, definition] of Object.entries(definitions)) {
		// Each table gets its own encrypted KV store (passthrough when no key)
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const ykv = createEncryptedYkvLww(yarray);

		helpers[name] = createTable(ykv, definition);
	}

	return helpers as TablesHelper<TTableDefinitions>;
}
