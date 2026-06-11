# Rewrite server-local: Elysia → Hono + Clean Auth

**Status**: Implemented

## Context

The server-local package uses Elysia while server-remote uses Hono. This creates two different framework mental models, prevents middleware sharing, and means the auth validation layer (`hub-validator.ts`) is hand-rolled with code smells (redundant types, no cache eviction, manual response casting). Since server-local hasn't been deployed yet, this is the right time for a clean rewrite on Hono: same framework as the remote server.

## Scope

- Replace Elysia with Hono (including WebSocket via `upgradeWebSocket` from `hono/bun`)
- Simplify auth to `AuthUser | null` instead of `SessionValidationResult` discriminated union
- Add OpenAPI via `hono-openapi` with `describeRoute()` on all routes and `openAPIRouteHandler` at `GET /openapi`
- Preserve the same public API shape (`createSidecar`, `SidecarConfig`, etc.)
- Port all existing tests

## Key Files

| Current File | Action |
|---|---|
| `src/sidecar.ts` | Rewrite → Hono app factory |
| `src/server.ts` | Rewrite → `Bun.serve` with `websocket` export |
| `src/auth/hub-validator.ts` | Delete → inline into auth middleware |
| `src/auth/token-guard.ts` | Delete → inline into auth middleware |
| `src/auth/index.ts` | Delete |
| `src/workspace/plugin.ts` | Port Elysia → Hono |
| `src/workspace/tables.ts` | Port Elysia → Hono |
| `src/workspace/kv.ts` | Port Elysia → Hono |
| `src/workspace/actions.ts` | Port Elysia → Hono |
| `src/workspace/errors.ts` | Keep as-is |
| `src/sync/ws-plugin.ts` | Rewrite → Hono `upgradeWebSocket` adapter |
| `src/sync/rooms.ts` | Keep as-is (framework-agnostic) |
| `src/index.ts` | Update exports |
| `src/start.ts` | Update for Hono serve |
| `package.json` | Swap deps |
| **New:** `src/middleware/auth.ts` | Combined auth middleware |

Consumer to update: `packages/cli/src/commands/sidecar-command.ts` (only imports `createSidecar`: API shape stays the same, no changes needed).

---

## Implementation Plan

### Wave 1: Dependencies & Package Setup
- [x] **1.1** Update `package.json`: remove Elysia deps, add Hono deps, run `bun install`

### Wave 2: Auth Middleware (new file)
- [x] **2.1** Create `src/middleware/auth.ts`: replaces `auth/hub-validator.ts`, `auth/token-guard.ts`, `auth/index.ts`

### Wave 3: Server & Sidecar Core
- [x] **3.1** Rewrite `src/server.ts`: Hono `Bun.serve()` instead of `app.listen()`
- [x] **3.2** Rewrite `src/sidecar.ts`: Hono app factory (depends on 2.1, 3.1)
- [x] **3.3** Update `src/start.ts`: use new serve function

### Wave 4: Workspace Routes (parallel: separate files)
- [x] **4.1** Port `src/workspace/plugin.ts`
- [x] **4.2** Port `src/workspace/tables.ts`
- [x] **4.3** Port `src/workspace/kv.ts`
- [x] **4.4** Port `src/workspace/actions.ts`

### Wave 5: WebSocket Sync Plugin
- [x] **5.1** Rewrite `src/sync/ws-plugin.ts`: Hono `upgradeWebSocket` adapter
  > **Note**: Extended Hono's `websocket` handler with a custom `pong` handler for keepalive since Hono's BunWebSocket adapter doesn't expose pong events.

### Wave 6: Tests (parallel: separate files)
- [x] **6.1** Port `src/sidecar.test.ts`
- [x] **6.2** Port `src/workspace/plugin.test.ts`
- [x] **6.3** Port `src/workspace/tables.test.ts`
- [x] **6.4** Port `src/workspace/actions.test.ts`
- [x] **6.5** Port `src/sync/ws-plugin.test.ts`
- [x] **6.6** `src/sync/rooms.test.ts`: no changes (framework-agnostic)
  > **Note**: Fixed trailing slash mismatches: Hono is strict about trailing slashes unlike Elysia.

### Wave 7: Exports & Cleanup
- [x] **7.1** Update `src/index.ts`: remove old auth exports, add `AuthUser`, replace `listenWithFallback` with `serve`
- [x] **7.2** `src/workspace/index.ts`: no changes needed
- [x] **7.3** Delete `src/auth/` directory

## Verification

1. `bun run typecheck`: passes (only pre-existing errors in workspace package)
2. `bun test packages/server-local/src/`: 76 pass, 0 fail
3. CLI integration: `packages/cli` only imports `createSidecar`: API shape unchanged

## Review

**Completed**: 2026-03-08
**Branch**: braden-w/tab-mgr-sync-upgrade

### Summary

Rewrote the server-local package from Elysia to Hono. All 76 tests pass. The public API (`createSidecar`, `SidecarConfig`, etc.) is preserved. Auth was simplified from a discriminated union (`SessionValidationResult`) to `AuthUser | null` in a single middleware factory.

### Decisions & Deviations

- **OpenAPI via `hono-openapi`**: All workspace/kv/actions routes use `describeRoute()` for metadata. Spec served at `GET /openapi` via `openAPIRouteHandler`.
- **WebSocket pong handling**: Hono's BunWebSocket adapter doesn't expose `pong` events ([honojs/hono#3969](https://github.com/honojs/hono/issues/3969)). Solved by spreading the adapter's `websocket` export and adding a custom `pong` handler.
- **`serve()` replaces `listenWithFallback()`**: The new function takes the Hono app + optional websocket handler and returns `{ server, port }` instead of just the port.
- **`stop()` stores and stops the Bun server**: The server reference from `start()` is stored internally so `stop()` handles both HTTP shutdown and client cleanup.
- **Cache eviction not added**: The auth session cache (`Map<token, CacheEntry>`) grows unbounded but in practice holds 1-2 entries (one per user session on a local server). Not worth the complexity.

### Follow-up Work

- Consider adding `trimTrailingSlash()` middleware for production robustness
