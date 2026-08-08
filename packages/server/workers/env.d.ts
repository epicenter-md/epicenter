/**
 * The bindings `vitest.workers.config.ts` mounts, named so a test can hold the
 * Durable Objects as RPC targets rather than reaching them through `fetch`.
 */
import type { StoreAuthority } from '../src/store-sync/authority.js';
import type { StoreTestReplica } from './replica.js';

declare global {
	namespace Cloudflare {
		interface Env {
			STORE_SYNC: DurableObjectNamespace<StoreAuthority>;
			REPLICA: DurableObjectNamespace<StoreTestReplica>;
		}
	}
}
