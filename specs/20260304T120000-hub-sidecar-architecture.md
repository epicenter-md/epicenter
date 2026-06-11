# Hub + Sidecar Architecture

**Goal**: Establish a two-plane server architecture where the hub handles sync and identity, and the sidecar handles data and execution.

**Status**: Partially Implemented: Hub exists on Cloudflare, sidecar and self-hosted tiers are unbuilt (see Current State below)

> The hub is a sync and identity plane; the sidecar is the data and execution plane. Hosted users get your hub. Self-hosters can run their own hub. Enterprises can plug their own identity. The sidecar stays local and stable across all three tiers.

---

## Current State (2026-03-20)

The two-plane concept holds, but only the hub plane shipped. Here's what exists versus what remains planned.

### What exists

- **Hub (Tier 1 / Hosted)**: Implemented as `apps/api/` on Cloudflare Workers + Hono + Durable Objects. This is the `server-cloudflare` concept from the package structure below, but it lives at `apps/api/` rather than `packages/server-cloudflare/`. The hub endpoint contract described in this spec (WebSocket sync, HTTP sync, auth, AI chat) matches the actual `apps/api/src/app.ts` routes.
- **Auth**: Better Auth with email/password, Google OAuth, bearer tokens, JWT, and OAuth provider plugin. Cross-subdomain cookies on `epicenter.so`. OAuth/PKCE for desktop and mobile clients.
- **Durable Objects**: Per-user `WorkspaceRoom` and `DocumentRoom` with SQLite-backed sync state, WebSocket hibernation, and alarm-based compaction.
- **Sync client**: `packages/sync-client/` provides the WebSocket/HTTP provider. `packages/workspace/src/extensions/sync.ts` wraps it as a workspace extension with `getToken` callback.

### What doesn't exist

- **Sidecar plane**: No `server-sidecar` package. No local Elysia server running per-device. The desktop app (Tauri) talks directly to the hub via the sync extension.
- **Self-hosted hub (Tier 2)**: No `server-hub` package. The CLI prints: *"Self-hosted hub is not yet available. Use Epicenter Cloud."*
- **Enterprise hub (Tier 3)**: No OIDC/SAML federation. No enterprise auth mode.
- **Package restructure**: The `server-elysia`, `server-local`, and `server-remote` packages referenced in the Problem section have been deleted (commit `185dd1204`). They were not replaced by `server-hub`/`server-sidecar`: the Cloudflare hub in `apps/api/` became the sole implementation.
- **R2 blob storage**: The `storage.ts` → R2 concept from the package structure hasn't been built. Durable Object SQLite is the only sync storage.

### Ownership model divergence

This spec assumes org-scoped workspaces (from the sync architecture spec). The actual implementation uses per-user scoping: `user:{userId}:workspace:{name}`. See `specs/20260121T170000-sync-architecture.md` for the full divergence notes.

---

## Problem

The current server topology has three Elysia-based packages (`server-elysia`, `server-local`, `server-remote`) with overlapping responsibilities and unclear boundaries. The previous "unified server" idea (merging local and remote into one configurable binary) blurs a boundary that should be sharp: the hub is stateless infrastructure, the sidecar is stateful application logic. Meanwhile, Phase 2 of the platform-agnostic sync spec calls for a Cloudflare/Hono hub that needs the same sync+identity interface as the self-hosted Elysia hub.

### Current Package Topology

```
sync-core (pure TS handlers)
├── server-elysia (shared Elysia plugins: WS sync, HTTP sync, token guard, discovery)
│   ├── server-local (sidecar: workspace CRUD + actions + OpenCode + auth consumer)
│   └── server-remote (hub: sync relay + AI + proxy + auth source)
└── server-cloudflare [planned, not built]
```

### Issues

1. `server-elysia` mixes shared utilities (sync plugins, auth helpers, provider constants) with Elysia-specific plugin wiring. Some of its exports are framework-agnostic (providers, discovery awareness types) and belong in `sync-core` or their own package.
2. `server-local` and `server-remote` are ~300-line factory functions that are structurally identical (both compose `new Elysia()` + sync plugin + auth guard + health check + optional plugins). The shared pattern isn't captured anywhere.
3. The self-hosted hub (Elysia) and hosted hub (Cloudflare/Hono) need the same external contract (sync rooms, auth, AI proxy) but share no interface definition.
4. The "remote" auth mode in `server-local` is tightly coupled to Better Auth's `GET /auth/get-session` response shape, but this is the hub's concern: the sidecar should validate tokens against any hub.

---

## Architecture

### Two Planes

**Hub (Sync + Identity Plane)**: One per deployment. Infrastructure.

- Relays Y.Doc sync between devices (WebSocket rooms)
- Owns identity (authentication, session management)
- Proxies AI provider APIs (keys never reach clients)
- Stateless: Y.Docs are ephemeral relay buffers, destroyed when the last client disconnects
- Faces the internet (or corporate network for enterprise)
- Two implementations: Cloudflare (Hono + Durable Objects) and self-hosted (Elysia/Bun)

**Sidecar (Data + Execution Plane)**: One per device. Application logic.

- Persists workspace data (Y.Docs backed by workspace clients)
- Runs user-defined code: table schemas, KV stores, actions (queries + mutations)
- Manages local tooling (OpenCode process spawner)
- Faces localhost only (CORS restricted to `tauri://localhost`)
- Auth: always delegates to the hub
- Identical across all three tiers

### Why Not Unify?

| Concern | Hub | Sidecar |
|---|---|---|
| State | Stateless relay | Stateful (workspace-backed Y.Docs) |
| Network exposure | Internet-facing | Localhost only |
| Lifecycle | Long-running service on stable infra | Starts/stops with the desktop app |
| User code | Never runs user code | Always runs user code (schemas, actions) |
| Deployment | One per org/deployment | One per device |
| Scaling | Horizontal (stateless) | Not applicable (per-device) |

These are genuinely different operational profiles. Merging them into one "configurable" binary creates confusion about what to deploy where and how to scale it.

### Deployment Models

#### Tier 1: Hosted (Hobbyist)

```
Cloudflare Hub (Hono + DO)     ◄── you run this, your SaaS
  │  sync relay + Better Auth + AI proxy
  │
  ├── Device A: Sidecar (Elysia)
  │     workspace schemas, actions, tools
  │     auth: delegates to Cloudflare hub
  │
  └── Device B: Sidecar (Elysia)
        workspace schemas, actions, tools
        auth: delegates to Cloudflare hub
```

Most Tier 1 users never run a sidecar. They use the web app, it syncs to Cloudflare. Power users who want custom actions install the desktop app, which starts the sidecar automatically.

#### Tier 2: Self-Hosted (Hobbyist)

```
Self-Hosted Hub (Elysia/Bun)   ◄── user runs on VPS / NAS / RPi
  │  sync relay + token auth + AI proxy
  │
  ├── Device A: Sidecar (Elysia)
  │     workspace schemas, actions, tools
  │     auth: delegates to self-hosted hub
  │
  └── Device B: Sidecar (Elysia)
        workspace schemas, actions, tools
        auth: delegates to self-hosted hub
```

