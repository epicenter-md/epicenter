# Module-Level Env & Wrangler 4 Upgrade

**Package:** `packages/server-cloudflare`
**Date:** 2026-03-05

## Problem

The worker creates a fresh `betterAuth()` instance on every request via middleware:

```typescript
// app.ts: current
const authService = factory.createMiddleware(async (c, next) => {
    c.set('auth', createAuth(c.env));
    return next();
});
```

This was necessary because Cloudflare Workers historically had no way to access
`env` bindings outside a request handler. The `auth` instance must live in
`c.var`, threading through middleware and handlers via Hono's `Variables` type.

Since March 2025, `import { env } from "cloudflare:workers"` provides
module-level access to bindings. `betterAuth()` does not perform I/O during
construction. It stores config and lazily connects on first query. The
`secondaryStorage` callbacks are closures that only execute during requests.
This means we can safely create a singleton auth instance at module level.

## Goals

1. Upgrade wrangler 3 → 4 and use `wrangler types` to auto-generate the `Env`
   interface from `wrangler.toml`.
2. Replace per-request `createAuth(c.env)` with a module-level singleton using
   `import { env } from "cloudflare:workers"`.
3. Remove `auth` from Hono's `Variables` type: import it directly where needed.
4. Simplify `AppEnv` and eliminate the auth-threading middleware.

## Non-Goals

- Changing the auth configuration itself (plugins, session settings, etc.).
- Migrating from PlanetScale/Drizzle to D1.
- Changing the proxy handlers' use of `c.env` for API keys (they legitimately
  need per-request dynamic key lookup).

## Research Findings

### `import { env } from "cloudflare:workers"`

- **Available since:** March 2025. No compatibility date gate: controlled by
  the `allow_importable_env` flag which is enabled by default.
- **Works with wrangler 3 and 4**: it's a runtime feature, not a build tool
  feature.
- **Mechanism:** Async-context-aware proxy (like `AsyncLocalStorage`). At module
  evaluation time, resolves to the worker's configured bindings. During
  requests, resolves to request-scoped env (same values unless `withEnv` is
  used).
- **Module-level rules:** Reading strings (`env.DATABASE_URL`) and getting
  binding references (`env.SESSION_KV`) works. I/O (`env.SESSION_KV.get(...)`)
  does not: throws outside request context.
- Our `createAuth()` only reads strings and stores binding references in
  closures during construction. All I/O (KV get/put/delete, DB queries) is
  deferred to request time. **Safe for module-level instantiation.**

### `wrangler types`

- Reads `wrangler.toml` and generates `worker-configuration.d.ts` with an `Env`
  interface.
- In wrangler 4+, generates a `Cloudflare.Env` namespace that
  `cloudflare:workers` uses for typing.
- Maps: KV → `KVNamespace`, DO → `DurableObjectNamespace<T>`, vars → literal
  string types, secrets → `string`.
- Replaces our manually-maintained `Bindings` type in `env.ts`.

### `betterAuth()` construction

- Does **not** perform I/O during construction. Stores config, lazily
  initializes DB connections on first request.
- The `secondaryStorage` callbacks are closures: `env.SESSION_KV.get(key)` only
  runs when Better Auth calls the closure during a request.
- Confirmed safe for module-level singleton in Workers.

### Wrangler 4 upgrade

- Wrangler 4 is the current major version. Breaking changes from 3:
  - Generated types use `Cloudflare.Env` namespace pattern.
  - `--experimental-include-runtime` generates runtime types (can replace
    `@cloudflare/workers-types`).
- Our `wrangler.toml` is simple and should upgrade cleanly.

## Changes

### Wave 1: Upgrade wrangler & generate types ✅

- [x] **package.json:** Bumped `wrangler` ^3 → ^4, added `typegen` script, removed `@cloudflare/workers-types`.
- [x] **tsconfig.json:** Set `"types": []`, added `worker-configuration.d.ts` to `include`.
- [x] **`wrangler types`** generated `worker-configuration.d.ts` with `Cloudflare.Env` namespace + runtime types.
- [x] Fixed `YjsRoom` constructor: `env: Record<string, unknown>` → `env: Env` (global `Env` from generated types).
  > **Note**: The generated `Cloudflare.Env` is missing optional API key secrets (OPENAI_API_KEY, etc.) since they're not declared in wrangler.toml. Will extend in Wave 2.

### Wave 2: Module-level auth singleton ✅

**src/auth/server.ts**: Change `createAuth` to accept the generated `Env` type
(or keep `AuthEnv` as a subset). Export a singleton:

```typescript
import { env } from "cloudflare:workers";

// createAuth stays as a function for testability and the CLI config,
// but we also export a singleton for the worker runtime.
export const auth = createAuth(env);
```

The `AuthEnv` type should align with the generated `Cloudflare.Env`: either
reference it directly or keep the subset type for decoupling.

**src/env.ts**: Remove `auth` from `Variables`:

