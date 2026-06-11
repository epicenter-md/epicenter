/**
 * Storage-efficient key-value primitives over Y.Array.
 *
 * - {@link YKeyValue}: positional (rightmost-wins) conflict resolution.
 * - {@link YKeyValueLww}: timestamp-based last-write-wins.
 *
 * Both are unencrypted Yjs primitives. The encrypted wrapper composes
 * over `YKeyValueLww` and lives in `@epicenter/workspace`.
 *
 * Both implement the shared {@link ObservableKvStore} interface, which is what
 * consumers like `createTable` / `createKv` depend on.
 */
export {
	YKeyValue,
	type YKeyValueChange,
	type YKeyValueChangeHandler,
	type YKeyValueEntry,
} from './_reference/y-keyvalue.js';
export type {
	KvEntry,
	KvStoreChange,
	KvStoreChangeHandler,
	ObservableKvStore,
} from './observable-kv-store.js';
export { YKeyValueLww, type YKeyValueLwwEntry } from './y-keyvalue-lww.js';
