# Static Action Routes with Bun Watch Reload

**Status:** Completed
**Date:** 2026-02-25
**Implemented:** 2026-02-25 (commit `c19770a2a`)
**Author:** Braden (spec), agent (implementation)

## Problem

The actions plugin (`packages/server/src/workspace/actions.ts`) used two wildcard routes (`GET /*`, `POST /*`) to handle all actions across all workspaces. This approach:

1. **Lost per-action OpenAPI metadata**: all queries shared one generic description, all mutations shared another
2. **Broke Eden Treaty type inference**: the wildcard `*` param wasn't typed, requiring `(params as Record<string, string>)['*']` casts
3. **Fought the framework**: manual path prefix stripping to extract the action path from the raw URL
4. **No route-level validation**: TypeBox input schemas were checked at runtime inside the handler rather than declared in Elysia's route schema

The wildcard approach was introduced because actions are nested (e.g., `ai/generate`, `records/create`) and workspaces are resolved dynamically. But tables and KV already solve the dynamic workspace problem with `/:workspaceId/tables/:tableName`: they use parameterized routes with runtime resolution, not wildcards.

## Solution

Replaced the wildcard `createActionsPlugin` with per-action static route registration, and added `bun --watch` support to automatically restart the server when workspace config files change. This gives us:

- **Rich OpenAPI docs** per action (summary, description, namespace tags)
- **Full Elysia type inference** on each route
- **Framework-native routing**: Elysia's radix tree does the matching
- **Automatic reload** when actions are added/removed/changed

## Key Insight

Elysia compiles routes at `.listen()` time and does not support adding routes after startup. But `bun --watch` restarts the entire process on file changes, so the route tree is rebuilt from scratch each time. This means we can register all routes statically at startup and rely on the restart to pick up changes, no hot-reload plumbing needed.

## What Changed

### 1. Refactored `createActionsPlugin` to static per-action routes

**File:** `packages/server/src/workspace/actions.ts`

Replaced the wildcard approach with iteration over all workspaces and their actions at plugin construction time. Uses `Map<string, Set<'query' | 'mutation'>>` to handle the edge case where different workspaces define the same action path with different types (query vs mutation).

Key differences from the old wildcard approach:
- Routes are registered per unique action path across all workspaces
- Workspace resolution still happens at request time via `:workspaceId` param
- Each route gets its own OpenAPI `detail` with summary and namespace tags
- No manual path prefix stripping: Elysia handles matching
- `resolveAction` is still used, but the path is known at registration time

### 2. Added `--watch` flag to the `serve` command

**File:** `packages/cli/src/cli.ts`

Added `--watch` / `-w` boolean option. When enabled, re-execs the process with `bun --watch`, stripping the `--watch`/`-w` flags from args to avoid infinite recursion.

Bun watches all files imported by the process. Since `discoverAllWorkspaces` does `import(configPath)` for each `epicenter.config.ts`, those config files and their transitive dependencies (including action definitions) are automatically in the watch graph. No explicit file list needed.

### 3. Deleted `createActionsRouter`

The legacy per-single-workspace function was removed. The refactored `createActionsPlugin` absorbs its per-action-route approach while keeping multi-workspace support.

### 4. No changes needed

- `packages/server/src/workspace/plugin.ts`: already called `createActionsPlugin(workspaces)`, signature unchanged
- `packages/server/src/workspace/index.ts`: exports unchanged
- `packages/server/src/local.ts`: no changes needed

## Edge Cases Handled

### Workspaces with different action sets
If workspace A has `ai/generate` and workspace B has `records/create`, the plugin registers both routes. At request time, `GET /workspaces/A/actions/records/create` returns 404 because workspace A doesn't have that action: `resolveAction` returns undefined.

### Workspaces with overlapping action paths but different types
Uses `Map<string, Set<'query' | 'mutation'>>` so if workspace A defines `users/sync` as a query and workspace B defines it as a mutation, both GET and POST routes are registered.

### No workspaces / no actions
The plugin registers zero routes. The router is still valid, just empty.

## Files Modified

| File | Change |
|------|--------|
| `packages/server/src/workspace/actions.ts` | Refactored `createActionsPlugin` to per-action static routes; deleted `createActionsRouter` |
| `packages/cli/src/cli.ts` | Added `--watch` flag to `serve` command |