```typescript
// Before
type Variables = {
    auth: Auth;
    user: Session['user'];
    session: Session['session'];
};

// After
type Variables = {
    user: Session['user'];
    session: Session['session'];
};
```

Remove the `Auth` and `Session` helper types derived from `createAuth` if they
move to `auth/server.ts`. The `Session` type is still needed for `Variables`.

Replace the manual `Bindings` type with the generated `Cloudflare.Env`:

```typescript
// Before
type Bindings = { DATABASE_URL: string; YJS_ROOM: DurableObjectNamespace; ... };
export type AppEnv = { Bindings: Bindings; Variables: Variables };

// After: reference generated type
export type AppEnv = { Bindings: Cloudflare.Env; Variables: Variables };
```

- [x] **src/auth/server.ts**: `createAuth` now uses `import { env } from 'cloudflare:workers'`: no parameter. Exports `auth` singleton.
  > **Note**: Removed `AuthEnv` type entirely: `env` is already typed via `Cloudflare.Env`.
- [x] **src/env.ts**: Replaced manual `Bindings` with `Cloudflare.Env & ApiKeyBindings`. Removed `auth` from `Variables`. `Session` type derived from exported `auth` singleton.
  > **Note**: Added `ApiKeyBindings` extension for optional API key secrets not in wrangler.toml.

### Wave 3: Simplify app.ts and consumers ✅

- [x] **src/app.ts**: Removed `authService` middleware entirely. Import `auth` singleton. All `c.var.auth` → `auth`.
- [x] **src/auth/middleware.ts**: Import `auth` from `./server` instead of reading `c.var.auth`.

### Wave 4: Verify proxy handlers ✅

- [x] Verified `chat.ts` and `passthrough.ts` use `c.env[envKey]` for dynamic API key lookup: no changes needed.

## File Change Summary

| File | Change |
|---|---|
| `package.json` | Bump wrangler ^4, add `typegen` script, evaluate removing `@cloudflare/workers-types` |
| `tsconfig.json` | Update types config for generated declarations |
| `worker-configuration.d.ts` | **New**: generated by `wrangler types` |
| `.gitignore` | Add `worker-configuration.d.ts` if treating as build artifact, or commit it |
| `src/env.ts` | Replace manual `Bindings` with `Cloudflare.Env`, remove `auth` from `Variables` |
| `src/auth/server.ts` | Add `export const auth = createAuth(env)` using `cloudflare:workers` import |
| `src/app.ts` | Remove auth middleware, import `auth` directly, update all `c.var.auth` → `auth` |
| `src/auth/middleware.ts` | Import `auth` from `./server` instead of reading `c.var.auth` |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `postgres()` or `drizzle()` performs I/O during construction | Verified: `postgres()` returns a SQL tagged template function, `drizzle()` wraps it. No I/O until a query executes. |
| `betterAuth()` eagerly connects | Verified: lazy initialization, no construction-time I/O. |
| `wrangler types` output conflicts in monorepo | The `Cloudflare.Env` namespace is global/ambient. Only one worker in this monorepo, so no collision. |
| `wrangler dev` doesn't resolve `cloudflare:workers` | `wrangler dev` runs the actual workerd runtime: `cloudflare:workers` is a built-in module, not a npm package. Should work. If issues arise in local dev, fall back to lazy init pattern: `let _auth; export const getAuth = () => _auth ??= createAuth(env);` |
| Wrangler 3 → 4 breaking changes | Our config is simple (KV, DO, vars, secrets). Review wrangler 4 migration guide before upgrading. Run `wrangler dev` and `wrangler deploy --dry-run` to verify. |

## Verification

1. `bun run typegen`: generates `worker-configuration.d.ts` with expected bindings
2. `bun run typecheck`: no type errors after refactor
3. `bun run dev`: worker starts, auth endpoints respond
4. Test auth flow: sign up, sign in, session validation, bearer token
5. Test proxy: `/proxy/openai/v1/chat/completions` with valid API key
6. Test sync: WebSocket connection to `/rooms/:room`
7. `bun run auth:generate`: CLI still works (uses `better-auth.config.ts`, unaffected)

## Review

**Status**: Implemented
**Date**: 2026-03-05
**Branch**: `braden-w/server-pkg-overview-v1`

### Summary

Upgraded wrangler 3→4, replaced per-request `createAuth(c.env)` with a module-level singleton using `import { env } from 'cloudflare:workers'`, and removed the `auth` threading middleware from Hono's variable system. The auth instance is now imported directly where needed.

### Deviations from Spec

- Removed `AuthEnv` type entirely instead of aligning it with `Cloudflare.Env`: the env import is already typed.
- Added `ApiKeyBindings` intersection to `AppEnv` since wrangler.toml doesn't declare API key secrets (they're set via `wrangler secret put`).
- Fixed `YjsRoom` constructor to use the generated `Env` type (was `Record<string, unknown>`): not in original spec but required by wrangler 4's generated types.

### Remaining Verification

- [ ] `bun run dev`: manual smoke test
- [ ] `bun run deploy --dry-run`: verify deployment compatibility
