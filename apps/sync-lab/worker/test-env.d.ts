/**
 * The bindings `vitest.config.ts` mounts, named so a test can call the Durable
 * Objects as RPC targets rather than through `fetch`.
 */
import type { SyncLabAuthority } from './index.js';
import type { SyncLabTestPeer } from './test-peer.js';

declare global {
	namespace Cloudflare {
		interface Env {
			SYNC: DurableObjectNamespace<SyncLabAuthority>;
			TEST_PEER: DurableObjectNamespace<SyncLabTestPeer>;
		}
	}
}
