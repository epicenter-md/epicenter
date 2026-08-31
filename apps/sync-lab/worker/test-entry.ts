/**
 * THROWAWAY, and test-only: the worker `vitest` mounts.
 *
 * `SyncLabAuthority` is re-exported rather than redefined, so the class the test
 * hibernates is byte for byte the one `wrangler deploy` ships. The only addition
 * is `SyncLabTestPeer`, a Worker-runtime client harness. It exists because a
 * Store needs synchronous SQLite and inside `workerd` that means a Durable
 * Object. Its deliberately shared durable-record/projection database is a test
 * harness detail, not the browser client's storage design. Keeping it here
 * rather than in `worker/index.ts` stops it reaching the deployable.
 */
export { SyncLabAuthority } from './index.js';
export { SyncLabTestPeer } from './test-peer.js';

export default {
	// Nothing routes through the entrypoint: the tests hold stubs directly. It
	// exists because a modules worker must have one.
	fetch(): Response {
		return new Response('sync-lab tests drive the Durable Objects directly', {
			status: 404,
		});
	},
};
