# Network Topology: Execution Plan

**Date**: 2026-02-23
**Status**: In Progress
**Parent Spec**: `20260222T195645-network-topology-multi-server-architecture.md`
**Branch**: `feat/network-topology-multi-server`

## Execution Steps

### Step 1: Hub & Local Server Composition Split

- [x] 1.1 Create `createHubServer()` with sync + AI + OpenAPI (`packages/server/src/hub.ts`)
- [x] 1.2 Create `createLocalServer()` with sync + workspace + OpenAPI, no AI (`packages/server/src/local.ts`)
- [x] 1.3 Update exports in `index.ts`
- [x] 1.4 Split `start.ts` into `start-hub.ts` and `start-local.ts` entry points
- [x] 1.5 Tests pass (161/162, 1 pre-existing failure)

### Step 2: Better Auth Plugin

- [x] 2.1 Add `better-auth` to server package dependencies
- [x] 2.2 Create `createAuthPlugin()` with Better Auth + Bearer plugin (`packages/server/src/auth/plugin.ts`)
- [x] 2.3 Wire auth plugin into `createHubServer()` (optional config)
- [x] 2.4 Add session validation macro via `auth.api.getSession()`
- [x] 2.5 Tests pass

### Step 3: Key Management on Hub

> **Reversed (2026-02-23)**: The encrypted key store was removed in `20260223T102844-remove-key-store-simplify-api-key-resolution.md`. The `keys/` directory, key management REST API, and async `resolveApiKey()` are all gone. API keys now resolve from env vars only. See that spec for rationale (security theater, redundant with env vars, ~400 lines of unnecessary code).

- [x] ~~3.1 Create encrypted key store (AES-256-GCM, `packages/server/src/keys/store.ts`)~~: Removed
- [x] ~~3.2 Create key management Elysia plugin (`packages/server/src/keys/plugin.ts`)~~: Removed
- [x] ~~3.3 Extend `resolveApiKey()` to check server store (async, 3-step chain)~~: Reverted to sync 2-step
- [x] ~~3.4 Wire key management into hub server~~: Removed
- [x] 3.5 Tests pass (161/161)

### Step 4: OLLAMA_HOST Configuration

- [x] 4.1 Update Ollama adapter factory to use `OLLAMA_HOST` env var (done in Step 3)

### Step 5: Local Server Auth Boundary

- [x] 5.1 Create hub-delegated session validator with TTL cache (`packages/server/src/auth/local-auth.ts`)
- [x] 5.2 Wire local auth into `createLocalServer()` config (`hubUrl` option)
- [x] 5.3 Add CORS configuration via `@elysiajs/cors` (allowedOrigins)
- [x] 5.4 Tests pass

### Step 6: Client Hub URL Configuration

- [x] 6.1 Add hubServerUrl setting (`apps/tab-manager/src/lib/state/settings.ts`)
- [x] 6.2 Update AI chat to use hub URL, remove Ollama from client providers (`chat.svelte.ts`)
- [x] 6.3 Run typecheck (0 new errors)

### Step 7: AI Proxy for OpenCode

- [x] 7.1 Create AI proxy plugin (`packages/server/src/proxy/plugin.ts`)
- [x] 7.2 Wire proxy into hub server (mounted unconditionally: reads env vars, no keyStore dependency)
- [x] 7.3 Tests pass

### Step 8: Server Discovery via Yjs Awareness

- [x] 8.1 Define discovery room and Awareness state types (`packages/server/src/discovery/awareness.ts`)
- [x] 8.2 Discovery room (`_epicenter_discovery`) works via existing sync layer (no special wiring needed)
- [x] 8.3 Local presence helpers: `createLocalPresence()`, `createClientPresence()`
- [x] 8.4 Device discovery helper: `getDiscoveredDevices()` with deduplication

### Step 9: OpenCode Integration

- [x] 9.1 Create OpenCode config generator (`packages/server/src/opencode/config.ts`)
- [x] 9.2 Create XDG-isolated OpenCode spawner with lifecycle management (`packages/server/src/opencode/spawner.ts`)
- [x] 9.3 Add exports to packages/server (index.ts, package.json)
- [ ] 9.4 Wire OpenCode lifecycle to Tauri app lifecycle (deferred: needs Rust changes)
- [ ] 9.5 Plugin list sync via Yjs (deferred: needs `opencode_plugins` table in workspace schema)

## Files Created

- `packages/server/src/hub.ts`: Hub server composition
- `packages/server/src/local.ts`: Local server composition
- `packages/server/src/auth/plugin.ts`: Better Auth Elysia plugin
- `packages/server/src/auth/local-auth.ts`: Hub-delegated session validator
- `packages/server/src/auth/index.ts`: Auth exports
- ~~`packages/server/src/keys/store.ts`: Encrypted key store (AES-256-GCM)~~: Removed (2026-02-23)
- ~~`packages/server/src/keys/plugin.ts`: Key management REST endpoints~~: Removed (2026-02-23)
- ~~`packages/server/src/keys/index.ts`: Keys exports~~: Removed (2026-02-23)
- `packages/server/src/proxy/plugin.ts`: AI proxy for OpenCode
- `packages/server/src/proxy/index.ts`: Proxy exports
- `packages/server/src/discovery/awareness.ts`: Yjs Awareness-based discovery
- `packages/server/src/discovery/index.ts`: Discovery exports
- `packages/server/src/opencode/config.ts`: OpenCode config generator (OPENCODE_CONFIG_CONTENT)
- `packages/server/src/opencode/spawner.ts`: XDG-isolated OpenCode process manager
- `packages/server/src/opencode/index.ts`: OpenCode exports

## Files Modified

- `packages/server/src/index.ts`: Updated exports (all modules including opencode)
- `packages/server/src/start-hub.ts`: Hub server entry point
- `packages/server/src/start-local.ts`: Local server entry point
- `packages/server/src/ai/adapters.ts`: Sync resolveApiKey (header → env var), removed Ollama. KeyStore removed (2026-02-23).
- `packages/server/src/ai/plugin.ts`: No config needed, sync key resolution. KeyStore removed (2026-02-23).
- `packages/server/src/ai/plugin.test.ts`: Fixed 3 tests for async resolveApiKey
- `packages/server/package.json`: Added better-auth, @elysiajs/cors, new export paths (incl. ./opencode)
- `apps/tab-manager/src/lib/state/settings.ts`: Added hubServerUrl setting
- `apps/tab-manager/src/lib/state/chat.svelte.ts`: AI chat routes through hub URL, removed Ollama providers

## Review

All execution steps complete (Steps 1-9). Two items deferred to future work:

- **Tauri lifecycle wiring**: The `createOpenCodeProcess()` API is ready, but wiring it to Tauri's app startup/shutdown needs Rust changes in `apps/epicenter/src-tauri/src/lib.rs`.
- **Plugin list sync**: Needs an `opencode_plugins` table in the Yjs workspace schema, which doesn't exist yet.

The server package now has a full hub/local split with:

- Hub: sync + AI + auth (Better Auth) + key management + AI proxy + discovery
- Local: sync + workspace + CORS + session validation against hub
- OpenCode: config generator + XDG-isolated process manager with lifecycle API
- Client: hub URL setting + AI chat routing through hub

Tests: 161 pass, 0 fail. Zero new typecheck errors.
