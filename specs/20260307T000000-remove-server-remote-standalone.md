# Remove server-remote-standalone & Plan Unified Server Remote

**Date**: 2026-03-07
**Status**: Implemented
**Supersedes**: `20260305T120000-server-package-consolidation.md`, `20260305T180000-server-remote-adapter-architecture.md`

## Problem

We maintain two server-remote packages with diverging implementations:

- **`server-remote`**: production, actively developed, has DocumentRoom snapshots, user-scoped room keys, Durable Objects, Better Auth with Postgres via Hyperdrive
- **`server-remote-standalone`**: stale, simpler feature set, only used by `@epicenter/cli` hub commands

Maintaining both is not worth the effort. The Cloudflare version is the canonical one. The standalone version should be removed now and rebuilt later: based on the Cloudflare version. When we actually need self-hosted deployments.

## Analysis: What Standalone Has

| File | Purpose | Equivalent in Cloudflare |
|------|---------|--------------------------|
| `src/app.ts` | Hono app factory, auth modes (none/token/betterAuth), CORS, routes | `src/app.ts` (superset: has workspace + document routes, OAuth discovery) |
| `src/sync-adapter.ts` | WS + HTTP sync via `createBunWebSocket` + `createRoomManager` | `workspace-room.ts` + `document-room.ts` (Durable Objects ARE the rooms) |
| `src/storage.ts` | `BunSqliteUpdateLog` (bun:sqlite) | DO SQLite via `ctx.storage.sql` (identical schema) |
| `src/ai-chat.ts` | TanStack AI streaming proxy | `src/ai-chat.ts` (nearly identical, Cloudflare uses ArkType validation) |
| `src/start.ts` | CLI entry point, reads env, calls Bun.serve | N/A (Cloudflare uses `export default app`) |

### Consumers

Only **one** consumer: `packages/cli/src/commands/hub-command.ts` imports `createRemoteHub` to power `epicenter hub start/stop/status`.

### What standalone has that Cloudflare doesn't

- `mode: 'none'` auth (anonymous access): useful for local dev
- `mode: 'token'` auth (bearer token): lightweight auth without Better Auth
- Embeddable as a library (`createRemoteHub()` factory)

### What Cloudflare has that standalone doesn't

- `DocumentRoom` with snapshots (save/list/get/restore)
- User-scoped room keys (`user:{userId}:{room}`)
- Separate workspace vs document room types with different GC settings
- ArkType validation on AI chat body
- Session KV caching
- Hyperdrive connection pooling

## Decision: One Package, Two Deployment Targets (Future)

After analyzing Hono's multi-runtime capabilities and Better Auth's adapter system, **a single `server-remote` package with two entry points is the right architecture** for when we rebuild standalone support. Here's why:

### Why one package works

1. **Hono is runtime-agnostic.** Routes, middleware, and handlers are pure Web Standard `Request` → `Response` functions. The same Hono app runs on Cloudflare Workers, Bun, Node.js, and Deno.

2. **Better Auth's `database` option is a union type.** Pass `env.DB` (D1) for Cloudflare, `new Database("./auth.db")` (bun:sqlite) for standalone: all other config (plugins, session settings, OAuth clients) is shared.

3. **Tree-shaking isolates platform code.** Wrangler bundles from the worker entry point: it never touches standalone code. Bun runs from `start.ts`: it never imports Durable Objects. No conditional imports needed; just separate entry points.

4. **The Durable Objects are the only truly Cloudflare-specific code.** Everything else (auth setup, AI chat, CORS, auth guard, health check, route structure) is portable.

### Future structure (NOT part of this spec: just documenting the vision)

