# Server Package Consolidation

**Status**: Superseded by `20260307T000000-remove-server-remote-standalone.md`
**Date**: 2026-03-05
**Supersedes**: Parts of `20260304T120000-hub-sidecar-architecture.md` (package structure section)
**Superseded by**: `20260305T180000-server-remote-adapter-architecture.md` (adapter hosting model: splits adapters into separate packages)

## Summary

Consolidate six server-related packages (`server-elysia`, `server-hub`, `server-cloudflare`, `server-sidecar`, `sync-core`, `sync`) into four, organized around two clear axes: **local vs remote** and **framework choice**.

## Motivation

The current package topology has accidental complexity:

1. **`server-elysia`** exists only because both `server-hub` and `server-sidecar` used Elysia. With the hub moving to Hono, the sidecar is its only consumer: the abstraction layer is no longer justified.
2. **`server-hub`** (Elysia) and **`server-cloudflare`** (Hono) implement the same logical hub with different frameworks. The Hono version is strictly more capable (persistent sync via DO SQLite, OAuth provider, HTTP sync). Maintaining two hub implementations is wasteful.
3. The shared Hono routes in `server-cloudflare` (auth, AI chat, provider proxy, health) are already framework-portable: they use only `fetch()`, `Response`, and Hono middleware. Only the sync transport and storage are Cloudflare-specific.

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     sync-core                           │
│  (pure TS, zero framework deps)                        │
│  Protocol · Room manager · Storage interface · Auth     │
│  Provider constants · Discovery                        │
└──────────────┬─────────────────────┬────────────────────┘
               │                     │
    ┌──────────▼──────────┐  ┌───────▼──────────┐
    │    server-remote     │  │   server-local   │
    │    (Hono)            │  │   (Elysia)       │
    │                      │  │                  │
    │  ┌────────────────┐  │  │  WS sync plugin  │
    │  │ Shared routes  │  │  │  Token guard     │
    │  │  Auth, AI,     │  │  │  Workspace CRUD  │
    │  │  Proxy, Health │  │  │  OpenCode        │
    │  └───────┬────────┘  │  │  Listen helper   │
    │          │           │  │                  │
    │  ┌───────▼────────┐  │  └──────────────────┘
    │  │   Adapters     │  │
    │  │                │  │
    │  │  cloudflare/   │  │
    │  │   DO rooms     │  │
    │  │   DO SQLite    │  │
    │  │   Hibernation  │  │
    │  │   KV sessions  │  │
    │  │                │  │
    │  │  standalone/   │  │
    │  │   In-memory    │  │
    │  │   rooms (from  │  │
    │  │   sync-core)   │  │
    │  │   Standard WS  │  │
    │  │   Local SQLite │  │
    │  │   (optional)   │  │
    │  └────────────────┘  │
    └──────────────────────┘

    ┌──────────────────┐
    │      sync        │  (unchanged, client-side)
    └──────────────────┘
