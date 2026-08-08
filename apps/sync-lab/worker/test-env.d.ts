/**
 * The bindings `vitest.config.ts` mounts, named so a test can call the Durable
 * Objects as RPC targets rather than through `fetch`.
 */
import type { SyncLabAuthority } from './index.js';
import type { SyncLabReplica } from './replica.js';

declare global {
	namespace Cloudflare {
		interface Env {
			SYNC: DurableObjectNamespace<SyncLabAuthority>;
			REPLICA: DurableObjectNamespace<SyncLabReplica>;
		}
	}
}
