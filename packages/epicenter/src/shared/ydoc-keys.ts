/**
 * Y.Doc Array Key Conventions
 *
 * Workspace data is stored in Y.Arrays with these key patterns:
 * - Tables: `table:{tableName}` (one array per table)
 * - KV: `'kv'` (single array for all settings)
 *
 * These prefixes are reserved. Do not create Y.Doc arrays with
 * keys matching these patterns outside of the workspace system.
 *
 * @example
 * ```typescript
 * import { KV_KEY, TableKey } from './ydoc-keys';
 *
 * const kvArray = ydoc.getArray(KV_KEY);           // 'kv'
 * const postsArray = ydoc.getArray(TableKey('posts')); // 'table:posts'
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// KV Key
// ════════════════════════════════════════════════════════════════════════════

/** Key type for the KV settings array. */
export type KvKey = 'kv';

/** The KV settings array key. */
export const KV_KEY: KvKey = 'kv';

// ════════════════════════════════════════════════════════════════════════════
// Table Key
// ════════════════════════════════════════════════════════════════════════════

/** Key type for table arrays: `table:{tableName}`. */
export type TableKey<T extends string = string> = `table:${T}`;

/**
 * Create a table array key from a table name.
 *
 * The generic preserves the literal type when called with a string literal,
 * enabling precise type inference.
 *
 * @param name - The table name
 * @returns The table array key in format `table:{name}`
 *
 * @example
 * ```typescript
 * const key = TableKey('posts');
 * // Type: 'table:posts' (literal, not just `table:${string}`)
 *
 * const arr = ydoc.getArray(key);
 * ```
 */
export function TableKey<T extends string>(name: T): TableKey<T> {
	return `table:${name}`;
}