The self-hosted hub replaces Cloudflare entirely. User runs `bun run hub.ts` on a box that's always on. Token auth is the default: set `AUTH_TOKEN` env var and done.

#### Tier 3: Enterprise

```
Self-Hosted Hub (Elysia/Bun)   ◄── IT deploys on corporate infra
  │  sync relay + Better Auth (OIDC → Okta/Azure AD) + AI proxy
  │
  ├── Employee A: Sidecar (Elysia)
  ├── Employee B: Sidecar (Elysia)
  └── Employee C: Sidecar (Elysia)
```

Same as Tier 2 but with proper auth. Better Auth runs on the hub with the enterprise's own database. OIDC/SAML federation to their existing IdP. Commercial license (dual AGPL).

---

## Package Structure (Target): Planned, Not Started

> **Note (2026-03-20)**: None of these packages exist. The source packages (`server-elysia`, `server-local`, `server-remote`) were deleted. The Cloudflare hub lives at `apps/api/` and is the only server implementation. This section describes the target architecture if/when self-hosted and enterprise tiers are built.

```
packages/
  sync-core/                  # Pure TS. Zero framework deps.
    src/
      handlers.ts             # handleWsOpen, handleWsMessage, handleWsClose, handleHttpSync
      protocol.ts             # encode/decode y-websocket wire format
      rooms.ts                # room manager (connection tracking, eviction)
      storage.ts              # SyncStorage interface + memory impl
      auth.ts                 # extractBearerToken, TokenVerifier type
      discovery/              # ← move from server-elysia/src/discovery/ (already framework-agnostic)
      providers.ts            # ← move from server-elysia (already framework-agnostic)

  server-elysia/              # Shared Elysia plugin library (thin wrappers)
    src/
      sync/
        ws/plugin.ts          # createWsSyncPlugin: Elysia WS adapter for sync-core
        http/plugin.ts        # createHttpSyncPlugin: Elysia HTTP adapter for sync-core
      auth.ts                 # createTokenGuardPlugin (Elysia-specific)
      server.ts               # listenWithFallback, DEFAULT_PORT

  server-hub/                 # Self-hosted hub (Elysia). Replaces server-remote.
    src/
      hub.ts                  # createHub({ auth, sync, ai?, proxy? }) → { app, start, stop }
      auth/                   # none, token, betterAuth modes
      ai/                     # createAIPlugin (SSE streaming): moved from server-remote
      proxy/                  # createProxyPlugin (provider proxy): moved from server-remote

  server-sidecar/             # Local sidecar (Elysia). Replaces server-local.
    src/
      sidecar.ts              # createSidecar({ hubUrl, workspace, ... }) → { app, start, stop }
      auth/                   # remote mode only (delegates to hub)
      workspace/              # createWorkspacePlugin (tables, KV, actions): moved from server-local
    opencode/                 # createOpenCodeProcess: separate export, not HTTP

  server-cloudflare/          # Hosted hub (Hono + Durable Objects). Phase 2.
    src/
      worker.ts               # Hono app: auth middleware, HTTP sync, DO routing
      yjs-room.ts             # Durable Object: WS sync via sync-core handlers
      storage.ts              # R2 or DO SQLite SyncStorage implementation
```

### What Moves Where

| Current location | Target | Reason |
|---|---|---|
| `server-elysia/src/discovery/` (`index.ts` + `awareness.ts`) | `sync-core/src/discovery/` | Already framework-agnostic (pure Yjs Awareness) |
| `server-elysia/src/providers.ts` | `sync-core/src/providers.ts` | Pure data, no Elysia dependency |
| `server-remote/src/ai/` | `server-hub/src/ai/` | Hub concern |
| `server-remote/src/proxy/` | `server-hub/src/proxy/` | Hub concern |
| `server-remote/src/auth/` | `server-hub/src/auth/` | Hub concern (auth source) |
| `server-remote/src/remote.ts` | `server-hub/src/hub.ts` | Rename, simplify |
| `server-local/src/workspace/` | `server-sidecar/src/workspace/` | Sidecar concern |
| `server-local/src/opencode/` | `server-sidecar/opencode/` | Sidecar concern (separate export) |
| `server-local/src/auth/local-auth.ts` | `server-sidecar/src/auth/` | Sidecar concern (auth consumer) |
| `server-local/src/local.ts` | `server-sidecar/src/sidecar.ts` | Rename, simplify |

### What Gets Deleted

- `server-remote/` package: replaced by `server-hub/`
- `server-local/` package: replaced by `server-sidecar/`

### What Stays Unchanged

- `sync-core/`: gains discovery + providers, otherwise unchanged
- `server-elysia/`: loses discovery + providers, keeps Elysia sync/auth plugins
- `sync/` (client-side provider): unchanged
- `workspace/`: unchanged

---

## Hub Contract

Both hub implementations (Cloudflare and self-hosted) expose the same external interface:

### Endpoints

| Method | Path | Description |
|---|---|---|
| `WS` | `/rooms/:room` | WebSocket Y.Doc sync (token via `?token=` query param) |
| `POST` | `/rooms/:room` | HTTP sync (state vector exchange) |
| `GET` | `/rooms/:room` | Fetch full document snapshot |
| `GET` | `/rooms` | List active rooms |
| `POST` | `/ai/chat` | SSE AI chat streaming |
| `ALL` | `/proxy/:provider/*` | Transparent AI provider proxy |
| `GET` | `/` | Health check / discovery (`{ mode: 'hub', ... }`) |

### Auth Endpoints (mode-dependent)

| Mode | Endpoints |
|---|---|
| `none` | No auth routes |
| `token` | No auth routes (token validated in middleware) |
| `betterAuth` | `POST /auth/sign-up/email`, `POST /auth/sign-in/email`, `GET /auth/get-session`, `POST /auth/sign-out` |

### Sidecar → Hub Auth Contract

The sidecar validates tokens by calling the hub. The contract is:

```
GET {hubUrl}/auth/get-session
Authorization: Bearer {token}

→ 200 { user: { ... } }    (valid)
→ 401                       (invalid)
```

This works for both Better Auth hubs (which implement this natively) and token-mode hubs (which can implement a minimal `/auth/get-session` that checks the token). The sidecar doesn't need to know which auth mode the hub uses.

---

## Sidecar Contract

### Endpoints

| Method | Path | Description |
|---|---|---|
| `WS` | `/rooms/:room` | WebSocket Y.Doc sync (workspace-backed + ephemeral) |
| `GET` | `/` | Discovery (`{ mode: 'sidecar', workspaces: [...], actions: [...] }`) |
| `GET` | `/workspaces/:id` | Workspace metadata |
| `GET/PUT/PATCH/DELETE` | `/workspaces/:id/tables/:table/:rowId` | Table CRUD |
| `GET/PUT/DELETE` | `/workspaces/:id/kv/:key` | KV operations |
| `GET/POST` | `/workspaces/:id/actions/:path` | Action invocation (query/mutation) |

