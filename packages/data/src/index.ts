/**
 * What a developer gets from `@epicenter/data`.
 *
 * The store, the transport that carries it, and the vocabulary a data
 * definition is declared in. Openers live at their own entry points, because
 * one imports `bun:sqlite` and the other imports a WASM build, and neither
 * belongs in a barrel the other has to load.
 *
 * The entry points: `.` for the surface, `./browser` for the opener, `./sync`
 * for the transport, `./export` for the artifact a person keeps, `./engine`
 * for the construction seam test fixtures build on, and `./memory` for test
 * support. The superseded stack that used to answer at `./legacy` was deleted
 * along with its consumers (ADR-0227), so a developer arriving here finds one
 * store rather than a choice between two.
 *
 * Every opener takes the definition, because its id names the store it opens
 * (ADR-0229). The subpath already says which runtime, so the identifier does
 * not repeat it.
 *
 * The transport answers at `./sync` and nowhere else. This barrel used to
 * re-export all of it as well, which no consumer ever used: every one of them
 * imports `@epicenter/data/sync` by name.
 */

export type {
	ConformanceIssue,
	DataDefinition,
	DataDefinitionJson,
	JsonObject,
	JsonValue,
	RowAddress,
	RowOf,
} from './definition/index.js';
export {
	DataDefinitionParseError,
	defineData,
	defineKv,
	defineTable,
	documentAddress,
	field,
	parseData,
} from './definition/index.js';
export type {
	DocumentError,
	RowDocumentHandle,
} from './store/documents.js';
export {
	decodeEnvelope,
	encodeEnvelope,
	type EnvelopeError,
	type EnvelopeSection,
} from './store/envelope.js';
export { APP_DOCUMENT, SNAPSHOT_FOLD_THRESHOLD } from './store/log.js';
export type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
	PersistenceCapability,
	PersistenceStatus,
} from './store/persistence.js';
export {
	type AccountStore,
	type ApplyFailedError,
	type DataStoreBase,
	type DataView,
	type DataOf,
	type LocalStore,
	type KvHandle,
	type NonconformingRow,
	type NonconformingValue,
	type Row,
	type RowAbsentError,
	StoreError,
	type StorePressure,
	type StoredData,
	StoreUnusableError,
	type SyncCapability,
	type SyncFacts,
	type TableHandle,
	type TableInvalidation,
	type TableInvalidationListener,
	type TypedTableHandle,
	type UnstampableError,
	type UpdateRowError,
} from './store/store.js';
