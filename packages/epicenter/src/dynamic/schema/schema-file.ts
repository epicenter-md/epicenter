/**
 * Schema File Utilities
 *
 * Functions for loading and saving external schema JSON files.
 *
 * Schema files define the "lens" through which you view workspace data.
 * They are stored separately from the Y.Doc and are NOT synced via CRDT.
 *
 * File structure:
 * ```
 * {workspaceId}/definition.json   # Schema definitions (local only)
 * {workspaceId}/
 *   workspace.yjs           # CRDT data (synced)
 * ```
 *
 * @packageDocumentation
 */

import type { TableDefinition } from './fields/types';

/**
 * Get a table by its ID from an array of tables.
 *
 * @param tables - The array of table definitions to search
 * @param tableId - The ID of the table to find
 * @returns The table definition if found, undefined otherwise
 */
export function getTableById(
	tables: readonly TableDefinition[],
	tableId: string,
) {
	return tables.find((t) => t.id === tableId);
}