### Auth

Always `remote` mode. Extracts Bearer token from requests, validates against hub's `/auth/get-session`. Caches results (5-minute TTL, stale-while-revalidate on network failure).

---

## Auth Strategy Per Tier

| Tier | Hub Auth | Sidecar Auth | Notes |
|---|---|---|---|
| 1 (Hosted) | Better Auth (you own DB) | Delegates to Cloudflare hub | You control everything |
| 2 (Self-hosted) | Token mode | Delegates to self-hosted hub | `AUTH_TOKEN` env var, simple |
| 3 (Enterprise) | Better Auth + OIDC | Delegates to self-hosted hub | Enterprise IdP (Okta, Azure AD) |

### Token Mode Hub: Session Validation

For token-mode hubs, the sidecar needs to validate tokens via `GET /auth/get-session`. The hub should implement a minimal handler:

```typescript
// In token-mode hub, mount a minimal session endpoint
app.get('/auth/get-session', ({ headers, status }) => {
  const token = extractBearerToken(headers.authorization)
  if (!token || token !== expectedToken) return status(401)
  return { user: { id: 'token-user', name: 'Token User' } }
})
```

This ensures the sidecar's remote auth validation works uniformly against any hub, regardless of auth mode.

---

## Extensibility Model

Users extend the sidecar, never the hub. The sidecar is a library (npm package), not a compiled binary.

### Self-Hosted Hub Entry Point (Tier 2/3)

```typescript
import { createHub } from '@epicenter/server-hub'

const hub = createHub({
  auth: { mode: 'token', token: process.env.AUTH_TOKEN },
  ai: true,
  proxy: true,
})

hub.start()
```

### Sidecar Entry Point (All Tiers)

```typescript
import { createSidecar } from '@epicenter/server-sidecar'
import { createWorkspace, defineTable, defineMutation } from '@epicenter/workspace'

const workspace = createWorkspace({
  tables: {
    todos: defineTable({ title: Type.String(), done: Type.Boolean() }),
  },
  actions: {
    addTodo: defineMutation({
      input: Type.Object({ title: Type.String() }),
      handler: ({ input, tables }) => {
        tables.todos.set(crypto.randomUUID(), { title: input.title, done: false })
      },
    }),
  },
})

const sidecar = createSidecar({
  hubUrl: process.env.HUB_URL ?? 'https://sync.epicenter.dev',
  workspace: { clients: [workspace] },
})

sidecar.start()
```

---

## Migration Path

### Phase 1: Restructure Packages

1. [x] Move `discovery/` (directory: `index.ts` + `awareness.ts`) and `providers.ts` from `server-elysia` to `sync-core`
   > `server-elysia` re-exports from `sync-core` for backward compat until consumers are updated.
2. [x] Rename `server-remote` → `server-hub`, update factory to `createHub()`
3. [x] Rename `server-local` → `server-sidecar`, update factory to `createSidecar()`
4. [x] Add minimal `/auth/get-session` endpoint to token-mode hubs
5. [x] Update all workspace imports in consuming packages
6. [x] Verify all tests pass (115 pass)

### Phase 2: Cloudflare Hub (Hono + Durable Objects)