```

### Package Summary

| Package | Framework | Role | Replaces |
|---|---|---|---|
| `sync-core` | None | Server sync protocol primitives | Unchanged |
| `server-remote` | Hono | Hub server (cloud or self-hosted) | `server-cloudflare` + `server-hub` |
| `server-local` | Elysia | Per-device sidecar | `server-sidecar` + inlined `server-elysia` |
| `sync` | None | Client-side sync providers | Unchanged |

**Deleted packages**: `server-elysia`, `server-hub`, `server-cloudflare` (absorbed, not just renamed)

## Naming Decision: `sync-core`

The `sync-core` package is server-side only. The client `sync` package does not import it. Alternative names considered:

- **`sync-protocol`**: Accurate for encode/decode, but doesn't capture room management and storage.
- **`sync-server`**: Captures everything, but collides with the actual server packages.
- **`sync-core`** (keep): "Core sync infrastructure that servers build on." Not perfect, but not confusing enough to justify the churn of renaming.

**Decision**: Keep `sync-core`. The name is adequate and renaming creates unnecessary migration work across all consumers.

## Detailed Design

### 1. `server-remote`: Hono Hub Server

#### Directory Structure

```
packages/server-remote/
├── src/
│   ├── index.ts                    # Package exports
│   ├── app.ts                      # Shared Hono app builder (routes, middleware)
│   ├── types.ts                    # Shared types (AppEnv, HubConfig, etc.)
│   │
│   ├── auth/
│   │   ├── middleware.ts           # Auth middleware (token extraction, session check)
│   │   ├── better-auth-base.ts    # Shared Better Auth config (schema, plugins)
│   │   └── index.ts
│   │
│   ├── proxy/
│   │   ├── chat.ts                # POST /ai/chat: structured AI completions
│   │   ├── passthrough.ts         # ALL /proxy/:provider/*: transparent proxy
│   │   └── index.ts
│   │
│   ├── sync/
│   │   └── index.ts               # Re-exports from sync-core used by adapters
│   │
│   └── adapters/
│       ├── cloudflare/
│       │   ├── worker.ts          # CF Worker entry point (re-exports DO class + app)
│       │   ├── app.ts             # CF-specific app assembly (DO stub routing)
│       │   ├── auth.ts            # CF Better Auth instance (KV sessions, PlanetScale PG via Hyperdrive)
│       │   ├── env.ts             # CF env bindings + CLI env loader
│       │   ├── yjs-room.ts        # YjsRoom Durable Object
│       │   ├── storage.ts         # DOSqliteSyncStorage (SyncStorage impl)
│       │   ├── db/
│       │   │   └── schema.ts      # Drizzle PG schema
│       │   ├── wrangler.toml
│       │   └── worker-configuration.d.ts
│       │
│       └── standalone/
│           ├── server.ts          # Bun/Node entry point (createStandaloneHub)
│           ├── app.ts             # Standalone app assembly (direct WS upgrade)
│           ├── auth.ts            # Standalone Better Auth instance (local PG/SQLite)
│           ├── sync-adapter.ts    # Hono WS adapter using sync-core's room manager
│           └── storage.ts         # Optional: BunSqliteSyncStorage (SyncStorage impl)
```

#### Shared Routes (Framework-Portable Hono Code)

These already exist in `server-cloudflare` and are not Cloudflare-specific:

| Route | File | Notes |
|---|---|---|
| `GET /` | `app.ts` | Health/discovery |
| `GET,POST /auth/*` | `app.ts` | Better Auth handler delegation |
| `/.well-known/...` | `app.ts` | OAuth discovery (if OAuth provider enabled) |
| `POST /ai/chat` | `proxy/chat.ts` | Raw fetch passthrough to provider (from `server-cloudflare`). See AI implementation note below. |
| `ALL /proxy/:provider/*` | `proxy/passthrough.ts` | Unchanged from current `server-cloudflare` |

The auth middleware (`auth/middleware.ts`) is also shared. It extracts tokens from `?token=` (WS) or `Authorization` (HTTP) headers and calls `auth.api.getSession()`. This logic is identical between adapters.

#### AI Chat Implementation Note

`server-hub` and `server-cloudflare` implement `/ai/chat` differently:

| | `server-hub` (Elysia) | `server-cloudflare` (Hono) |
|---|---|---|
| Implementation | TanStack AI `chat()` with `agentLoopStrategy: maxIterations(10)`, tool definitions, system prompts | Raw `fetch()` passthrough: forwards request body to provider, streams response back |
| Tool loop | Yes (up to 10 iterations) | No |
| `systemPrompt` / `modelOptions` / `conversationId` | Yes | No |
| SSE streaming | `toServerSentEventsResponse(stream)` | Raw `Response(providerResponse.body)` |

**Decision**: The shared `proxy/chat.ts` uses the **raw passthrough** approach (current `server-cloudflare`). It is simpler, stateless, and does not require TanStack AI adapter dependencies in the server. Tool orchestration and agent loops belong in the client or a separate orchestration layer, not in the relay hub. If TanStack AI `chat()` is needed later, it can be added as an optional route alongside the passthrough.

#### Adapter Boundary: Sync Routes

The sync route is the only place where adapters diverge significantly:

**Cloudflare adapter** (`adapters/cloudflare/app.ts`):
```typescript
// Forwards to Durable Object: the DO handles WS upgrade, HTTP sync, everything
app.all('/rooms/:room', (c) => {
  const id = c.env.YJS_ROOM.idFromName(c.req.param('room'));
  return c.env.YJS_ROOM.get(id).fetch(c.req.raw);
});
```

**Standalone adapter** (`adapters/standalone/app.ts`):
```typescript
// Direct WS upgrade using Hono's node-ws or bun adapter
// Uses createRoomManager from sync-core (same as current server-hub)
app.get('/rooms/:room', upgradeWebSocket((c) => ({
  onOpen(evt, ws) { /* handleWsOpen from sync-core */ },
  onMessage(evt, ws) { /* handleWsMessage from sync-core */ },
  onClose(evt, ws) { /* handleWsClose from sync-core */ },
})));

