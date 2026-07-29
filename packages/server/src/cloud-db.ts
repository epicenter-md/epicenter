/** Hosted Postgres mechanics with no Cloudflare or Bun runtime imports. */
export type { Db } from './db/create-db.js';
export {
	deleteHostedPrincipal,
	readHostedPrincipalEmail,
} from './db/principal-data.js';
// Connected publishing accounts (hosted-only). The TABLES live in this package
// because drizzle-kit generates migrations from its schema barrel; all the
// policy that uses them (routes, token custody, the TikTok client) lives in
// apps/api/worker/integrations, which the single-partition instance never
// composes. See db/schema/integrations.ts.
export {
	tiktokConnection,
	tiktokOauthState,
	tiktokPublishAttempt,
} from './db/schema/integrations.js';