See [Cloudflare Hub Design](#cloudflare-hub-design) below for the full architecture.

- [x] Package scaffolding (`@epicenter/server-cloudflare`, wrangler.toml, tsconfig)
- [x] `DOSqliteSyncStorage` implementing `SyncStorage` with DO SQLite
- [x] `YjsRoom` Durable Object with WebSocket Hibernation API
- [x] Better Auth with PlanetScale PG (Hyperdrive) + KV session cache
- [x] Auth middleware (bearer token + query param)
- [x] AI chat handler with SSE passthrough
- [x] Provider proxy with key injection
- [x] Hono worker entry point composing all routes

### Phase 3: Enterprise Auth

1. Add OIDC/SAML plugin configuration to `server-hub` auth
2. Better Auth already has plugins for this: expose config surface
3. Test with Okta, Azure AD, Google Workspace
4. Document enterprise deployment guide

---

## Cloudflare Hub Design

The Cloudflare hub is a Hono application deployed as a Cloudflare Worker, with one Durable Object per sync room. It consumes `@epicenter/sync` handlers directly, no Elysia dependency.

### System Topology

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (Hono)                                    │
│                                                              │
│  GET   /                     → health / discovery            │
│  ALL   /auth/*               → Better Auth handler (PG)      │
│  WS    /rooms/:room          → forward to YjsRoom DO stub   │
│  POST  /rooms/:room          → forward to YjsRoom DO stub   │
│  GET   /rooms/:room          → forward to YjsRoom DO stub   │
│  POST  /ai/chat              → SSE streaming (streamSSE)     │
│  ALL   /proxy/:provider/*    → AI provider key injection     │
│  POST  /migrate              → Better Auth PG migrations      │
│                                                              │
│  Bindings:                                                   │
│    HYPERDRIVE: Hyperdrive      (PlanetScale PG via Hyperdrive)│
│    YJS_ROOM    : DurableObjectNamespace                      │
│    SESSION_KV  : KVNamespace           (session cache)       │
│    AUTH_SECRET  : string               (Better Auth secret)  │
│    OPENAI_API_KEY, ANTHROPIC_API_KEY, ... : string           │
│                                                              │
└──────────┬───────────────────────────────────────────────────┘
           │ stub.fetch(request)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  YjsRoom Durable Object (one per room ID)                    │
│                                                              │
│  WebSocket Hibernation API:                                  │
│    fetch()           → upgrade to WS, acceptWebSocket        │
│    webSocketMessage  → handleWsMessage from sync-core        │
│    webSocketClose    → handleWsClose from sync-core          │
│                                                              │
│  HTTP (forwarded from worker):                               │
│    POST /rooms/:room → handleHttpSync(storage, ...)          │
│    GET  /rooms/:room → handleHttpGetDoc(storage, ...)        │
│                                                              │
│  State:                                                      │
│    Y.Doc + Awareness   (in-memory, rebuilt on wake)          │
│    DO SQLite storage   (persistent, survives hibernation)    │
│                                                              │
│  Lifecycle:                                                  │
│    Hibernates when idle → zero compute cost                  │
│    Wakes on message/request → rebuilds doc from SQLite       │
│    Auto ping/pong via setWebSocketAutoResponse               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Why One Durable Object Per Room

This maps directly to the `RoomManager` concept from sync-core, but Cloudflare manages the lifecycle:

- **Location affinity**: the DO runs near the first client that connects, minimizing latency
- **WebSocket Hibernation**: connections stay alive while the DO pays zero compute when idle. Replaces the `evictionTimer` pattern in `rooms.ts`: Cloudflare evicts and restores automatically
- **Built-in persistence**: DO SQLite storage survives hibernation and restarts, answering Open Question #4 (hub persistence) for free
- **No room routing logic**: each room ID maps 1:1 to a DO instance via `idFromName(roomId)`
- **Isolation**: one misbehaving room can't affect others (unlike the current `Map<string, Y.Doc>` in `server-remote` where all rooms share a single process)

### Auth Database: PlanetScale Postgres via Hyperdrive

> **Note**: The original spec planned a Phase 1 (Neon) / Phase 2 (PlanetScale) migration path. Phase 1 was skipped: PlanetScale Postgres via Cloudflare Hyperdrive was adopted from day 1. See `specs/20260305T180000-neon-to-planetscale-hyperdrive.md` for the migration details.

Better Auth uses Kysely internally and expects transaction support. [D1 does not support transactions](https://github.com/better-auth/better-auth/discussions/7487), which causes runtime failures in Better Auth's session and account management code. This is a [known unresolved issue](https://kemalyilmaz.com/blog/setting-up-better-auth-with-cloudflare-workers-d1-kysely/) with no clean workaround.

**PlanetScale Postgres** (GA September 2025) provides managed PostgreSQL with sharding, replication, and branching workflows. Cloudflare Hyperdrive proxies TCP connections from Workers with connection pooling, and its `localConnectionString` config routes `wrangler dev` to local Postgres: same driver code everywhere, zero conditional logic.

The driver is `postgres` (postgres.js) + `drizzle-orm/postgres-js`. The Worker uses `env.HYPERDRIVE.connectionString`; CLI tools use `DATABASE_URL` from `.dev.vars`.

Edge latency is irrelevant here: KV session caching handles 99% of auth reads at sub-millisecond. The database is only hit on sign-up, sign-in, and session refresh.

### Cloudflare Bindings

| Binding | Type | Purpose |
|---|---|---|
| `HYPERDRIVE` | Binding | PlanetScale Postgres via Cloudflare Hyperdrive |
| `YJS_ROOM` | `DurableObjectNamespace` | One DO per sync room |
| `SESSION_KV` | `KVNamespace` | Better Auth `SecondaryStorage`: session cache with TTL |
| `AUTH_SECRET` | Secret | Better Auth signing secret |
| `OPENAI_API_KEY` | Secret | AI provider proxy |
| `ANTHROPIC_API_KEY` | Secret | AI provider proxy |

### Package Structure

```
packages/server-cloudflare/
  src/
    worker.ts               # Hono app entry point, route composition
    auth/
      better-auth.ts        # Better Auth instance factory (PostgreSQL + bearer + KV secondary storage)
      middleware.ts          # Hono middleware: extract token, validate session, set context
      migrate.ts             # POST /migrate endpoint for PostgreSQL schema migrations
    sync/
      yjs-room.ts            # YjsRoom Durable Object class (WebSocket Hibernation)
      storage.ts             # DOSqliteSyncStorage implementing SyncStorage interface
    ai/
      chat.ts                # POST /ai/chat: SSE streaming (raw body passthrough)
    proxy/
      handler.ts             # ALL /proxy/:provider/*: key injection + fetch forwarding
  wrangler.toml              # Bindings, DO migrations, compatibility flags
  package.json
  tsconfig.json
```

Dependencies:

```json
{
  "dependencies": {
    "@epicenter/sync": "workspace:*",
    "hono": "^4",
    "better-auth": "^1",
    "postgres": "^3.4",
    "yjs": "^13",
    "y-protocols": "^1"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "wrangler": "^3"
  }
}
```

No dependency on `server-elysia`, `elysia`, or `bun-types`. Uses `postgres` (postgres.js) for PostgreSQL connectivity via Cloudflare Hyperdrive (TCP proxy with connection pooling). Local dev uses Hyperdrive's `localConnectionString` to connect directly to local Postgres.

### Worker Implementation

#### Entry Point (`worker.ts`)

```typescript
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth } from './auth/better-auth'
import { createAuthMiddleware } from './auth/middleware'
import { createMigrateHandler } from './auth/migrate'
import { createAiChatHandler } from './ai/chat'
import { createProxyHandler } from './proxy/handler'
import { YjsRoom } from './sync/yjs-room'

type Bindings = {
  HYPERDRIVE: Hyperdrive
  YJS_ROOM: DurableObjectNamespace
  SESSION_KV: KVNamespace
  AUTH_SECRET: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GEMINI_API_KEY?: string
}

type Variables = {
  user: { id: string; name: string; email: string }
  session: { id: string; token: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// --- CORS ---
// Skip CORS for WebSocket upgrades: Hono's CORS middleware modifies response
// headers, which conflicts with the immutable 101 WebSocket upgrade response
// returned from Durable Object stubs. This is a known Hono gotcha.
app.use('*', async (c, next) => {
  if (c.req.header('upgrade') === 'websocket') return next()
  return cors({
    origin: (origin) => origin,  // configured per-deployment via trustedOrigins in Better Auth
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })(c, next)
})

// --- Health / Discovery ---
app.get('/', (c) => c.json({ mode: 'hub', runtime: 'cloudflare', version: '0.1.0' }))

// --- Better Auth ---
// Use app.on() instead of app.mount(): mount() strips the base path before
// forwarding, which breaks Better Auth's internal routing when basePath is '/auth'.
// app.on() passes c.req.raw with the full URL intact, so Better Auth sees
// /auth/sign-in/email as expected. This matches the official Hono example:
// https://hono.dev/examples/better-auth-on-cloudflare
app.on(['GET', 'POST'], '/auth/*', (c) => {
  return createAuth(c.env).handler(c.req.raw)
})

// --- DB Migrations (protected, deploy-time only) ---
app.post('/migrate', createMigrateHandler())

// --- Auth middleware for protected routes ---
const authGuard = createAuthMiddleware()
app.use('/rooms/*', authGuard)
app.use('/ai/*', authGuard)
app.use('/proxy/*', authGuard)

// --- Sync rooms (forward to Durable Object) ---
app.all('/rooms/:room', async (c) => {
  const roomId = c.req.param('room')
  const id = c.env.YJS_ROOM.idFromName(roomId)
  const stub = c.env.YJS_ROOM.get(id)
  return stub.fetch(c.req.raw)
})

// --- AI Chat (SSE streaming) ---
app.post('/ai/chat', createAiChatHandler())

// --- Provider Proxy ---
app.all('/proxy/:provider/*', createProxyHandler())

export default app
export { YjsRoom }
```

Key design decisions:
- `app.on(['GET', 'POST'], '/auth/*', handler)` is used for Better Auth instead of `app.mount()`. `mount()` strips the base path before forwarding, which breaks Better Auth's routing when `basePath: '/auth'` is set: it would receive `/sign-in/email` but expect `/auth/sign-in/email`. Using `app.on()` with `c.req.raw` passes the full URL intact. This follows [the official Hono pattern](https://hono.dev/examples/better-auth-on-cloudflare).
- Auth middleware runs *before* DO forwarding. The DO never validates tokens: that's the worker's job.
- Room routes use `app.all()` to forward both WebSocket upgrades and HTTP sync requests to the same DO stub.

#### Auth Middleware (`auth/middleware.ts`)

```typescript
import { createMiddleware } from 'hono/factory'
import { extractBearerToken } from '@epicenter/sync'
import { createAuth } from './better-auth'

export function createAuthMiddleware() {
  return createMiddleware(async (c, next) => {
    // WebSocket: token in query string. HTTP: token in Authorization header.
    const token = c.req.query('token')
      ?? extractBearerToken(c.req.header('authorization'))

    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    const auth = createAuth(c.env)
    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    })

    if (!result) return c.json({ error: 'Unauthorized' }, 401)

    c.set('user', result.user)
    c.set('session', result.session)
    await next()
  })
}
```

Note: `extractBearerToken` is already exported from `@epicenter/sync`: zero new auth code needed.

#### Better Auth Factory (`auth/better-auth.ts`)

```typescript
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import postgres from 'postgres'

// Module-level cache. Cloudflare Workers reuse isolates across requests,
// so this avoids re-creating the auth instance on every request.
let cached: { auth: ReturnType<typeof betterAuth>; cacheKey: string } | null = null

export function createAuth(env: {
  HYPERDRIVE: Hyperdrive
  SESSION_KV: KVNamespace
  AUTH_SECRET: string
}) {
  // Cache per isolate: env strings are stable within a Worker isolate
  if (cached && cached.cacheKey === env.HYPERDRIVE.connectionString) return cached.auth

  const auth = betterAuth({
    database: {
      // Better Auth's built-in Kysely adapter supports PostgreSQL natively.
      // PlanetScale Postgres via Hyperdrive (TCP proxy with connection pooling).
      type: 'postgres',
      url: env.HYPERDRIVE.connectionString,
    },
    basePath: '/auth',
    secret: env.AUTH_SECRET,
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,   // 7 days
      updateAge: 60 * 60 * 24,        // 1 day
      // storeSessionInDatabase left as default (true): see rationale below.
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,               // 5 min
        strategy: 'jwe',              // encrypted, not just signed
      },
    },
    plugins: [
      bearer(),                   // enables Authorization: Bearer <token> (converts to cookie internally)
    ],
    // Cloudflare KV as secondary storage for session caching.
    // Bearer-token clients (mobile, Tauri) can't use cookieCache, so KV
    // handles their session lookups at the edge (~5ms) instead of hitting
    // the database (~50-100ms). Browser clients benefit from cookieCache (zero
    // lookup) with KV as fallback when the cookie expires.
    secondaryStorage: {
      get: (key) => env.SESSION_KV.get(key),
      set: (key, value, ttl) => env.SESSION_KV.put(key, value, {
        expirationTtl: ttl ?? 60 * 5,   // default 5 min
      }),
      delete: (key) => env.SESSION_KV.delete(key),
    },
  })

  cached = { auth, cacheKey: env.HYPERDRIVE.connectionString }
  return auth
}
```

#### Session Performance: Three-Tier Caching Strategy

The hub serves three client types with different auth capabilities. The caching strategy is layered to optimize each:

| Layer | Mechanism | Clients served | Lookup cost | Fallback |
|---|---|---|---|---|
| **L1: cookieCache (JWE)** | Encrypted session in `session_data` cookie | Browsers only | Zero (crypto verify) | L2 |
| **L2: KV secondaryStorage** | Edge-cached session in Cloudflare KV | Mobile, Tauri, browser (cookie expired) | ~5ms edge read | L3 |
| **L3: PlanetScale database** | Source of truth | Cache miss / cross-edge propagation | ~50-100ms |: |

**Why cookieCache uses JWE**: The `jwt` and `compact` strategies produce signed but readable tokens: session data (user ID, email) would be visible in browser DevTools. `jwe` encrypts the payload using AES-256-CBC-HS512 with HKDF key derivation, so the cookie is opaque. The trade-off is slightly larger cookies (~200 bytes more), which is negligible.

**Why `storeSessionInDatabase` stays `true`**: This is a multi-device sync app. A user might sign in on their phone (hitting Cloudflare edge in Frankfurt) and open the desktop app 10 seconds later (hitting edge in London). KV is eventually consistent with ~60 second propagation delay. Without the database fallback, the desktop app would get a 401 during the propagation window. Keeping database writes ensures the database fallback always has the session.

**Why KV and not something else**: Better Auth's `secondaryStorage` interface is `get(key)`, `set(key, value, ttl)`, `delete(key)`: this maps 1:1 to Cloudflare KV. Alternatives considered:
- **D1** (SQLite at edge): SQL is the wrong abstraction for key-value session data, adds query overhead
- **Durable Objects**: Per-instance state, no global read caching, overkill for session lookup
- **Upstash Redis**: Equivalent semantics but adds a separate vendor, separate bill, higher latency than edge-cached KV
- **No cache**: Every bearer-token request hits the database (~50-100ms). Acceptable at low scale, expensive at high scale

**Cost**: KV is included in the Workers Paid plan ($5/mo) with 10M reads/mo and 1M writes/mo. Session data is tiny (<1KB per key). At 1,000 DAU × 50 requests/day, monthly KV reads are ~1.5M: well within the included tier. The KV cost is effectively $0 while reducing database compute by ~99% for session-related queries.

#### Migrations (`auth/migrate.ts`)

Migrations can run programmatically via a worker endpoint, or locally via `npx @better-auth/cli migrate` (PlanetScale Postgres is accessible from anywhere via connection string, no Worker runtime required).

```typescript
import { createAuth } from './better-auth'
import { getMigrations } from 'better-auth/db/migration'

export function createMigrateHandler() {
  return async (c) => {
    const auth = createAuth(c.env)
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options)

    if (toBeCreated.length === 0 && toBeAdded.length === 0) {
      return c.json({ message: 'No migrations needed' })
    }

    await runMigrations()
    return c.json({
      message: 'Migrations completed',
      created: toBeCreated.map((t) => t.table),
      added: toBeAdded.map((t) => t.table),
    })
  }
}
```

This endpoint should be protected in production (e.g., behind a deploy secret or run only via `wrangler` scripts).

### YjsRoom Durable Object

This is the core component. Each DO instance manages one Y.Doc sync room using the WebSocket Hibernation API and sync-core handlers.

#### Design Constraints from Cloudflare

1. **No `setTimeout`/`setInterval`**: timers prevent hibernation. The existing Elysia adapter's 30s ping interval is replaced by `setWebSocketAutoResponse` (auto ping/pong without waking the DO).
1. **No `onOpen` event**: Cloudflare Workers WebSocket adapter does not fire `onOpen`. Initial sync messages must be sent inline during the upgrade in `fetch()`, not in a separate callback. Do not add a `webSocketOpen()` handler: it won't fire.
2. **Constructor runs on every wake**: minimize initialization. Rebuild in-memory state lazily or via `blockConcurrencyWhile`.
3. **`serializeAttachment` for per-connection state**: max 2,048 bytes per WebSocket. Store the `ConnectionState` fields needed to survive hibernation.
4. **Binary messages**: `WebSocket.send()` accepts `ArrayBuffer | string`. sync-core produces `Uint8Array`. Need `ws.send(data.buffer)` or spread into `ArrayBuffer`.
5. **Message batching**: each WS message incurs a context switch. For high-frequency Y.Doc updates, consider batching into single frames.

#### Connection State Serialization

sync-core's `ConnectionState` includes:
- `roomId: string`: known (one room per DO)
- `doc: Y.Doc`: rebuilt from storage on wake, shared across connections
- `awareness: Awareness`: rebuilt, shared
- `updateHandler: Function`: recreated on wake (closure over `send`)
- `controlledClientIds: Set<number>`: must survive hibernation
- `connId: object`: use the `WebSocket` reference itself

Only `controlledClientIds` needs serialization. The rest is either fixed per-DO or recreated.

```typescript
// Serialized into WebSocket attachment (max 2,048 bytes)
type WsAttachment = {
  controlledClientIds: number[]
}
```

#### Implementation (`sync/yjs-room.ts`)

```typescript
import { DurableObject } from 'cloudflare:workers'
import * as Y from 'yjs'
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness'
import {
  handleWsOpen,
  handleWsMessage,
  handleWsClose,
  handleHttpSync,
  handleHttpGetDoc,
  createRoomManager,
  type ConnectionState,
} from '@epicenter/sync'
import { DOSqliteSyncStorage } from './storage'

// Use `type` not `interface`: interfaces cause issues with Hono/DO type generics.
type Env = {
  // DO doesn't need auth bindings: worker validates before forwarding
}

export class YjsRoom extends DurableObject {
  private storage: DOSqliteSyncStorage
  private roomManager!: ReturnType<typeof createRoomManager>
  private connectionStates: Map<WebSocket, ConnectionState>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.storage = new DOSqliteSyncStorage(ctx.storage)
    this.connectionStates = new Map()

    // Auto ping/pong without waking the DO.
    // Replaces the 30s setInterval ping in the Elysia adapter.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    )

    // Load the Y.Doc from SQLite and initialize the RoomManager synchronously
    // inside blockConcurrencyWhile. This ensures the doc is ready before any
    // fetch() or webSocketMessage() runs.
    //
    // Why not use createRoomManager({ getDoc })?
    // sync-core's getDoc is synchronous: (roomId: string) => Y.Doc | undefined.
    // But loading from SQLite is async. Instead, we pre-load the doc here and
    // pass it to createRoomManager via getDoc returning the pre-loaded instance.
    // This also avoids carrying RoomManager's eviction logic, which is irrelevant
    // in DOs (Cloudflare manages the lifecycle). See Open Question #7.
    this.ctx.blockConcurrencyWhile(async () => {
      const doc = await this.loadOrCreateDoc('room')

      this.roomManager = createRoomManager({
        getDoc: () => doc,  // always return the pre-loaded doc (one room per DO)
      })

      // On wake from hibernation, restore connection state from attachments.
      // getWebSockets() returns all still-connected WebSockets.
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as WsAttachment | null
        if (!attachment) continue

        const send = (data: Uint8Array) => {
          try { ws.send(data) } catch { /* disconnected during wake */ }
        }
        const result = handleWsOpen(this.roomManager, 'room', ws, send)
        if (result.ok) {
          result.state.controlledClientIds = new Set(attachment.controlledClientIds)
          result.state.doc.on('update', result.state.updateHandler)
          this.connectionStates.set(ws, result.state)
        }
      }
    })
  }

  private async loadOrCreateDoc(roomId: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    const updates = await this.storage.getAllUpdates(roomId)
    if (updates.length > 0) {
      const merged = Y.mergeUpdatesV2(updates)
      Y.applyUpdateV2(doc, merged)
    }

    // Persist incremental updates to SQLite.
    doc.on('updateV2', async (update: Uint8Array) => {
      await this.storage.appendUpdate(roomId, update)
    })

    return doc
  }

  // --- WebSocket upgrade (called from worker via stub.fetch) ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request)
    }

    // HTTP sync: POST
    if (request.method === 'POST') {
      const body = new Uint8Array(await request.arrayBuffer())
      const roomId = 'room'  // one room per DO
      const result = await handleHttpSync(this.storage, roomId, body)
      if (!result.body) return new Response(null, { status: result.status })
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }

    // HTTP sync: GET (document snapshot)
    if (request.method === 'GET') {
      const result = await handleHttpGetDoc(this.storage, 'room')
      if (!result.body) return new Response(null, { status: 404 })
      return new Response(result.body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }

    return new Response('Method not allowed', { status: 405 })
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept with Hibernation API: DO can sleep while connection stays alive
    this.ctx.acceptWebSocket(server)

    const send = (data: Uint8Array) => server.send(data)
    const result = handleWsOpen(this.roomManager, 'room', server, send)

    if (!result.ok) {
      server.close(result.closeCode, result.closeReason)
      return new Response(null, { status: 400 })
    }

    // Wire doc update broadcaster
    result.state.doc.on('update', result.state.updateHandler)
    this.connectionStates.set(server, result.state)

    // Persist empty attachment (no controlled client IDs yet)
    server.serializeAttachment({ controlledClientIds: [] } satisfies WsAttachment)

    // Send initial sync messages (SyncStep1 + awareness states)
    for (const msg of result.initialMessages) {
      server.send(msg)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  // --- Hibernation API callbacks ---

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const state = this.connectionStates.get(ws)
    if (!state) return  // unknown connection, ignore

    const data = message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new TextEncoder().encode(message)

    const result = handleWsMessage(data, state)

    // Send direct response (e.g., SyncStep2 reply)
    if (result.response) {
      ws.send(result.response)
    }

    // Broadcast to all other connections (e.g., awareness update)
    if (result.broadcast) {
      for (const [otherWs] of this.connectionStates) {
        if (otherWs !== ws) {
          try { otherWs.send(result.broadcast) } catch { /* dead connection */ }
        }
      }
    }

    // Persist updated controlledClientIds for hibernation survival
    ws.serializeAttachment({
      controlledClientIds: [...state.controlledClientIds],
    } satisfies WsAttachment)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const state = this.connectionStates.get(ws)
    if (!state) return

    handleWsClose(state, this.roomManager)
    this.connectionStates.delete(ws)

    // Compact storage when last connection leaves.
    // The DO will hibernate after this: compaction ensures fast doc reload on next wake.
    if (this.connectionStates.size === 0) {
      await this.storage.compactAll('room')
    }

    ws.close(code, reason)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Treat errors as disconnections
    await this.webSocketClose(ws, 1011, 'WebSocket error', false)
  }
}

