/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * A unified architecture for building self-contained, globally synchronizable workspaces
 * with real-time collaboration via YJS.
 *
 * ## Core Concepts
 *
 * - **YJS Document**: Source of truth (CRDT, collaborative)
 * - **Indexes**: Synchronized snapshots for different query patterns
 * - **Column Schemas**: Pure JSON definitions (no Drizzle builders)
 *
 * ## Data Flow
 *
 * Write to YJS → Indexes auto-sync → Query indexes
 */

// Re-export commonly used Drizzle utilities for querying indexes
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
export type {
	Action,
	Mutation,
	Query,
	WorkspaceActionMap,
	WorkspaceExports,
} from './core/actions';
// Action helpers
export {
	defineMutation,
	defineQuery,
	defineWorkspaceExports,
	extractActions,
	isAction,
	isMutation,
	isNamespace,
	isQuery,
	walkActions,
} from './core/actions';
export type { Db, TableHelper } from './core/db/core';
// Database utilities
export { createEpicenterDb } from './core/db/core';
export type {
	RowAlreadyExistsError,
	RowNotFoundError,
	YRow,
} from './core/db/table-helper';
export {
	RowAlreadyExistsErr,
	RowNotFoundErr,
} from './core/db/table-helper';
export type { ActionInfo, EpicenterClient, EpicenterConfig } from './core/epicenter';
// Epicenter - compose multiple workspaces
export {
	createEpicenterClient,
	defineEpicenter,
	iterActions,
} from './core/epicenter';
export type {
	EpicenterOperationError,
	IndexError,
	ValidationError,
} from './core/errors';
// Error types
export {
	EpicenterOperationErr,
	IndexErr,
	ValidationErr,
} from './core/errors';
export type {
	Index,
	IndexContext,
	IndexExports,
	WorkspaceIndexMap,
} from './core/indexes';
// Index system
export { defineIndexExports } from './core/indexes';
export type {
	BooleanColumnSchema,
	CellValue,
	ColumnSchema,
	ColumnType,
	DateColumnSchema,
	DateIsoString,
	DateWithTimezoneString,
	Id,
	IdColumnSchema,
	IntegerColumnSchema,
	JsonColumnSchema,
	PartialSerializedRow,
	RealColumnSchema,
	Row,
	SelectColumnSchema,
	SerializedCellValue,
	SerializedRow,
	TableSchema,
	TableValidators,
	TagsColumnSchema,
	TextColumnSchema,
	TimezoneId,
	WorkspaceSchema,
	WorkspaceValidators,
	YtextColumnSchema,
} from './core/schema';
// Column schema system
export {
	boolean,
	createTableValidators,
	createWorkspaceValidators,
	DATE_WITH_TIMEZONE_STRING_REGEX,
	DateWithTimezone,
	DateWithTimezoneFromString,
	date,
	generateId,
	ISO_DATETIME_REGEX,
	id,
	integer,
	isDateWithTimezone,
	isDateWithTimezoneString,
	isIsoDateTimeString,
	json,
	real,
	select,
	serializeCellValue,
	TIMEZONE_ID_REGEX,
	tags,
	text,
	ytext,
} from './core/schema';
// Core types
export type { AbsolutePath, EpicenterDir, StorageDir } from './core/types';
export type {
	AnyWorkspaceConfig,
	Provider,
	ProviderContext,
	WorkspaceClient,
	WorkspaceConfig,
	WorkspacesToClients,
	WorkspacesToExports,
} from './core/workspace';
// Core workspace definition
// Runtime
export { createWorkspaceClient, defineWorkspace } from './core/workspace';
export type {
	MarkdownIndexConfig,
	TableMarkdownConfig,
	WithBodyFieldOptions,
} from './indexes/markdown';
export {
	DEFAULT_TABLE_CONFIG,
	markdownIndex,
	withBodyField,
} from './indexes/markdown';
// Indexes (implementations)
export { sqliteIndex } from './indexes/sqlite';

// Blob storage
export {
	BlobErr,
	createTableBlobStore,
	createWorkspaceBlobs,
	validateFilename,
} from './core/blobs';
export type {
	BlobContext,
	BlobData,
	BlobError,
	BlobErrorCode,
	BlobStoreContext,
	TableBlobStore,
	WorkspaceBlobs,
} from './core/blobs';

// Server - expose workspaces as REST API and MCP servers
export { createServer } from './server';
