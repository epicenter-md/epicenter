# Deployment Targets: Self-Hosted Bun vs Cloudflare Workers + Durable Objects

**Date**: 2026-02-19
**Status**: Draft (working document)
**Author**: Braden + Claude

> **Topology note (2026-02-26)**: This spec predates the hub/sidecar split. Where it describes a single `createServer()` with AI chat, the current architecture places AI streaming exclusively on `createHubServer()`. The local sidecar (`createLocalServer()`) handles workspace CRUD and sync but NOT AI streaming. "Hosted server" in this doc refers to a cloud deployment of the workspace server, not the hub. See `specs/20260222T195645-network-topology-multi-server-architecture.md` for the authoritative three-tier topology.

## Overview

Epicenter's server needs to run in two environments: as a self-hosted Bun/Elysia process and as Cloudflare Workers with Durable Objects. This document maps the current architecture, catalogs what each target supports, identifies the shared abstractions, and explores how AI chat endpoints (TanStack AI) and authentication fit into both.

## Current Architecture

The server package (`@epicenter/server`) exposes two entry points built on Elysia (Bun-native web framework):

```
createServer (full workspace server)
├── GET  /                                    ← Discovery
├── GET  /openapi                             ← Scalar UI docs
├── GET  /workspaces/:id/tables/:table        ← List rows
├── POST /workspaces/:id/tables/:table        ← Upsert row
├── GET  /workspaces/:id/actions/:action      ← Query actions
├── POST /workspaces/:id/actions/:action      ← Mutation actions
└── WS   /workspaces/:id/ws                   ← Yjs WebSocket sync

createSyncServer (standalone relay)
├── GET  /                                    ← Health
└── WS   /:room/ws                            ← Yjs WebSocket sync
```

The implementation is composed from plugins:

