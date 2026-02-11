/**
 * Y.Doc type aliases and constants for Workspace documents.
 *
 * This module contains the low-level Yjs structure definitions for workspace data.
 * For creating workspaces, use `createWorkspace()` from the `workspace` module.
 *
 * @module
 */

import type * as Y from 'yjs';
import type { KvValue } from './schema/fields/types';

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Top-Level Map Names
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Y.Map Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Y.Map storing cell values for a single row, keyed by column name. */
export type RowYMap = Y.Map<unknown>;

/** Y.Map storing rows for a single table, keyed by row ID. */
export type TableYMap = Y.Map<RowYMap>;

/** Y.Map storing all tables, keyed by table name. */
export type TablesYMap = Y.Map<TableYMap>;

/** Y.Array storing KV values as LWW entries (key, val, ts). */
export type KvYArray = Y.Array<{ key: string; val: KvValue; ts: number }>;
