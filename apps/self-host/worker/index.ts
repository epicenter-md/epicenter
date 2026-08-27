/**
 * Epicenter self-hosted instance Worker (Cloudflare; ADR-0075).
 *
 * The instance on Cloudflare: the same `@epicenter/server` surfaces the Bun entry
 * (`server.ts`) builds, wired to Cloudflare bindings instead of plain
 * primitives (ADR-0066). `runtime-profile.test.ts` keeps the two entries in
 * parity.
 * One single-partition instance, not a multi-user wiki and not
 * a mode: every request resolves to the pinned `principals/instance` partition,
 * and authentication is one operator-supplied static
 * bearer (`INSTANCE_TOKEN`), constant-time compared. No OAuth, no allowlist, no
 * sessions. "Solo" vs "shared" is only how many people hold the token.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder, set
 * `INSTANCE_TOKEN` (`wrangler secret put INSTANCE_TOKEN`, generated with
 * `bun run gen-token`), and deploy. The instance composes no Better Auth,
 * Postgres, or store authority, so there is no Hyperdrive binding and no
 * `BETTER_AUTH_SECRET` (ADR-0075). Community-supported.
 *
 * Trust boundary: the deployer operates the infrastructure. Epicenter never holds
 * or sees the data stored here, so self-hosting is functionally zero-knowledge
 * against Epicenter.
 */

import { assertStrongToken } from '@epicenter/auth';
import {
	createEnvTokenResolver,
	createServerApp,
	mountBlobsApp,
	mountSessionApp,
	type ResolveBearerPrincipal,
	requireBearerPrincipal,
} from '@epicenter/server';
import { resolveSelfHostTrustedOrigins } from '../trusted-origins.js';

const app = createServerApp({
	resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
	resolveTrustedOrigins: (baseURL, env) =>
		resolveSelfHostTrustedOrigins(
			baseURL,
			(env as Cloudflare.Env).TRUSTED_BROWSER_ORIGINS,
		),
});

// The instance authenticates one operator-supplied bearer. On Cloudflare the
// secret lives on the per-request `c.env` (a Worker has no module-scope env), so
// the wrapper closes over a resolver that reads `INSTANCE_TOKEN` at the honest edge
// each request (ADR-0066). `assertStrongToken` runs the SAME entropy gate the Bun
// entry runs at boot, so a missing or weak token fails closed on Cloudflare too
// (ADR-0075's entropy floor): a Worker has no boot phase, so the gate runs per
// request and a throw surfaces as a 500 instead of admitting a weak credential. It
// also returns the trimmed token, so there is no `?? ''` coalesce whose removal
// could silently let an unset secret reach the compare.
const resolveBearerPrincipal: ResolveBearerPrincipal = (c, bearer) =>
	createEnvTokenResolver(
		assertStrongToken((c.env as Cloudflare.Env).INSTANCE_TOKEN),
	)(c, bearer);
const auth = requireBearerPrincipal(resolveBearerPrincipal);

app.get('/', (c) =>
	c.json({ product: 'instance', version: '0.1.0', runtime: 'cloudflare' }),
);

// No `mountCloudAuth`: the instance composes no Better Auth and no sessions. The
// operator bearer (`auth` above) is the only gate, so every surface is
// bearer-authenticated (ADR-0075).
mountSessionApp(app, { auth });
// No inference or transcription gateway (ADR-0264): an instance is identity,
// sync, and storage, and holds no provider house key. Inference is a device-local
// connection the client points wherever the operator likes (a local Ollama, a
// Speaches box, OpenRouter, a provider directly). One Connection drives both
// chat and STT, so neither capability is lost by not mounting a gateway here.
// Content-addressed media store over any S3, mounted by default; it answers 503
// until the operator sets `BLOBS_S3_*`. Storage is the operator's own bucket.
mountBlobsApp(app, { auth });

export default app;