type WsAttachment = {
  controlledClientIds: number[]
}
```

#### Adaptation from Elysia Adapter

| Elysia adapter pattern | Cloudflare DO equivalent |
|---|---|
| `ws.raw` as connection key (`object`) | `WebSocket` server object as map key |
| `WeakMap<object, state>` per connection | `Map<WebSocket, ConnectionState>` |
| `setInterval(30s)` ping/pong | `setWebSocketAutoResponse('ping', 'pong')`: zero-cost, never wakes DO |
| `ws.sendBinary(data)` | `ws.send(data)`: accepts `Uint8Array` |
| `queueMicrotask` for initial messages | Direct `ws.send()` after `acceptWebSocket` (no `webSocketOpen` callback: `onOpen` is not supported on CF Workers) |
| `roomManager.broadcast(roomId, data, excludeRaw)` | Manual iteration over `connectionStates` map |
| Eviction timer (60s after last disconnect) | Cloudflare manages hibernation/eviction automatically |

### DO SQLite Storage (`sync/storage.ts`)

Implements `SyncStorage` from sync-core using the DO's built-in SQLite database. SQLite in Durable Objects is GA with 10GB per DO.

```typescript
import * as Y from 'yjs'
import type { SyncStorage } from '@epicenter/sync'

export class DOSqliteSyncStorage implements SyncStorage {
  private initialized = false

