# apps/self-host

Reference single-partition **instance** (ADR-0075, amended by ADR-0092): one operator-supplied bearer (`INSTANCE_TOKEN`), one literal `instance` principal, one `principals/instance` partition. Composes `@epicenter/server` with `createEnvTokenResolver(token)` and `requireBearerPrincipal`. It serves session and blobs, and deliberately no inference (ADR-0264). Two runtimes use one set of library surfaces: an off-Cloudflare Bun entry (`server.ts`, blessed) and a Cloudflare Worker (`worker/index.ts`). They authenticate identically because the operator supplies the secret either way, and `runtime-profile.test.ts` keeps their surfaces in parity. "Solo" vs "shared" is only how many people hold the token, never a mode.

Not operated by Epicenter; framed as a community-supported starting point. Keep the worker entry small (~30 lines) so it stays readable as a reference.

Multi-tenancy (many principals, OAuth, billing) is Epicenter Cloud's only (`apps/api`); an instance never grows a mode, an allowlist, OAuth, sessions, first-boot minting, Better Auth, or a database. The relational-auth substrate (Better Auth + Postgres) is Cloud-only (ADR-0076): the instance composes neither, so it provisions nothing but the token. Named per-person tokens are a deliberately-unbuilt seam (a hashed registry behind the same verifier, resolving to the same `instance` principal); build it only on real offboarding pain, never speculatively.

## Hard constraints

- Do not mount `mountInferenceApp` or `mountTranscriptionApp`, and do not add a provider house key (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or any successor). An instance does not do inference (ADR-0264): it is identity, sync, and storage. Inference is a device-local client connection, and one connection drives both chat and STT, so mounting a gateway here buys nothing and re-imports Cloud's model catalog.
- Do not import `@epicenter/billing` (it no longer exists; billing lives inside `apps/api/worker/billing/` and is hosted-only).
- Do not add `autumn-js`, `AUTUMN_SECRET_KEY`, or `/api/billing/*` routes.
- Do not add a dashboard SPA or Workers Static Assets binding.
- Do not add OAuth, sessions, an allowlist, a launch-time mode selector, or first-boot token minting back: the instance is bearer-only by design (ADR-0075).
- Do not re-add Better Auth, Postgres, a `pg` pool, `DATABASE_URL`, `BETTER_AUTH_SECRET`, or a Hyperdrive binding: the relational-auth substrate is Cloud-only (`mountCloudAuth`), and the instance composes neither (ADR-0076). It uses `requireBearerPrincipal` (never `requireCookieOrBearerPrincipal`). The rooms route records no telemetry on any deployment (the write-only `durableObjectInstance` table and its recorder seam were deleted, ADR-0076), so there is no telemetry knob to set here.
- Do not make `INSTANCE_PRINCIPAL_ID` env config: its value is byte-pinned durable data (`principals/instance` R2 prefix, DO name prefix, IDB prefix, and HKDF label input). Named tokens, if ever built, resolve to that same principal so they never re-partition.

## When editing

- Changes to composition primitives (`mount*`, `mountCloudAuth`, auth resolvers) live in `packages/server`, not here.
- Updates to the deployment trust model live in `docs/trust-model.md` and `apps/api/README.md`.
- For deployment configuration, treat the wrangler bindings as user-customized; do not commit a working set of bindings.