// HTTP sync (optional, not in current server-hub but available in sync-core)
app.post('/rooms/:room', async (c) => { /* handleHttpSync from sync-core */ });
app.get('/rooms/:room', async (c) => { /* handleHttpGetDoc from sync-core */ });
```

#### Adapter Boundary: Auth Instance

Both adapters produce a `betterAuth` instance, but the backing infrastructure differs:

| Concern | Cloudflare | Standalone |
|---|---|---|
| Database | PlanetScale PG (postgres.js via Hyperdrive) | Local PG or SQLite (direct driver) |
| Session cache L2 | Cloudflare KV namespace | In-memory Map (or Redis) |
| Secret access | `env` from `cloudflare:workers` | `process.env` |
| Cookie domain | `crossSubDomainCookies` for `epicenter.so` | Configurable |

Both share `better-auth-base.ts` for schema-affecting config (plugins, PKCE, OAuth provider settings).

#### Auth Modes (Standalone)

The standalone adapter preserves the three auth modes from current `server-hub`:

| Mode | Behavior |
|---|---|
| `none` | No auth. Open WebSocket, no token check. |
| `token` | Pre-shared Bearer secret. Registers `GET /auth/get-session` stub returning `{ user: { id: 'token-user', name: 'Token User' } }` when token matches. Sidecar depends on this response shape for session validation. |
| `betterAuth` | Full Better Auth with database. |

The Cloudflare adapter always runs in `betterAuth` mode (it's the hosted tier).

#### Factory API

```typescript
// Cloudflare: no factory needed, it's a Worker export
// adapters/cloudflare/worker.ts
export { YjsRoom } from './yjs-room';
export default app;