  constructor(private storage: DurableObjectStorage) {}

  private ensureTable(): void {
    if (this.initialized) return
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `)
    this.initialized = true
  }

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    this.ensureTable()
    this.storage.sql.exec(
      'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
      docId, update
    )
  }

  async getAllUpdates(docId: string): Promise<Uint8Array[]> {
    this.ensureTable()
    const cursor = this.storage.sql.exec(
      'SELECT data FROM updates WHERE doc_id = ? ORDER BY id',
      docId
    )
    return cursor.toArray().map((row) => row.data as Uint8Array)
  }

  async compact(docId: string, mergedUpdate: Uint8Array): Promise<void> {
    this.ensureTable()
    // Transactional: delete all existing updates, insert single compacted one.
    // DO SQLite supports transactionSync for atomic operations.
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM updates WHERE doc_id = ?', docId)
      this.storage.sql.exec(
        'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
        docId, mergedUpdate
      )
    })
  }

  /** Compact all updates for a doc: called on last disconnect before hibernation. */
  async compactAll(docId: string): Promise<void> {
    const updates = await this.getAllUpdates(docId)
    if (updates.length <= 1) return

    // Use static import: yjs is already a dependency of this package.
    // Dynamic import('yjs') adds unnecessary latency.
    const merged = Y.mergeUpdatesV2(updates)
    await this.compact(docId, merged)
  }
}
```

Why SQLite over DO KV storage:
- Ordered retrieval (`ORDER BY id`) without key-naming hacks
- Atomic compaction via `transactionSync`
- Schema flexibility for future metadata (timestamps, sizes, compaction stats)
- Query capability (e.g., `SELECT COUNT(*) FROM updates` for monitoring)

### AI Chat Handler (`ai/chat.ts`)

Streams the provider's SSE response body directly to the client. Unlike the proxy handler (which forwards arbitrary provider APIs), the chat handler selects the provider and injects the API key based on the request body.

Do **not** re-parse and re-emit SSE events via `streamSSE`: that drops `event:`, `id:`, and `retry:` fields, and breaks multi-line `data:` values. Stream the raw response body through instead (same pattern as the proxy handler).

```typescript
export function createAiChatHandler() {
  return async (c) => {
    const body = await c.req.json()

    // Forward to provider (Anthropic, OpenAI, etc.)
    const providerResponse = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.ANTHROPIC_API_KEY}`, ... },
      body: JSON.stringify(body),
    })

    // Stream the raw SSE response body through: don't re-parse.
    // Re-parsing (splitting by \n, matching 'data: ' prefix) would drop
    // event/id/retry fields and break multi-line data values.
    return new Response(providerResponse.body, {
      status: providerResponse.status,
      headers: {
        'content-type': providerResponse.headers.get('content-type') ?? 'text/event-stream',
      },
    })
  }
}
```

### Provider Proxy (`proxy/handler.ts`)

Same pattern as `server-remote/src/proxy/plugin.ts`: validate provider, swap auth header with real API key, forward request, stream response.

```typescript
const PROVIDER_CONFIG = {
  openai:    { envKey: 'OPENAI_API_KEY',    baseUrl: 'https://api.openai.com',          authHeader: 'authorization',  format: 'Bearer' },
  anthropic: { envKey: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com',       authHeader: 'x-api-key',      format: 'raw' },
  gemini:    { envKey: 'GEMINI_API_KEY',    baseUrl: 'https://generativelanguage.googleapis.com', authHeader: 'authorization', format: 'Bearer' },
  grok:      { envKey: 'GROK_API_KEY',      baseUrl: 'https://api.x.ai',               authHeader: 'authorization',  format: 'Bearer' },
} as const

export function createProxyHandler() {
  return async (c) => {
    const provider = c.req.param('provider')
    const config = PROVIDER_CONFIG[provider]
    if (!config) return c.json({ error: `Unknown provider: ${provider}` }, 400)

    const apiKey = c.env[config.envKey]
    if (!apiKey) return c.json({ error: `${provider} not configured` }, 503)

    // Build target URL: /proxy/openai/v1/chat/completions → https://api.openai.com/v1/chat/completions
    const subpath = c.req.path.replace(`/proxy/${provider}`, '')
    const targetUrl = `${config.baseUrl}${subpath}`

    // Clone headers, replace session token with real API key
    const headers = new Headers(c.req.raw.headers)
    headers.delete('authorization')
    const value = config.format === 'Bearer' ? `Bearer ${apiKey}` : apiKey
    headers.set(config.authHeader, value)

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
    })

    // Stream response back (supports SSE from AI providers)
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      },
    })
  }
}
```

### Wrangler Configuration

```toml
name = "epicenter-hub"
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]   # Required for Better Auth (AsyncLocalStorage)

