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
 * needs a peer that holds a real Store, and a Store needs SQLite, which inside
 * `workerd` means a Durable Object. That peer is a test harness, not a browser
 * simulation: it shares one DO SQLite database where a browser uses IndexedDB
 * plus an in-memory projection. `worker/test-entry.ts` adds it without putting
 * it in `wrangler.jsonc`, so nothing deployable changes.
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
					TEST_PEER: { className: 'SyncLabTestPeer', useSQLite: true },
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