- **`createSyncPlugin`**: Elysia plugin mounting `/:room/ws`. Handles the y-websocket protocol: sync (step1/step2/update), awareness, query-awareness, and a custom sync-status heartbeat (message type 102). Operates in standalone mode (fresh Y.Docs on demand) or integrated mode (resolve docs via `getDoc` callback).
- **`createRoomManager`**: Manages room lifecycle. Each room holds a Y.Doc, an Awareness instance, and a connection map keyed by `ws.raw` (Bun's stable WebSocket identity). 60-second eviction timer after last client disconnects.
- **`createWorkspacePlugin`**: Bundles table CRUD routes and action routing per workspace.
- **`createActionsRouter`**: Maps `defineQuery` → GET and `defineMutation` → POST. Validates input via Standard Schema (`~standard`).
- **Auth**: `AuthConfig` supports `{ token: string }` (shared secret) or `{ verify: (token) => boolean }` (custom validation). Applied during WebSocket upgrade via query parameter `?token=`.

Key detail: the room manager already models the "1 room = 1 document" pattern. Each room owns a single Y.Doc, a single Awareness, and broadcasts updates to all connections except the sender. This maps directly to the Durable Object model.

## Research Findings

### One Durable Object Per Document

Every production Yjs-on-Cloudflare implementation uses one DO per document. This is the universal pattern, not a suggestion.

| Project                 | Pattern           | Details                                                                                                                    |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| y-sweet (Jamsocket)     | 1 DO per document | `y-sweet-core` compiled to WASM, each DO manages one doc, persistence via DO storage + R2                                  |
| PartyKit/PartyServer    | 1 DO per room     | Each `room` ID creates a new `Server extends DurableObject`. PartyServer is now the OSS successor maintained by Cloudflare |
| y-durableobjects        | 1 DO per document | Direct Yjs + DO integration, 227 stars, inspired by y-websocket                                                            |
| Ntiret (real-world app) | 1 DO per document | "Stateful, edge-located WebSocket servers for every document" using Yjs CRDTs                                              |

Why it works: DOs guarantee single-threaded execution (no race conditions on doc state), support Hibernatable WebSockets (clients stay connected while DO sleeps, wake on message, billing stops during hibernation), and co-locate state with connections (no network hop for broadcast).

### Durable Objects: Full Capability Confirmation

DOs support everything we need. Verified against Cloudflare documentation and production examples:

| Capability               | Supported | How                                                                                                   |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------- |
| WebSocket server         | Yes       | Hibernatable WebSocket API (recommended) or standard WebSocket API                                    |
| HTTP endpoints           | Yes       | `fetch()` handler on the DO class receives any HTTP request                                           |
| Outbound fetch (AI APIs) | Yes       | Full `fetch` API available. CF Agents docs explicitly show calling OpenAI, Anthropic, Gemini from DOs |
| Persistent storage       | Yes       | Transactional KV storage built into each DO, plus access to R2/D1                                     |
| Alarms/scheduled tasks   | Yes       | `alarm()` handler for deferred work                                                                   |
| Hibernation              | Yes       | Clients remain connected while DO is evicted from memory. Wake on any event. GB-s billing stops.      |

One caveat: DO geographic location matters for AI API calls. A DO in Hong Kong can't call OpenAI (banned region). Use location hints when creating stubs: `env.WORKSPACE_ROOM.idFromName(roomId, { locationHint: 'wnam' })`.

### y-sweet's Two-Tier Auth

y-sweet's authentication pattern is worth studying because it solves the "how do users get access to a specific document" problem cleanly:

- **Server tokens**: Long-lived, never expire. Used by the application backend to create documents (`POST /doc/new`) and issue client tokens (`POST /doc/{id}/auth`). Never sent to the browser.
- **Client tokens**: Short-lived, document-scoped, encode authorization level (`Full` or `ReadOnly`). Issued by the backend, sent to the browser, used to authenticate WebSocket connections. The DO validates them on connect.

The flow: App backend (trusted) uses server token → calls y-sweet to get a client token for doc X → sends client token to browser → browser connects to DO with that token → DO validates and allows connection.

This two-tier system maps cleanly onto our `AuthConfig`. The `{ verify }` variant already supports custom validation; a JWT-based implementation would check the client token's signature, expiration, and document scope.

### PartyKit/PartyServer Architecture

PartyServer (the open-source successor to PartyKit, now maintained by Cloudflare) provides the clearest reference for how to structure a DO-based room server:

```typescript
export class MyServer extends Server {
	// Called on first connection or wake from hibernation
	async onStart() {
		/* load state from storage */
	}

	// WebSocket lifecycle
	onConnect(connection) {
		/* new client joined */
	}
	onMessage(connection, message) {
		/* handle message */
	}
	onClose(connection) {
		/* client left */
	}

	// HTTP requests (same DO instance)
	async onRequest(request: Request) {
		return new Response('HTTP works too');
	}
}
```

Each room ID creates a separate `Server` instance backed by a DO. The same instance handles both WebSocket and HTTP. The Worker entry point routes requests to the correct DO using `routePartykitRequest()`.

PartyServer supports hibernation (`options.hibernate = true`), which is critical for cost efficiency: idle rooms don't cost anything.

### TanStack AI

TanStack AI is in alpha. It's a provider-agnostic SDK for building AI chat features with streaming. Architecture:

**Server-side**: Framework-agnostic. Two functions:

```typescript
import { chat, toServerSentEventsResponse } from '@tanstack/ai';
import { openaiText } from '@tanstack/ai-openai';

// This is your /chat endpoint
export async function POST(request: Request) {
	const { messages } = await request.json();
	const stream = chat({
		adapter: openaiText('gpt-4o'),
		messages,
	});
	return toServerSentEventsResponse(stream);
}
```

`chat()` returns an async iterable stream. `toServerSentEventsResponse()` converts it to an HTTP Response with SSE headers. Works with any server that returns `Response` objects: Bun, Cloudflare Workers, Node.js, Deno.

**Client-side**: React hooks today (`useChat`, `fetchServerSentEvents`). Svelte adapter not yet available but the core is framework-agnostic. AG-UI protocol for streaming.

**Adapters**: `@tanstack/ai-openai`, `@tanstack/ai-anthropic`, `@tanstack/ai-ollama`, `@tanstack/ai-gemini`. Pluggable.

**Tools**: Isomorphic tool definitions with `toolDefinition()`. Server tools (`.server()`) execute on the backend; client tools (`.client()`) execute in the browser. Built-in approval flow for sensitive operations.

The important takeaway: TanStack AI doesn't require a specific server framework. A `/chat` endpoint is just another route handler that returns an SSE Response. It fits cleanly as a plugin alongside sync and table routes.

### Elysia on Cloudflare Workers

Elysia is Bun-native. It won't run on Cloudflare Workers directly because Workers use the `fetch` handler pattern, not Bun's `serve()`. However, Elysia's plugin architecture means the business logic (sync protocol, room management, table CRUD, action routing) can be extracted into framework-agnostic code and re-wrapped for each target.

The sync protocol (`protocol.ts`) and room manager (`rooms.ts`) already have no Elysia dependency. They're plain TypeScript that operates on `Uint8Array` messages and `Map` data structures. The Elysia dependency lives only in `plugin.ts` (the WebSocket route wiring) and `server.ts` (the HTTP routes).

## Design Decisions

| Decision                        | Choice                                       | Rationale                                                                                               |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1 DO per workspace/document     | Yes, standard                                | Universal pattern. Matches our existing room model. Single-threaded guarantees.                         |
| Shared protocol layer           | Extract from Elysia plugins                  | `protocol.ts` and `rooms.ts` are already framework-agnostic. Action routing logic can be extracted too. |
| Chat endpoint approach          | TanStack AI `chat()` + SSE                   | Framework-agnostic, provider-agnostic. Just another route handler.                                      |
| Auth for self-hosted            | Env vars / in-memory config for AI keys      | User runs the server, it's trusted. Existing `AuthConfig` for client connections.                       |
| Auth for cloud                  | Two-tier tokens (y-sweet pattern)            | Server tokens for admin operations, client tokens per-doc with expiration and scope.                    |
| AI key management (self-hosted) | Server stores keys, client doesn't send them | Keys in env vars or sent once on startup (in-memory only, no disk persistence).                         |
| AI key management (cloud)       | User keys in DO storage or database          | Configured via app settings UI. DO retrieves per-request.                                               |
| Hibernation                     | Required for cloud target                    | Non-negotiable for cost. Idle rooms should cost nothing.                                                |
| Location hints                  | Required for AI-calling DOs                  | Prevent DOs from spawning in regions where AI providers are blocked.                                    |

## Architecture

### Unified Server Surface

Both deployment targets expose the same API surface. The implementation differs, but the contract is identical:

```
┌─────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT TARGETS                        │
├─────────────────────────┬───────────────────────────────────┤
│   Self-Hosted (Bun)     │   Cloud (CF Workers + DOs)        │
├─────────────────────────┼───────────────────────────────────┤
│                         │                                   │
│  createServer()         │  CF Worker (router)               │
│  ├── syncPlugin         │  ├── Auth middleware              │
│  ├── workspacePlugin    │  ├── Route to DO by workspace ID  │
│  ├── chatPlugin (NEW)   │  │                                │
│  └── Elysia app         │  Durable Object (1 per workspace) │
│                         │  ├── Yjs sync (Hibernatable WS)   │
│                         │  ├── Tables (HTTP fetch handler)   │
│                         │  ├── Actions (HTTP fetch handler)  │
│                         │  ├── Chat (HTTP/SSE) (NEW)         │
│                         │  └── Transactional storage         │
└─────────────────────────┴───────────────────────────────────┘
```

### Shared Abstractions

These modules contain zero framework-specific code. They work identically in both targets:

```
packages/server/src/
├── sync/
│   ├── protocol.ts     ← Message encoding/decoding (pure Uint8Array ops)
│   ├── rooms.ts        ← Room lifecycle (Y.Doc, Awareness, connection Map)
│   └── auth.ts         ← Token validation (pure async function)
├── actions.ts          ← Action routing logic (query→GET, mutation→POST)
└── tables.ts           ← Table CRUD logic
```

The framework-specific wiring lives in thin adapter layers:

```
Self-hosted adapter (Elysia):
├── sync/plugin.ts      ← Mounts /:room/ws WebSocket route
├── workspace-plugin.ts ← Mounts /workspaces/:id/tables/* routes
└── server.ts           ← Composes plugins, starts Elysia

Cloud adapter (CF Worker + DO):
├── worker.ts           ← Router: parse URL → get DO stub → stub.fetch()
└── durable-object.ts   ← WorkspaceRoom extends DurableObject
                           ├── fetch() → route to tables/actions/chat
                           ├── webSocketMessage() → sync protocol
                           └── webSocketClose() → cleanup
```

### Request Flow: Self-Hosted

```
Client Request
     │
     ▼
Elysia Router (single process)
     │
     ├── WS /workspaces/:id/ws
     │     └── createSyncPlugin handles y-websocket protocol
     │         └── roomManager.join() → doc, awareness
     │
     ├── GET/POST /workspaces/:id/tables/:table
     │     └── createWorkspacePlugin reads/writes Y.Doc
     │
     ├── GET/POST /workspaces/:id/actions/:action
     │     └── createActionsRouter calls action handler
     │
     └── POST /workspaces/:id/chat  (NEW)
           └── TanStack AI chat() → SSE stream
               └── Uses server-configured API keys (env vars)
```

### Request Flow: Cloudflare Workers + DOs

```
Client Request
     │
     ▼
CF Worker (stateless router)
     │
     ├── Parse /workspaces/:id/...
     ├── Auth check (JWT / session)
     ├── const stub = env.WORKSPACE_ROOM.get(
     │     env.WORKSPACE_ROOM.idFromName(id, { locationHint: 'wnam' })
     │   )
     └── return stub.fetch(request)
           │
           ▼
     Durable Object (stateful, 1 per workspace)
           │
           ├── WebSocket upgrade → Hibernatable WS
           │     └── webSocketMessage() handles sync protocol
           │         └── Same protocol.ts code as self-hosted
           │
           ├── GET/POST /tables/:table
           │     └── Read/write Y.Doc (same logic)
           │
           ├── GET/POST /actions/:action
           │     └── Call action handler (same logic)
           │
           └── POST /chat  (NEW)
                 └── TanStack AI chat() → SSE stream
                     └── Uses keys from DO storage or env bindings
                     └── Outbound fetch() to OpenAI/Anthropic
```

### Authentication Architecture

Authentication works differently per target, but the validation interface is shared:

```
┌─────────────────────────────────────────────────────────────┐
│  Self-Hosted Auth                                           │
│                                                             │
│  Client ──── ?token=shared-secret ────► Server              │
│                                         │                   │
│                                    validateAuth()           │
│                                    { token: 'secret' }      │
│                                    or { verify: fn }        │
│                                                             │
│  AI keys: env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY)      │
│  or: POST /config/ai-keys (in-memory only, no disk)         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Cloud Auth (Two-Tier, y-sweet pattern)                     │
│                                                             │
│  App Backend ── server token ──► Worker                     │
│       │                           │                         │
│       │  POST /doc/:id/auth       │  Validate server token  │
│       │                           │  Issue client token      │
│       │◄── client token ──────────┘  (JWT: docId, scope,    │
│       │                               expiry)               │
│       │                                                     │
│       └── client token ──► Browser                          │
│                              │                              │
│                         WS ?token=client-jwt                │
│                              │                              │
│                              ▼                              │
│                         Durable Object                      │
│                         validateAuth({ verify: checkJWT })  │
│                                                             │
│  AI keys: DO storage (user configures in settings UI)       │
│  or: env bindings (platform-level keys)                     │
└─────────────────────────────────────────────────────────────┘
```

For the "temporary keys to a compiled binary" scenario: the self-hosted server accepts a `POST /config/ai-keys` with the user's API keys. Keys are stored in-memory only (never written to disk). Server restart requires re-sending keys. This gives the client app control over key provisioning without persisting secrets on the server's filesystem.

### Chat Endpoint Design

The `/chat` endpoint is a thin route handler in both targets. TanStack AI's `chat()` function does the heavy lifting:

```typescript
// Shared logic (framework-agnostic)
async function handleChat(request: Request, getApiKey: (provider: string) => string) {
  const { messages, provider, model } = await request.json();

  const adapter = resolveAdapter(provider, model, getApiKey(provider));
  const stream = chat({ adapter, messages });

  return toServerSentEventsResponse(stream);
}

// Self-hosted: Elysia route
app.post('/workspaces/:id/chat', ({ request }) =>
  handleChat(request, (provider) => process.env[`${provider.toUpperCase()}_API_KEY`])
);

// Cloud: inside DO fetch handler
async fetch(request: Request) {
  if (url.pathname === '/chat') {
    return handleChat(request, (provider) =>
      this.ctx.storage.get(`ai-key:${provider}`)
    );
  }
}
```

The difference between targets is only how API keys are retrieved: env vars (self-hosted) vs DO storage (cloud).

## Open Questions

1. **Should PartyServer be used instead of raw DOs?**
   - PartyServer adds room-based routing, lifecycle hooks, and hibernation support out of the box. It's a thin wrapper (~500 lines) over DOs.
   - Options: (a) Use PartyServer for convenience, (b) Write raw DO class for full control, (c) Start with PartyServer, eject if needed.
   - **Recommendation**: (c) Start with PartyServer. It's maintained by Cloudflare, maps cleanly to our room model, and we can eject to raw DOs later if we hit limitations. The `Server` base class is essentially what our `createRoomManager` already does.

2. **How should the Elysia dependency be handled for the shared layer?**
   - The sync protocol and room manager are already Elysia-free. But table CRUD and action routing currently use Elysia's `Elysia()` constructor.
   - Options: (a) Extract pure request/response handlers, wrap in Elysia for self-hosted and in DO `fetch` for cloud, (b) Keep Elysia as the abstraction layer and find a way to run it in Workers, (c) Use Hono as a shared framework (runs in both Bun and Workers).
   - **Recommendation**: (a) Extract pure handlers. The business logic (validate input, read/write Y.Doc, return JSON) doesn't need a framework. Elysia and DO `fetch` are just adapters. This matches the existing pattern where `protocol.ts` and `rooms.ts` are already framework-free.

3. **When should TanStack AI be integrated?**
   - TanStack AI is in alpha. The core pattern (`chat()` + `toServerSentEventsResponse()`) is stable, but the Svelte adapter doesn't exist yet.
   - Options: (a) Integrate now with React hooks only, (b) Wait for Svelte support, (c) Build a minimal Svelte wrapper around the core.
   - **Recommendation**: (c) Build a minimal Svelte wrapper. The core is framework-agnostic (`@tanstack/ai`). The server-side is fully usable today. A Svelte wrapper around `fetchServerSentEvents` is straightforward and unblocks the chat endpoint without waiting for official support.

4. **What's the DO persistence strategy for Yjs documents?**
   - Options: (a) DO transactional storage only, (b) DO storage + R2 checkpoints (y-sweet pattern), (c) DO storage + D1 for metadata.
   - **Recommendation**: (b) DO storage for hot state, R2 for checkpoint snapshots. y-sweet's journal-based approach (write incremental updates to DO storage, periodically checkpoint full state to R2) is battle-tested and handles crash recovery well.

5. **Should the chat endpoint be per-workspace or global?**
   - Per-workspace (`/workspaces/:id/chat`) means the AI has access to that workspace's data context. Global (`/chat`) is simpler but loses workspace awareness.
   - **Recommendation**: Per-workspace. The whole point is that the AI can query workspace tables as tool calls. A global endpoint can't do that without additional routing.

6. **How do we handle AI provider rate limits and costs in the cloud?**
   - Each user brings their own API keys, so rate limits are per-user. But DOs processing AI requests consume Cloudflare compute.
   - This is a billing/product question more than an architecture question. Defer until closer to production.

## Architectural Decision (Feb 2026)

After analysis, the cloud deployment target focuses on **sync + auth only**.

### What the cloud handles

- WebSocket Y.Doc synchronization (1 Durable Object per workspace)
- Authentication via Better Auth (Google, GitHub, etc.)
- Awareness/presence
- Y.Doc persistence in DO SQLite storage
- Hibernatable WebSockets for cost efficiency

### What the cloud does NOT handle

- User-defined actions (queries/mutations)
- Table REST endpoints
- AI chat endpoints (these require user's API keys and arbitrary compute)

### Why

1. **DO single-threading**: A slow action (e.g., 5s AI call) blocks all WebSocket sync for that workspace. Sync quality is the core value prop: mixing long-running work degrades it.
2. **Security**: Running arbitrary user code on shared infrastructure requires isolation, abuse prevention, and billing: a different business entirely.
3. **Simplicity**: Sync maps cleanly to the DO model. Actions don't.

### How actions work in cloud mode

Users run their own Bun server for actions. The cloud provides workspace-scoped tokens (minted after Better Auth login) that the user's server can validate. The user's server accesses workspace data via CRDTs (syncing a local Y.Doc) or via DO RPC for reads.

```
User → Better Auth (login) → workspace-scoped JWT
  ├── Sync: JWT → CF Worker → DO (WebSocket)     ← cloud handles
  └── Actions: JWT → user's server → action logic  ← user handles
```

## References

- `packages/server/src/server.ts`: `createServer()` implementation
- `packages/server/src/sync/plugin.ts`: Sync plugin (Elysia WebSocket wiring)
- `packages/server/src/sync/rooms.ts`: Room manager (framework-agnostic)
- `packages/server/src/sync/protocol.ts`: y-websocket protocol (framework-agnostic)
- `packages/server/src/sync/auth.ts`: Auth validation (framework-agnostic)
- `packages/server/src/actions.ts`: Action routing
- `packages/server/src/workspace-plugin.ts`: Workspace plugin (tables + actions)
- `packages/constants/src/cloudflare.ts`: Existing Cloudflare env schema
- `specs/20260219T195800-server-architecture-rethink.md`: Layered server architecture (complementary)
- [Cloudflare Durable Objects: WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Agents: Using AI Models](https://developers.cloudflare.com/agents/api-reference/using-ai-models/)
- [PartyServer README](https://github.com/threepointone/partyserver)
- [y-sweet Architecture (DeepWiki)](https://deepwiki.com/jamsocket/y-sweet)
- [y-durableobjects](https://github.com/napolab/y-durableobjects)
- [TanStack AI Overview](https://tanstack.com/ai/latest/docs)
- [TanStack AI Streaming Guide](https://tanstack.com/ai/latest/docs/guides/streaming)
