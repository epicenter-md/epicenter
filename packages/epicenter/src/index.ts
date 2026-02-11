/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides shared utilities used by both workspace systems.
 * Import from subpaths to choose your workspace API:
 *
 * - `@epicenter/hq/dynamic` - Field-based schema system (Notion-like)
 * - `@epicenter/hq/static` - Standard Schema with versioning
 * - `@epicenter/hq/extensions` - All extensions (persistence, sqlite, etc.)
 *
 * @example
 * ```typescript
 * // Dynamic (field-based schema)
 * import { createWorkspace, id, text, select } from '@epicenter/hq/dynamic';
 * import { sqlite, webPersistence } from '@epicenter/hq/extensions';
 *
 * // Static (Standard Schema with versioning)
 * import { createWorkspace, defineTable } from '@epicenter/hq/static';
 * import { type } from 'arktype';
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { Action, Actions, Mutation, Query } from './shared/actions';
export {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// LIFECYCLE PROTOCOL
// ════════════════════════════════════════════════════════════════════════════

export {
	defineExports,
	type Lifecycle,
	type MaybePromise,
} from './shared/lifecycle';

// ════════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { ExtensionError } from './shared/errors';
export { ExtensionErr } from './shared/errors';

// ════════════════════════════════════════════════════════════════════════════
// CORE TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { AbsolutePath, ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from './shared/ydoc-keys';
export { KV_KEY, TableKey } from './shared/ydoc-keys';

// ════════════════════════════════════════════════════════════════════════════
// DRIZZLE RE-EXPORTS
// ════════════════════════════════════════════════════════════════════════════

// Commonly used Drizzle utilities for querying extensions
export {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	or,
	sql,
} from 'drizzle-orm';
