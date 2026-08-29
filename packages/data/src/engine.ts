/**
 * The construction seam: a store over a synchronous SQLite the caller opened
 * itself.
 *
 * Not the public story. An application opens its data through a runtime's
 * opener (`@epicenter/data/browser`), which owns the address, the claim, the
 * format enforcement, and deletion. This entry point exists for runtimes that
 * have no named opener: today that is exclusively test infrastructure inside
 * `workerd`, where the only synchronous SQLite is a Durable Object's own
 * storage (the sync-lab peer, the server store probe), the in-package
 * benches, and a test that needs two releases over one durable record. If a
 * production runtime ever needs to open a store this way, that is the moment
 * it earns a named opener beside the others, not a reason to reach here.
 *
 * Account stores only. A local store declares `replication: 'none'`, and every
 * runtime that reaches this seam is a sync peer, so there has never been a
 * caller for one and there is no shape of caller that would want it.
 * `createLocalStore` stays in `store/store.js` for the tests that construct one
 * directly.
 */

/**
 * The packing an artifact's consumer still has to do, until it does not.
 *
 * `readArtifact` returns documents (ADR-0286) and today's store accepts one
 * envelope, so a caller bridging the two needs this. It is exported HERE, on
 * the seam that exists for test infrastructure and dies with the transport,
 * rather than given a subpath of its own that would outlive its reason.
 */
export { encodeEnvelope } from './store/envelope.js';
export {
	type CreateStoreOptions,
	createAccountStore,
	syncEngineOf,
} from './store/store.js';