# --- KV: Session cache (Better Auth SecondaryStorage) ---
[[kv_namespaces]]
binding = "SESSION_KV"
id = "<your-kv-id>"

# --- Durable Objects ---
[[durable_objects.bindings]]
name = "YJS_ROOM"
class_name = "YjsRoom"

# SQLite-backed DO: persistent storage survives hibernation.
# Use new_sqlite_classes (not new_classes) to enable DO SQLite.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["YjsRoom"]

# --- Secrets (set via `wrangler secret put`) ---
# AUTH_SECRET
# OPENAI_API_KEY
# ANTHROPIC_API_KEY
```

The `nodejs_compat` compatibility flag is required because Better Auth uses `AsyncLocalStorage` internally.

### sync-core Compatibility

sync-core requires **zero changes** to support Cloudflare. The handlers are already framework-agnostic:

| sync-core API | Elysia adapter | Cloudflare DO adapter |
|---|---|---|
| `handleWsOpen(rm, roomId, connId, send)` | `connId = ws.raw` | `connId = ws` (WebSocket server ref) |
| `handleWsMessage(data, state)` | `data = Uint8Array` from Bun WS | `data = new Uint8Array(message)` from DO |
| `handleWsClose(state, rm)` | called from Elysia `close` handler | called from DO `webSocketClose` |
| `handleHttpSync(storage, roomId, body)` | `storage = createMemorySyncStorage()` | `storage = DOSqliteSyncStorage` |
| `RoomManager` connection key type | `object` (ws.raw) | `WebSocket` (also an object) |
| `send` callback signature | `(data: Uint8Array) => void` | `(data: Uint8Array) => void` via `ws.send(data)` |

The only potential issue: Cloudflare's `WebSocket.send()` accepts `string | ArrayBuffer | ArrayBufferView`. `Uint8Array` is an `ArrayBufferView`, so it works directly: no `.buffer` conversion needed.

### Deployment Sequence

1. **Create PostgreSQL + Cloudflare resources**:
   ```bash
   # PlanetScale Postgres (create at https://planetscale.com)
   # Then create Hyperdrive config:
   wrangler hyperdrive create epicenter-db \
     --connection-string="postgres://USER:PASS@HOST:PORT/epicenter?sslmode=require"
   # Paste returned ID into wrangler.toml
   #
   wrangler kv namespace create SESSION_KV
   wrangler secret put AUTH_SECRET
   wrangler secret put OPENAI_API_KEY
   wrangler secret put ANTHROPIC_API_KEY
   ```

2. **Deploy worker**:
   ```bash
   wrangler deploy
   ```

3. **Run migrations** (Better Auth tables: can also run locally via `npx @better-auth/cli migrate`):
   ```bash
   curl -X POST https://epicenter-hub.<your-subdomain>.workers.dev/migrate
   ```

4. **Create first user**:
   ```bash
   curl -X POST https://epicenter-hub.<...>/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     -d '{"email": "admin@example.com", "password": "...", "name": "Admin"}'
   ```

5. **Test sync**: connect a client to `wss://epicenter-hub.<...>/rooms/test-room?token=<session-token>`