```
packages/server-remote/
├── wrangler.jsonc                    # Cloudflare deployment config
├── package.json
├── src/
│   ├── shared/
│   │   ├── auth.ts                   # Better Auth config factory (accepts db param)
│   │   ├── auth-guard.ts             # Auth guard middleware
│   │   ├── cors.ts                   # CORS middleware
│   │   ├── ai-chat.ts                # AI chat handler
│   │   └── routes.ts                 # Shared route definitions (health, auth, ai)
│   ├── cloudflare/
│   │   ├── worker.ts                 # export default app + DO class re-exports
│   │   ├── workspace-room.ts         # WorkspaceRoom Durable Object
│   │   ├── document-room.ts          # DocumentRoom Durable Object
│   │   └── routes.ts                 # /workspaces/:room, /documents/:room → DO stubs
│   └── standalone/
│       ├── start.ts                  # Bun.serve() entry
│       ├── sync-adapter.ts           # WS + HTTP sync via createBunWebSocket + roomManager
│       ├── storage.ts                # BunSqliteUpdateLog
│       └── routes.ts                 # /rooms/:room → direct WS/HTTP handling
```

Key architectural difference: In Cloudflare, each Durable Object IS the room (platform provides isolation). In standalone, we need `createRoomManager` from sync-core for in-memory room management. The route handlers look different because Cloudflare proxies to DO stubs while standalone handles connections directly.

## Scope of This Spec: Remove standalone NOW

### Phase 1: Remove `server-remote-standalone`

**Delete the package:**
- [x] `packages/server-remote-standalone/`: entire directory

**Update `@epicenter/cli`:**
- [x] Remove `"@epicenter/server-remote-standalone": "workspace:*"` from `packages/cli/package.json`
- [x] Remove or stub `packages/cli/src/commands/hub-command.ts`:
  - **Option A (recommended):** Keep the command structure but have `hub start` print a message: "Self-hosted hub is not yet available. Use Epicenter Cloud at https://epicenter.so or see docs for Cloudflare Workers deployment."
  > **Implemented Option A.** All three subcommands (start, status, stop) print the unavailability message.

**Update lockfile:**
- [x] Run `bun install` to regenerate `bun.lock` without the deleted package

### Phase 2: Clean up sync-core (if needed)

Check whether `sync-core` exports anything that was ONLY used by standalone:
- [x] `createRoomManager`: also useful for tests and potentially future standalone, **keep it**
- [x] All protocol functions: used by both, **keep**
- [x] All handler functions: used by both, **keep**

**No sync-core changes needed.** Confirmed the package is a clean shared abstraction.

### Phase 3: Mark old specs as superseded

Update the status in:
- [x] `specs/20260305T120000-server-package-consolidation.md` → Status: Superseded
- [x] `specs/20260305T180000-server-remote-adapter-architecture.md` → Status: Superseded

## What We Keep for Later

When rebuilding standalone support, we'll need to:

1. Add a `src/standalone/` directory to `server-remote` (and rename the package to `server-remote`)
2. Extract shared auth/CORS/AI-chat into `src/shared/`
3. Re-implement the BunSqliteUpdateLog (or port to better-sqlite3 for Node.js compat)
4. Re-implement the sync adapter using `createRoomManager` from sync-core
5. Decide on auth modes: keep none/token for local dev, or require Better Auth everywhere
6. Re-add the CLI hub command pointing to the new standalone entry

## Risk Assessment

**Blast radius: Very small.**
- Only `@epicenter/cli` imports from standalone
- The CLI hub commands are not critical path: no user-facing app depends on them
- The Cloudflare version is unaffected
- sync-core is unaffected

**What we lose:**
- `epicenter hub start/stop/status` CLI commands
- Ability to self-host without Cloudflare
- `mode: 'none'` and `mode: 'token'` lightweight auth

**Why that's acceptable:**
- Self-hosting is not a priority right now
- All active development is on Cloudflare
- Maintaining divergent implementations wastes time
- We can rebuild standalone properly when needed, based on the mature Cloudflare codebase

## Review

**Completed**: 2026-03-08

### Summary

Removed the `server-remote-standalone` package entirely and stubbed the CLI `hub` command with an unavailability message pointing users to Epicenter Cloud. No sync-core changes were needed. Two superseded specs were updated.

### Deviations from Spec

- None. Implementation followed the spec exactly, using Option A (stub) for the hub command.

### Follow-up Work

- Rebuild standalone support as `src/standalone/` within `server-remote` when self-hosted deployments become a priority (see "Future structure" section above).
