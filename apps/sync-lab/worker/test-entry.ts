/**
 * THROWAWAY, and test-only: the worker `vitest` mounts.
 *
 * `SyncLabAuthority` is re-exported rather than redefined, so the class the test
 * hibernates is byte for byte the one `wrangler deploy` ships. The only addition
 * is `SyncLabReplica`, which exists because a replica needs SQLite and inside
 * `workerd` that means a Durable Object; keeping it here rather than in
 * `worker/index.ts` is what stops a test-only class from reaching the
 * deployable.
 */
export { SyncLabAuthority } from './index.js';
export { SyncLabReplica } from './replica.js';

export default {
	// Nothing routes through the entrypoint: the tests hold stubs directly. It
	// exists because a modules worker must have one.
	fetch(): Response {
		return new Response('sync-lab tests drive the Durable Objects directly', {
			status: 404,
		});
	},
};
