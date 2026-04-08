/**
 * Portable contract for the `/auth/get-session` response.
 *
 * Better Auth returns `{ user, session }`. Epicenter enriches that payload with
 * the full encryption keyring (derived per-user keys for every active secret
 * version) so clients can unlock their workspace without a separate round-trip.
 *
 * This file is intentionally runtime-free. Shared consumers should be able to
 * import the contract without pulling in Cloudflare Workers, Drizzle, or the
 * API's auth factory.
 */

import type { EncryptionKeys } from '@epicenter/workspace';
import type { Session, User } from 'better-auth';

/**
 * Canonical `/auth/get-session` response for Epicenter clients.
 *
 * Extends Better Auth's base `{ user, session }` with `encryptionKeys`—the
 * full keyring of derived per-user keys so clients can decrypt blobs encrypted
 * with any key version.
 *
 * Import from `@epicenter/api/types` rather than hand-writing the response.
 */
export type SessionResponse = {
	user: User;
	session: Session;
	encryptionKeys: EncryptionKeys;
};
