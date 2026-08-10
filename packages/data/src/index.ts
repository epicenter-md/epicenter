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
 *
 * Each opener is called `open` and takes the lens, because a lens names the
 * store it opens (ADR-0229). The subpath already says which adapter, so the
 * identifier does not repeat it.
 *
 * The transport answers at `./sync` and nowhere else. This barrel used to
 * re-export all of it as well, which no consumer ever used: every one of them
 * imports `@epicenter/data/sync` by name.
 */

export type { JsonObject, JsonValue, RowAddress } from '@epicenter/lens';
export {
	defineLens,
	type LensJson,
	type LensParseError,
	type NonconformingRowError,
	parseLens,
	type RowOf,
	RowWriteError,
} from '@epicenter/lens';
export { COMPACTION_THRESHOLD, type OutboxEntry } from './store/log.js';
export {
	type ApplicationOf,
	asApplication,
	type ClientLog,
	createStore,
	type KvHandle,
	type LensView,
	type QueryMethod,
	type ReadRowError,
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
} from './store/store.js';
