export type { TableInvalidation } from '@epicenter/lens';
export { type ConformanceIssue, type ConstrainedUpdate, type CreateInputFor, DataReadError, defineLens, defineTable, type FieldsFor, type Lens, type NonconformingRowError, optional, type RowFor, type TableDefinition, type TableDefinitions } from '@epicenter/lens/legacy';
export {
	acceptedDocumentOrigin,
	applyRowDocumentUpdate,
	type DocumentPublishOutcome,
	DocumentPullError,
	type DocumentPullResponse,
	type DocumentSyncIssue,
	encodeRowDocumentState,
	observeRowDocumentUpdates,
	type PublishDocument,
	type PullDocument,
	type RowDocument,
	type RowDocumentConnectionTarget,
} from './documents.js';
export {
	type BoundData,
	type CreateEpicenterOptions,
	createEpicenter,
	type Epicenter,
	type EpicenterSyncSession,
	type LocalEpicenter,
	type TableEntry,
	type TableLens,
	type TableScan,
} from './epicenter.js';
export type {
	RowAddress,
} from './protocol/index.js';
export {
	type Exchange,
	type OpenReplicaOptions,
	openReplica,
	REPLICA_FORMAT_VERSION,
	type Replica,
	ReplicaError,
	type ReplicaMetadata,
} from './replica/index.js';
export type {
	SyncCredentialProvider,
	SyncSchedule,
	SyncState,
	SyncStatus,
} from './sync-supervisor.js';