### Monitoring and Observability

- **Room listing**: no central registry. Options:
  - Use `wrangler tail` for real-time logs
  - Add a `rooms` KV namespace written on DO first-connect, deleted on last-disconnect
  - Use Workers Analytics Engine for room activity metrics
- **Storage stats**: each DO can expose `GET /rooms/:room/stats` returning update count, total size, last compaction time (read from SQLite)
- **Health**: `GET /` on the worker returns discovery JSON. PostgreSQL and KV health can be checked via optional `/health` endpoint

### Limitations and Tradeoffs

| Constraint | Impact | Mitigation |
|---|---|---|
| DO single-threaded | One room can't use multiple CPU cores | Fine for relay: Y.Doc merge is fast |
| 32,768 concurrent WS per DO | Max 32,768 hibernatable clients per room | More than sufficient for workspace sync |
| Constructor runs on every wake | Must rebuild in-memory state | `blockConcurrencyWhile` + SQLite read is fast (<10ms for typical docs) |
| No `setTimeout`/`setInterval` | Can't do periodic compaction | Compact on last disconnect instead |
| Code deploy disconnects all WS | All clients reconnect on deploy | y-websocket protocol handles reconnection gracefully |
| PostgreSQL latency (~20-50ms) | Auth check on first request | KV session cache (SecondaryStorage) reduces to <1ms |
| 2,048 byte attachment limit | Can't serialize large connection state | Only `controlledClientIds` needs serialization: a few dozen bytes |

### Future Extensions

- **R2 backup**: periodic snapshot of compacted Y.Docs to R2 for disaster recovery
- **DO Alarms**: scheduled compaction at intervals (alternative to compact-on-last-disconnect)
- **Edge caching**: cache HTTP doc snapshots (`GET /rooms/:room`) at the edge with short TTLs
- **Multi-region**: Cloudflare automatically places DOs near first connection. For global teams, consider jurisdiction hints.
- **Rate limiting**: Better Auth has built-in rate limiting. For sync, use DO-level counters.

---

## Open Questions

1. **Package naming**: `server-hub` + `server-sidecar` vs `server-remote` + `server-local`? The new names are more descriptive of the architecture but break existing familiarity. Could also be `server` (hub) + `server-local` (sidecar).

2. **Shared Elysia base**: Both hub and sidecar are Elysia apps. Should `server-elysia` remain as a shared plugin library, or should sync plugins move into `sync-core` as framework-agnostic factories with an Elysia adapter inline in each consumer?

3. **AI on sidecar**: Should the sidecar ever serve AI directly (for offline/local LLM use cases)? Current design says no: AI always goes through the hub. But local LLM inference is a growing use case.

4. **Hub persistence**: ~~Should the self-hosted hub support optional persistence?~~ **Answered for Cloudflare**: DO SQLite provides automatic persistence that survives hibernation. The self-hosted hub could optionally use a SQLite-backed `SyncStorage` impl for parity.

5. **Discovery across tiers**: Device discovery currently uses Yjs Awareness on a shared `_epicenter_discovery` room. This works when all devices connect to the same hub. Does it need changes for the self-hosted model?

6. **OpenCode package**: Should `opencode/` (process spawner) stay in the sidecar package or become its own package? It's not HTTP and doesn't depend on Elysia.

7. ~~**RoomManager reuse in DO**: Each DO is exactly one room. Should the DO use `createRoomManager()` from sync-core?~~ **Resolved.** The DO pre-loads the Y.Doc in `blockConcurrencyWhile` and passes a synchronous `getDoc: () => doc` to `createRoomManager`. This works because sync-core's `getDoc` config is synchronous (`(roomId: string) => Y.Doc | undefined`), not async. The doc must be loaded before the RoomManager is created. Eviction logic is carried but harmless (never triggers since the DO manages its own lifecycle).

8. **Room listing without central registry**: The hub contract specifies `GET /rooms` to list active rooms. In the DO model there's no central index. Options: (a) KV namespace written on DO first-connect/last-disconnect, (b) Workers Analytics Engine, (c) drop the endpoint. This is mainly a debugging/admin feature.

9. ~~**DO connection limit**: Cloudflare allows ~32,768 concurrent hibernatable WebSockets per DO. This is more than sufficient for workspace sync scenarios: no sharding needed.~~ **Resolved.**

10. **Better Auth instance caching**: The current design caches the Better Auth instance at module level in the worker isolate. With postgres.js over Hyperdrive (TCP proxied through Cloudflare), there's no persistent connection to churn: each query is an independent HTTP request. The cache mainly avoids re-constructing the Better Auth config object. This is low-risk.

11. **Migrate endpoint security**: `POST /migrate` runs PostgreSQL schema migrations. In production this should be protected: either by a deploy secret, removed entirely and run via `npx @better-auth/cli migrate` locally against the connection string, or gated behind an admin token. The current spec leaves this open.
