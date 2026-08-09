/**
 * What a developer gets from `@epicenter/data`.
 *
 * The store, the transport that carries it, and the vocabulary a Lens is
 * written in. Runtime openers live at their own entry points, because a Bun
 * opener imports `bun:sqlite` and a browser opener imports a WASM build, and
 * neither belongs in a barrel the other has to load.
 *
 * Four entry points and no more: `.` for the surface, `./bun` and `./browser`
 * for the openers, and `./sync` for the transport. The superseded stack that
 * used to answer at `./legacy` was deleted along with its consumers (ADR-0227),
 * so a developer arriving here finds one store rather than a choice between
 * two.
 */
export {
	type Bound,
	type BoundOf,
	type ClientLog,
	createStore,
	type KvHandle,
	type QueryMethod,
	type ReadRowError,
	remoteOrigin,
	type Row,
	type RowDocument,
	type Store,
	StoreError,
	type StorePressure,
	type TableHandle,
	type TableInvalidation,
	type TableInvalidationListener,
	type TypedTableHandle,
	type WriteRowError,
} from './store.js';
export { COMPACTION_THRESHOLD, type OutboxEntry } from './persistence.js';
export { defineLens, type LensJson, type LensParseError, type NonconformingRowError, parseLens, type RowOf, RowWriteError } from '@epicenter/lens';
export type { JsonObject, JsonValue, RowAddress } from '@epicenter/lens';
export * from '../sync/index.js';
