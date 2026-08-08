/**
 * What a developer gets from `@epicenter/data`.
 *
 * The store, the transport that carries it, and the vocabulary a Lens is
 * written in. Runtime openers live at their own entry points, because a Bun
 * opener imports `bun:sqlite` and a browser opener imports a WASM build, and
 * neither belongs in a barrel the other has to load.
 *
 * The superseded stack is at `@epicenter/data/legacy`. It is what Whispering,
 * vocab, tab-manager and skills still run on, and it stays exactly where it was
 * until they move; what changed is that it no longer answers to the package's
 * own name, so a developer arriving at `@epicenter/data` gets the thing that is
 * being built rather than the thing being replaced.
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
export type { OutboxEntry } from './persistence.js';
export {
	defineLens,
	type LensJson,
	type LensParseError,
	type NonconformingRowError,
	parseLens,
	type RowOf,
	RowWriteError,
} from '@epicenter/lens/lens';
export type { JsonObject, JsonValue, RowAddress } from '@epicenter/lens';
export * from '../sync/index.js';
