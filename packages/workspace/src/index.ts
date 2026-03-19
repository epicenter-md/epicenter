/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the full workspace API and shared utilities.
 *
 * - `@epicenter/workspace` - Full API (workspace creation, tables, KV, extensions)
 * - `@epicenter/workspace/static` - Alias (kept for backward compatibility)
 * - `@epicenter/workspace/extensions` - Extension plugins (persistence, sync)
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
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

export type {
	Extension,
	Lifecycle,
	MaybePromise,
	} from './workspace/lifecycle';
export type { DocumentContext } from './workspace/types';

// ════════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ════════════════════════════════════════════════════════════════════════════

export { ExtensionError } from './shared/errors';

// ════════════════════════════════════════════════════════════════════════════
// CORE TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { AbsolutePath, ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type { Guid, Id } from './shared/id';
export { generateGuid, generateId, Id as createId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DATE UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type { DateIsoString, TimezoneId } from './shared/datetime-string';
export { DateTimeString, dateTimeStringNow } from './shared/datetime-string';

// ════════════════════════════════════════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════════════════════════════════════════

export type {
	ContentType,
	RichTextEntry,
	SheetBinding,
	SheetEntry,
	TextEntry,
	TimelineEntry,
} from './timeline';
export {
	computeMidpoint,
	createTimeline,
	generateInitialOrders,
	type Timeline,
} from './timeline';
// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from './workspace/ydoc-keys';
export { KV_KEY, TableKey } from './workspace/ydoc-keys';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './workspace/define-kv';
export { defineTable } from './workspace/define-table';
export { defineWorkspace } from './workspace/define-workspace';

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE CREATION
// ════════════════════════════════════════════════════════════════════════════

export { createWorkspace } from './workspace/create-workspace';
export { DOCUMENTS_ORIGIN } from './workspace/create-document';

// ════════════════════════════════════════════════════════════════════════════
// LOWER-LEVEL APIs (Bring Your Own Y.Doc)
// ════════════════════════════════════════════════════════════════════════════

export { createAwareness } from './workspace/create-awareness';
export { createKv } from './workspace/create-kv';
export { createTables } from './workspace/create-tables';

// ════════════════════════════════════════════════════════════════════════════
// INTROSPECTION
// ════════════════════════════════════════════════════════════════════════════

export type {
	ActionDescriptor,
	SchemaDescriptor,
	WorkspaceDescriptor,
} from './workspace/describe-workspace';
export { describeWorkspace } from './workspace/describe-workspace';

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export { standardSchemaToJsonSchema } from './shared/standard-schema';
export { createUnionSchema } from './workspace/schema-union';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export type {
	AnyWorkspaceClient,
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
	BaseRow,
	DocumentClient,
	DocumentConfig,
	DocumentHandle,
	Documents,
	DocumentsHelper,
	ExtensionContext,
	ExtensionFactory,
	SharedExtensionContext,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvHelper,
	NotFoundResult,
	RowResult,
	TableDefinition,
	TableDefinitions,
	TableHelper,
	TransactionMeta,
	TablesHelper,
	UpdateResult,
	ValidRowResult,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	WorkspaceDefinition,
} from './workspace/types';

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
