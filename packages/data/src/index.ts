/**
 * What a developer gets from `@epicenter/data`.
 *
 * The store, the transport that carries it, and the vocabulary a database is
 * declared in. Runtime openers live at their own entry points, because a Bun
 * opener imports `bun:sqlite` and a browser opener imports a WASM build, and
 * neither belongs in a barrel the other has to load.
 *
 * The entry points: `.` for the surface, `./bun` and `./browser` for the
 * openers, `./sync` for the transport, `./projection` for the composed SQL
 * follower, and `./engine` for the construction seam test fixtures build on.
 * The superseded stack that used to answer at `./legacy` was deleted along
 * with its consumers (ADR-0227), so a developer arriving here finds one store
 * rather than a choice between two.
 *
 * Each opener is called `open` and takes the database, because a database
 * names the store it opens (ADR-0229). The subpath already says which adapter,
 * so the identifier does not repeat it.
 *
 * The transport answers at `./sync` and nowhere else. This barrel used to
 * re-export all of it as well, which no consumer ever used: every one of them
 * imports `@epicenter/data/sync` by name.
 */

export type {
	ConformanceIssue,
	JsonObject,
	JsonValue,
	RowAddress,
} from '@epicenter/database';
export {
	type DatabaseJson,
	type DatabaseParseError,
	defineDatabase,
	defineKv,
	defineTable,
	parseDatabase,
	type RowOf,
	RowWriteError,
} from '@epicenter/database';
export { SNAPSHOT_FOLD_THRESHOLD } from './store/log.js';
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
	type DatabaseStoreBase,
	type DatabaseView,
	type DataOf,
	type DeviceStore,
	type KvHandle,
	type NonconformingRow,
	type NonconformingValue,
	type Row,
	type RowAbsentError,
	type RowDocument,
	StoreError,
	type StorePressure,
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
