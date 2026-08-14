/**
 * The construction seam: a store over a synchronous SQLite the caller opened
 * itself.
 *
 * Not the public story. An application opens its data through a runtime's
 * opener (`@epicenter/data/browser`, `@epicenter/data/bun`), which owns the
 * address, the claim, the format enforcement, and deletion. This entry point
 * exists for runtimes that have no named opener: today that is exclusively
 * test infrastructure inside `workerd`, where the only synchronous SQLite is
 * a Durable Object's own storage (the sync-lab peer, the server store probe)
 * and the in-package benches. If a production runtime ever needs to open a
 * store this way, that is the moment it earns a named opener beside the
 * others, not a reason to reach here.
 */
export {
	createAccountStore,
	createDeviceStore,
	type CreateStoreOptions,
	syncEngineOf,
} from './store/store.js';
