/**
 * THROWAWAY, and the only place in this repository that runs `workerd`.
 *
 * `wrangler dev` will not evict a Durable Object on demand, so the wake path in
 * `worker/index.ts` could only ever be reached by waiting on Cloudflare's own
 * eviction timer against a deployed object. `@cloudflare/vitest-pool-workers`
 * exposes `evictDurableObject`, which tears the instance down while hibernating
 * its WebSockets, which is exactly the transition under test.
 *
 * The entrypoint is NOT `worker/index.ts`. The tested class is, but a test also
 * needs replicas that hold a real store, and a store needs SQLite, which inside
 * `workerd` means a Durable Object. `worker/test-entry.ts` adds that second
 * class without putting it in `wrangler.jsonc`, so nothing deployable changes.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './worker/test-entry.ts',
			miniflare: {
				compatibilityDate: '2026-03-06',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					SYNC: { className: 'SyncLabAuthority', useSQLite: true },
					REPLICA: { className: 'SyncLabReplica', useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ['worker/**/*.test.ts'],
		// A hibernation cycle is real time in a real runtime, and the convergence
		// waits poll rather than guess.
		testTimeout: 30_000,
	},
});