// Standalone: factory function
// adapters/standalone/server.ts
export function createRemoteHub(config: StandaloneHubConfig): {
  app: Hono;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;  // Calls roomManager.destroy(): clears all rooms, timers, and Y.Docs
};
```

#### Standalone Entry Point

`adapters/standalone/start.ts` provides a runnable dev/production entry point:

```typescript
const hub = createRemoteHub({ auth: { mode: 'token', token: process.env.AUTH_TOKEN } });
const { port } = await hub.start();
console.log(`Hub listening on port ${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await hub.stop(); process.exit(0); });
}
```

#### Admin Seeding (betterAuth mode)

When running in `betterAuth` mode, the standalone adapter supports bootstrapping an initial admin user via `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables. This is called at startup, silently no-ops if the user already exists.

### 2. `server-local`: Elysia Sidecar

#### Directory Structure

```
packages/server-local/
├── src/
│   ├── index.ts
│   ├── sidecar.ts              # createSidecar factory (unchanged logic)
│   ├── start.ts                # Dev entry point
│   │
│   ├── sync/
│   │   └── ws-plugin.ts        # Inlined from server-elysia/src/sync/ws/plugin.ts
│   │
│   ├── auth/
│   │   ├── token-guard.ts      # Inlined from server-elysia/src/auth.ts (~27 lines)
│   │   └── hub-validator.ts    # Renamed from sidecar-auth.ts
│   │
│   ├── server.ts               # listenWithFallback + DEFAULT_PORT (~18 lines)
│   │
│   ├── workspace/
│   │   ├── plugin.ts           # Unchanged
│   │   ├── tables.ts           # Unchanged
│   │   ├── kv.ts               # Unchanged
│   │   └── actions.ts          # Unchanged
│   │
│   └── opencode/
│       ├── config.ts           # Unchanged
│       └── spawner.ts          # Unchanged
```

#### What Gets Inlined from `server-elysia`

| Source | Destination | Lines | Notes |
|---|---|---|---|
| `server-elysia/src/sync/ws/plugin.ts` | `server-local/src/sync/ws-plugin.ts` | ~176 | Direct copy. Only consumer is the sidecar. |
| `server-elysia/src/auth.ts` | `server-local/src/auth/token-guard.ts` | ~27 | `createTokenGuardPlugin` + `extractBearerToken` re-export |
| `server-elysia/src/server.ts` | `server-local/src/server.ts` | ~18 | `listenWithFallback` + `DEFAULT_PORT` |

`createHttpSyncPlugin` from `server-elysia` is **not** inlined. The sidecar doesn't use it. If HTTP sync is ever needed for the sidecar, it can be added directly.

#### No Logic Changes

The sidecar's behavior is unchanged. This is purely a packaging refactor: moving code from a shared dependency into the only package that uses it.

### 3. `sync-core`: Unchanged

No changes to `sync-core`. Its current contents are well-placed:

| Module | Why it belongs here |
|---|---|
| `protocol.ts` | Wire format used by both adapters and handlers |
| `rooms.ts` | Room manager used by standalone adapter and server-local |
| `handlers.ts` | WS/HTTP handlers used by both adapters and server-local |
| `storage.ts` | `SyncStorage` interface implemented by both DO SQLite and standalone storage |
| `auth.ts` | `extractBearerToken` used everywhere |
| `providers.ts` | Provider constants used by server-remote (AI/proxy) and server-local (OpenCode) |
| `discovery/` | Discovery protocol used by both server tiers |

### 4. `sync`: Unchanged

Client-side package. No changes.

## Migration Plan

### Phase 1: Create `server-remote` (scaffold): DONE

1. ~~Create `packages/server-remote/` with the directory structure above~~
2. ~~Move shared routes from `server-cloudflare` into `src/proxy/` and `src/auth/`~~
3. ~~Move Cloudflare-specific code into `src/adapters/cloudflare/`~~
4. ~~Keep `wrangler.toml`, `drizzle.config.ts`, `better-auth.config.ts`, and `.dev.vars` in `adapters/cloudflare/` (not at package root). Run `wrangler` commands from that subdirectory. Update `package.json` scripts to `cd` into the adapter directory or use `--config` flags.~~
5. ~~Verify the Cloudflare adapter builds and deploys identically~~
6. ~~Delete `packages/server-cloudflare/`: fully absorbed into `server-remote`~~

**Acceptance**: ~~`wrangler dev` works from `adapters/cloudflare/`. All existing Cloudflare functionality preserved.~~
- `bun install` succeeds, `tsc --noEmit` passes clean in `packages/server-remote`
- `packages/server-cloudflare/` deleted: all code now lives under `server-remote/src/adapters/cloudflare/`
- `package.json` scripts use `--config` flags to point wrangler/drizzle-kit at the adapter subdirectory

### Phase 2: Standalone adapter: DONE

1. ~~Create `src/adapters/standalone/`~~
2. ~~Implement `sync-adapter.ts`: Hono WebSocket upgrade using `sync-core`'s `createRoomManager` + handlers~~
3. ~~Port auth modes from `server-hub` (none/token/betterAuth) into standalone auth config~~
4. ~~Port AI chat and proxy routes (already shared from Phase 1)~~
5. ~~Implement `createRemoteHub()` factory~~

**Acceptance**: ~~`createRemoteHub({ auth: { mode: 'token', token: 'test' } })` starts and passes the same test suite as current `server-hub`.~~

### Phase 3: Create `server-local` (rename + inline): DONE

1. ~~Rename `packages/server-sidecar/` → `packages/server-local/`~~
2. ~~Copy `server-elysia/src/sync/ws/plugin.ts` → `server-local/src/sync/ws-plugin.ts`~~
3. ~~Copy `server-elysia/src/sync/ws/plugin.test.ts` → `server-local/src/sync/ws-plugin.test.ts` (14 integration tests)~~
4. ~~Copy `server-elysia/src/auth.ts` → `server-local/src/auth/token-guard.ts`~~
5. ~~Copy `server-elysia/src/server.ts` → `server-local/src/server.ts`~~
6. ~~Update all imports in `server-local` to use local paths instead of `@epicenter/server-elysia`~~
7. ~~Update `sidecar.test.ts`: change `import { DEFAULT_PORT } from '@epicenter/server-elysia'` to local import~~
8. ~~Remove `@epicenter/server-elysia` from `server-local`'s dependencies~~

**Acceptance**: ~~All existing sidecar tests pass (42 tests across 5 files). All 14 WS sync plugin tests pass. No import of `@epicenter/server-elysia` remains.~~

### Phase 4: Update CLI + delete old packages: DONE

1. ~~Update `packages/cli/src/commands/hub-command.ts`: change `import { createHub } from '@epicenter/server-hub'` → `import { createRemoteHub } from '@epicenter/server-remote'`~~
2. ~~Update `packages/cli/src/commands/sidecar-command.ts`: change `import('@epicenter/server-sidecar')` → `import('@epicenter/server-local')`~~
3. ~~Update `packages/cli/package.json`: replace `@epicenter/server-hub` and `@epicenter/server-sidecar` with `@epicenter/server-remote` and `@epicenter/server-local`~~
4. ~~Delete `packages/server-elysia/`~~
5. ~~Delete `packages/server-hub/`~~
6. ~~Delete `packages/server-cloudflare/`~~ (already deleted in Phase 1)
7. ~~Update workspace root `package.json` and any monorepo config~~
8. ~~Grep for any remaining references to deleted package names in comments, docstrings, and specs~~

**Acceptance**: ~~`bun install` succeeds. Full test suite passes (56+ tests). No references to deleted packages in source code.~~

## Resolved Questions

1. **Standalone sync persistence**: **Ephemeral.** The hub is an ephemeral relay by design: the sidecar (server-local) owns persistence via `.yjs` workspace files. The Cloudflare adapter only uses DO SQLite because Durable Objects can be evicted from memory at any time (hibernation) and must rebuild state on wake. A long-lived standalone process doesn't have this constraint: clients resync their full state on reconnect via the SyncStep1/SyncStep2 handshake.

2. **Package naming**: **`server-remote` / `server-local`**. Describes the deployment topology clearly.

3. **Hono WebSocket adapter choice**: **Bun-native (`hono/bun`)** for the standalone adapter. This is the primary self-hosted runtime. Node support via `@hono/node-ws` can be added later if needed: it's a separate adapter, not a breaking change. The Cloudflare adapter continues using the DO Hibernation API.

4. **Standalone session storage**: **In-memory.** Sufficient for single-instance self-hosted deployments. Redis adds operational complexity (separate process) without meaningful benefit at this scale. If multi-instance standalone deployments become a need, Redis can be added as an optional `secondaryStorage` backend later.

## Hono WebSocket Migration Notes (Standalone Adapter)

The standalone adapter uses `upgradeWebSocket` from `hono/bun`. Key translation from Elysia:

| Elysia pattern | Hono/Bun equivalent |
|---|---|
| `ws.sendBinary(data)` | `ws.send(data)`: accepts `Uint8Array` directly |
| `ws.raw` (Bun `ServerWebSocket`) | `ws.raw`: same underlying object, may need type assertion |
| `ws.raw.ping()` | `(ws.raw as ServerWebSocket).ping()`: Hono doesn't expose `ping()` directly |
| `queueMicrotask` for initial messages | May not be needed: test if `ws.send()` works in `onOpen` |
| `setInterval` ping/pong keepalive | Same pattern: no automatic keepalive in Hono or Bun |
| `WeakMap<ws.raw, state>` keying | Same pattern: `ws.raw` is the stable identity |
| CORS middleware on WS routes | **Must skip**: CORS headers conflict with upgrade. Same pattern `server-cloudflare` already uses. |

Incoming binary messages arrive as `ArrayBuffer`: wrap with `new Uint8Array(evt.data as ArrayBuffer)`.

The `websocket` handler must be exported alongside `fetch` from the Bun entry point:
```typescript
import { upgradeWebSocket, websocket } from 'hono/bun'
export default { fetch: app.fetch, websocket }
```

## Monorepo Impact (Audited)

External consumers of deleted packages: **only `packages/cli`**:

| File | Current import | New import |
|---|---|---|
| `cli/src/commands/hub-command.ts` | `import { createHub } from '@epicenter/server-hub'` | `import { createRemoteHub } from '@epicenter/server-remote'` |
| `cli/src/commands/sidecar-command.ts` | `await import('@epicenter/server-sidecar')` | `await import('@epicenter/server-local')` |
| `cli/package.json` | `@epicenter/server-hub`, `@epicenter/server-sidecar` | `@epicenter/server-remote`, `@epicenter/server-local` |

No other packages, apps, CI configs, Dockerfiles, or tsconfig files reference the deleted packages.

## Non-Goals

- **Changing `sync-core` or `sync`**: These packages are stable and well-factored. No changes.
- **Changing the wire protocol**: The y-websocket-compatible protocol with tag-102 extension is unchanged.
- **Changing the sidecar's behavior**: The sidecar does the same thing, just with inlined dependencies.
- **Adding new features**: This is a pure reorganization. New capabilities (e.g., standalone SQLite persistence) are noted as open questions, not committed scope.

## Implementation Review

### What Was Done

**Phase 1 (Complete):** Absorbed `server-cloudflare` into `server-remote/src/adapters/cloudflare/`. Shared Hono routes (`createSharedApp`, auth middleware, proxy handlers) live at the `server-remote` package root. The Cloudflare adapter lives under `src/adapters/cloudflare/` with `wrangler.toml`, Durable Objects, KV session storage, and Drizzle/PlanetScale config. Wrangler commands use `--config src/adapters/cloudflare/wrangler.toml`.

**Phase 2 (Complete):** Built the standalone adapter at `src/adapters/standalone/` with `createRemoteHub()` factory, three auth modes (none/token/betterAuth), Bun WebSocket sync via sync-core's room manager, and admin user seeding.

**Renamed:** `server-sidecar` → `server-local`, inlined `server-elysia` dependencies.

### Architecture Revision: Adapter Hosting Model

After implementing Phases 1-2, we identified friction with the nested adapter approach:

1. Every wrangler command needs `--config` flags pointing at the nested `wrangler.toml`
2. Self-hosters have to navigate into `src/adapters/standalone/` to find the entry point
3. Mixed dependencies: Cloudflare and standalone deps share one `package.json`

**Decision:** Split adapters into separate packages. See `20260305T180000-server-remote-adapter-architecture.md` for the full spec.

Target: `server-remote` (shared core) + `server-remote` + `server-remote-standalone` as three workspace packages. Each adapter gets config files at package root, clean scripts, and isolated dependencies.
