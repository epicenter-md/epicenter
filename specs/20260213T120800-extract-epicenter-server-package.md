# @epicenter/server: Package Extraction + Sync Core

> **Update (Feb 2026)**: The cloud deployment scope has been narrowed. Cloud focuses on sync + auth only: the workspace plugin (tables/actions) is self-hosted only. The transport-agnostic sync core (rooms, auth, protocol) remains shared across both targets as described in this spec. See `specs/20260219T200000-deployment-targets-research.md` for the architectural decision.
>
> **Topology note (2026-02-26)**: This spec predates the hub/sidecar split. The "Network Topology" section describes a single-server model. The current architecture uses `createHubServer()` (Better Auth, AI streaming, ephemeral Yjs relay) and `createLocalServer()` (workspace CRUD, extensions, actions, persisted Y.Docs). There is no single `createServer()` that handles both roles. See `specs/20260222T195645-network-topology-multi-server-architecture.md` for the authoritative three-tier topology.

**Date**: 2026-02-13
**Status**: Phase 1 Complete, Phase 2 Design Revised
**Related specs**: `20260213T120800-cloud-sync-durable-objects.md`, `20260213T120813-encryption-at-rest-architecture.md`

## Overview

Extract the server code from `@epicenter/workspace` (currently at `packages/epicenter/src/server/`) into a standalone `@epicenter/server` package at `packages/server/`. Then build the sync core: a transport-agnostic room manager and three-mode authentication system that serve as the shared foundation for both the self-hosted Elysia server and the Cloudflare Durable Objects cloud path.

**Scope boundary**: This spec covers `@epicenter/server`: the self-hosted Elysia/Bun sync server and the transport-agnostic sync core (`createRoom()`, `createAuthValidator()`, `Connection` type) that both deployment paths depend on. It also defines the **canonical client-side provider API** consumed by all three specs. The Cloudflare Durable Objects cloud path is a separate codebase documented in `20260213T120800-cloud-sync-durable-objects.md`. Client-side E2EE is documented in `20260213T120813-encryption-at-rest-architecture.md`.

## Motivation

### Current State

The server lives inside `@epicenter/workspace` at `src/server/`:

```
packages/epicenter/src/server/
├── server.ts         # createServer() factory, Elysia + Bun.serve()
├── actions.ts        # Action → HTTP route mapping with Standard Schema validation
├── tables.ts         # RESTful CRUD for workspace tables
├── sync/
│   ├── index.ts      # WebSocket sync plugin (y-websocket protocol)
│   └── protocol.ts   # Pure encode/decode for y-websocket messages
├── index.ts          # Re-exports createServer, DEFAULT_PORT, ServerOptions
├── actions.test.ts   # 10 tests for action routing
└── sync/
    └── protocol.test.ts  # Protocol encode/decode tests
```

The CLI at `src/cli/cli.ts` imports directly:

```typescript
import { createServer, DEFAULT_PORT } from '../server/server';
```

And `package.json` exports it as:

```json
{ "./server": "./src/server/index.ts" }
```

This creates problems:

1. **Server code is coupled to the library package.** Users who want a self-hostable server must install `@epicenter/workspace`, which includes the entire workspace system, CLI, providers, and ingest modules.
2. **No authentication.** `MESSAGE_AUTH=2` is reserved in the protocol but unimplemented. Anyone who can reach the WebSocket can read and write all data.
3. **No encryption at rest.** Yjs documents are stored and synced as plaintext. Sensitive data (API keys, tokens) stored in Yjs is visible to anyone with disk or network access.
4. **Topology is implicit.** Multi-device sync works but there's no formal server identity, discovery, or trust model for self-hosted deployments.

### Desired State

A standalone `@epicenter/server` package that:

- Is installable independently for self-hosting (`bun add @epicenter/server`)
- Has a three-mode auth system: open (no auth), shared secret, or external JWT validation
- Exports a transport-agnostic room manager that can be reused by the Durable Objects cloud path
- Does NOT embed Better Auth, OAuth, user databases, or encryption: those live in separate concerns

## Research Findings

### Server Code Dependency Map

The server imports from two internal modules:

| Import              | Source          | What's Used                             |
| ------------------- | --------------- | --------------------------------------- |
| `../static/types`   | `@epicenter/workspace` | `AnyWorkspaceClient`, `TableHelper`     |
| `../shared/actions` | `@epicenter/workspace` | `Actions`, `iterateActions`, `isAction` |

External dependencies:

| Package             | Used In                                         | Purpose                       |
| ------------------- | ----------------------------------------------- | ----------------------------- |
| `elysia`            | server.ts, actions.ts, tables.ts, sync/index.ts | HTTP framework                |
| `@elysiajs/openapi` | server.ts                                       | API documentation             |
| `lib0`              | sync/index.ts, sync/protocol.ts                 | Binary encoding/decoding      |
| `y-protocols`       | sync/index.ts, sync/protocol.ts                 | Yjs sync + awareness protocol |
| `yjs`               | sync/protocol.ts (type-only)                    | Y.Doc type                    |
| `wellcrafted`       | sync/index.ts                                   | `trySync` for error handling  |

**Key finding**: The server's dependency on `@epicenter/workspace` is narrow: just 5 type imports and 2 function imports (`iterateActions`, `isAction`). The types can be imported from `@epicenter/workspace` as a peer dependency.

### Elysia.js and Cloudflare Durable Objects

**Elysia cannot manage Durable Object WebSockets.** Durable Objects use the Hibernation API: a class-based lifecycle where the DO _is_ the WebSocket server via `this.ctx.acceptWebSocket()`, `webSocketMessage()`, `webSocketClose()` methods. There is no HTTP framework in the middle. Elysia has experimental CF Worker support (since v1.2) for basic HTTP routes, but its WebSocket handling uses `WebSocketPair` on Workers, which is the wrong model for DOs.

**Implication**: The self-hosted path (Elysia/Bun) and the cloud path (CF Workers + DOs) are fundamentally different codebases at the transport layer. They share:

- `protocol.ts`: pure encode/decode (already transport-agnostic)
- `room.ts`: transport-agnostic room management (to be extracted)

But they have completely different:

- HTTP routing (Elysia vs bare `fetch()` handler or Hono)
- WebSocket lifecycle (Elysia `.ws()` plugin vs DO class methods)
- Persistence (filesystem vs DO SQLite storage)
- Auth validation location (Elysia middleware vs CF Worker `fetch()`)

### Auth Architecture: Two Servers, Not One

Better Auth does NOT run inside the sync server. The architecture is:

1. **Auth server** (Epicenter's cloud infrastructure): Better Auth, user accounts, OAuth, org membership. Issues JWTs.
2. **Sync server** (`@epicenter/server`): Elysia WebSocket relay. Validates connections. Does NOT know about users, sessions, or OAuth.

The sync server's only auth question: **"should I let this WebSocket connection in?"** This is answered by one of three modes depending on deployment context.

## Design Decisions

| Decision                     | Choice                                                                          | Rationale                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Package dependency direction | `@epicenter/server` depends on `@epicenter/workspace` as peer dep                      | Server needs workspace types; keeping them in `@epicenter/workspace` avoids a types-only package                    |
| Backward compatibility       | Breaking change, no re-export from `@epicenter/workspace/server`                       | Clean break. The server export path was pre-1.0 and has few consumers.                                       |
| No circular deps             | `@epicenter/workspace` must NEVER depend on `@epicenter/server`                        | One-way dependency: `server → hq`. CLI uses dynamic import for `serve` command until CLI is extracted later. |
| CLI extraction (future)      | Extract `@epicenter/cli` that depends on both `hq` and `server`                 | Clean leaf package that composes everything. Deferred: not in scope for Phase 1.                            |
| Auth model                   | Three modes: open, shared secret, external JWT: NOT Better Auth on the server  | Sync server is a relay, not an auth authority. Auth complexity belongs in a separate service.                |
| Auth default                 | Mode 1 (open, no auth) is the default                                           | Self-hosted on a trusted network shouldn't require OAuth setup to sync your own devices.                     |
| No encryption in sync server | Encryption is a client-side concern (E2EE), not server-side                     | Server relays opaque Uint8Array blobs. E2EE means server never needs to decrypt. See encryption spec.        |
| Cloud path is separate       | Durable Objects adapter is a different codebase, NOT an Elysia plugin           | DO Hibernation API is incompatible with Elysia's WebSocket model. Shared code = protocol + room layers only. |
| Room manager extraction      | Transport-agnostic `createRoom()` shared by both Elysia plugin and DO class     | Both deployment targets have identical room logic; only the WebSocket transport differs.                     |
| Credential sync              | API keys in encrypted Yjs (client-side E2EE), refresh tokens in device keychain | CRDTs can't safely handle token rotation. See encryption spec for details.                                   |

## Architecture

### Phase 1: Package Structure (COMPLETE)

```
packages/server/
├── package.json              # @epicenter/server
├── tsconfig.json
├── src/
│   ├── index.ts              # Public exports
│   ├── server.ts             # createServer() factory
│   ├── actions.ts            # Action → HTTP route mapping
│   ├── tables.ts             # RESTful CRUD plugin
│   ├── sync/
│   │   ├── index.ts          # WebSocket sync plugin (Elysia-coupled)
│   │   └── protocol.ts       # Protocol encode/decode (transport-agnostic)
│   ├── actions.test.ts       # Moved tests
│   └── sync/
│       └── protocol.test.ts  # Moved tests
```

Dependency graph after extraction (no circular deps):

```
                    ┌──────────────────┐
                    │  @epicenter/cli   │  (future extraction)
                    │                   │
                    │  epicenter serve   │
                    │  epicenter posts   │
                    └─────┬────────┬────┘
                          │        │
                 depends  │        │  depends
                          ▼        ▼
┌──────────────────┐              ┌──────────────────┐
│ @epicenter/server │──────────►  │  @epicenter/workspace   │
│                   │  peer dep   │                   │
│ createServer()    │             │ AnyWorkspaceClient│
│ createSyncPlugin  │             │ TableHelper       │
│ createTablesPlugin│             │ Actions           │
│                   │             │ iterateActions    │
└──────────────────┘              └──────────────────┘
        │
        │ direct deps
        ▼
  elysia, @elysiajs/openapi,
  lib0, y-protocols, yjs,
  wellcrafted
```

**Key constraint**: `@epicenter/workspace` NEVER depends on `@epicenter/server`. The arrow is one-way.

### Phase 2: Three-Mode Auth + Room Extraction

#### The Three Auth Modes

The sync server answers one question: **"should I let this WebSocket connection in?"** Three modes, escalating in complexity:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Mode 1: Open (default)                                              │
│  No auth. Anyone who can reach the port can sync.                    │
│  Use case: localhost, Tailscale, home network.                       │
│                                                                      │
│  Mode 2: Shared Secret                                               │
│  Static token set at server startup. Clients must present it.        │
│  Use case: Self-hosted server exposed to the internet.               │
│                                                                      │
│  Mode 3: External JWT                                                │
│  Short-lived JWTs issued by an external auth service.                │
│  Use case: Epicenter Cloud (Durable Objects), or power users         │
│  who run their own auth service separately.                          │
└─────────────────────────────────────────────────────────────────────┘
```

#### Mode 1: Open (No Auth)

```typescript
import { createServer } from '@epicenter/server';

const server = createServer(client, { port: 3913 });
server.start();
```

Client:

```typescript
new WebSocket('ws://localhost:3913/workspaces/blog/sync');
// No headers, no tokens, just connect.
```

Validation: `() => ({ allowed: true })`: everyone's welcome.

#### Mode 2: Shared Secret

```typescript
const server = createServer(client, {
	port: 3913,
	auth: { secret: 'my-long-random-string' },
});
```

Client:

```typescript
// Token in Sec-WebSocket-Protocol header (works in browsers)
new WebSocket(url, ['yjs-sync-v1', 'my-long-random-string']);
```

Validation: string comparison. `extractToken(req) === auth.secret`. No database, no OAuth, no crypto.

The user picks the secret when starting the server and enters it in their Epicenter app settings on each device.

#### Mode 3: External JWT

```typescript
const server = createServer(client, {
	port: 3913,
	auth: { jwtSecret: process.env.SYNC_JWT_SECRET },
});
```

The sync server only has the signing key. It validates JWT signatures without calling any external service.

Token flow:

```
1. Client → Auth Server (separate, e.g. auth.epicenter.so)
   POST /api/sync/token
   Cookie: better_auth_session=...
   Body: { workspaceId: "blog", epoch: 0 }

2. Auth Server → Client
   { token: "eyJhbG...", url: "wss://sync.epicenter.so/..." }
   (JWT: { docId: "org_acme:blog-0", scope: "full", exp: +5min })

3. Client → Sync Server
   new WebSocket(url, ['yjs-sync-v1', token])

4. Sync Server validates:
   - JWT signature matches jwtSecret ✓
   - Not expired ✓
   - docId claim matches requested workspace ✓
   - Connection accepted.
```

**Key point**: The sync server never talks to the auth server. They share only a `jwtSecret`. The auth server can be Better Auth, or anything else that produces signed JWTs.

#### Auth Type Definition

All three modes collapse to one type:

```typescript
type SyncAuth =
	| undefined // Mode 1: open
	| { secret: string } // Mode 2: shared secret
	| { jwtSecret: string }; // Mode 3: external JWT

type ServerOptions = {
	port?: number;
	auth?: SyncAuth;
	cors?: CorsOptions;
};
```

Inside the sync plugin, one validator function handles all three:

```typescript
function createAuthValidator(auth: SyncAuth | undefined) {
	if (!auth) {
		return () => ({ allowed: true as const });
	}
	if ('secret' in auth) {
		return (req: Request) => {
			const token = extractToken(req);
			return { allowed: token === auth.secret } as const;
		};
	}
	if ('jwtSecret' in auth) {
		return (req: Request, workspaceId: string) => {
			const token = extractToken(req);
			const claims = verifyJwt(token, auth.jwtSecret);
			if (!claims || claims.exp < Date.now() / 1000)
				return { allowed: false } as const;
			if (claims.docId && !claims.docId.endsWith(workspaceId))
				return { allowed: false } as const;
			return { allowed: true as const, userId: claims.sub };
		};
	}
}
```

#### Where Each Mode Applies

| Deployment                    | Mode            | Sync Server                         | Auth Server             |
| ----------------------------- | --------------- | ----------------------------------- | ----------------------- |
| `bun dev` locally             | Mode 1 (open)   | localhost:3913                      | none                    |
| Mac Mini on home network      | Mode 1 or 2     | 192.168.x.x:3913                    | none                    |
| VPS / exposed to internet     | Mode 2 (secret) | vps.example.com:3913                | none                    |
| Epicenter Cloud               | Mode 3 (JWT)    | Durable Objects (separate codebase) | auth.epicenter.so       |
| Power user self-hosted + auth | Mode 3 (JWT)    | their Elysia server                 | their own auth instance |

**Note**: Mode 3 on the Elysia server is supported but uncommon. The primary Mode 3 consumer is the Durable Objects cloud path, which is a separate codebase that shares the same JWT validation logic and room manager. See `20260213T120800-cloud-sync-durable-objects.md`.

#### Room Manager Extraction

The current `sync/index.ts` has room management logic (connection tracking, awareness lifecycle, broadcast) interleaved with Elysia WebSocket bindings. Phase 2 extracts this into a transport-agnostic `createRoom()` that both the Elysia plugin and the Durable Objects adapter can use.

```
packages/server/src/sync/
  ├── protocol.ts         ← EXISTING: Pure encode/decode (unchanged)
  ├── room.ts             ← NEW: Transport-agnostic room manager
  ├── elysia-plugin.ts    ← REFACTORED from index.ts: thin Elysia WS adapter
  ├── auth.ts             ← NEW: Auth validator factory (three modes)
  └── index.ts            ← Re-exports
```

The room manager:

```typescript
// sync/room.ts: Transport-agnostic room management

type Connection = {
	send(data: Uint8Array): void;
	id: string;
};

type RoomConfig = {
	doc: Y.Doc;
};

function createRoom(config: RoomConfig) {
	const { doc } = config;
	const connections = new Map<string, Connection>();
	const awareness = new Awareness(doc);
	const controlledClients = new Map<string, Set<number>>();

	doc.on('update', (update: Uint8Array, origin: unknown) => {
		const message = encodeSyncUpdate({ update });
		for (const [id, conn] of connections) {
			if (id !== origin) conn.send(message);
		}
	});

	return {
		get connectionCount() {
			return connections.size;
		},
		get awareness() {
			return awareness;
		},

		addConnection(conn: Connection) {
			/* ... */
		},
		handleMessage(connId: string, data: Uint8Array) {
			/* ... */
		},
		removeConnection(connId: string) {
			/* ... */
		},
		destroy() {
			/* ... */
		},
	};
}
```

The Elysia plugin becomes a thin adapter:

```typescript
// sync/elysia-plugin.ts: Maps Elysia WS events → Room methods
function createSyncPlugin(config: { getDoc; auth? }) {
	const rooms = new Map<string, Room>();
	const validator = createAuthValidator(config.auth);

	return new Elysia().ws('/workspaces/:workspaceId/sync', {
		open(ws) {
			if (!validator(ws.raw.request, ws.data.params.workspaceId).allowed) {
				ws.close(4001, 'Unauthorized');
				return;
			}
			const room = getOrCreateRoom(rooms, workspaceId, config.getDoc);
			room.addConnection({ id: connId, send: (d) => ws.send(Buffer.from(d)) });
		},
		message(ws, data) {
			room.handleMessage(connId, data);
		},
		close(ws) {
			room.removeConnection(connId);
			if (room.connectionCount === 0) rooms.delete(workspaceId);
		},
	});
}
```

#### Client-Side Ergonomics

```typescript
// Mode 1: local, no auth
createWebsocketSyncProvider({
	url: 'ws://localhost:3913/workspaces/{id}/sync',
});

// Mode 2: self-hosted with shared secret
createWebsocketSyncProvider({
	url: 'ws://my-server:3913/workspaces/{id}/sync',
	token: 'my-shared-secret',
});

// Mode 3: Epicenter Cloud (or any external auth)
createWebsocketSyncProvider({
	url: 'wss://sync.epicenter.so/workspaces/{id}/sync',
	getToken: async (workspaceId) => {
		const res = await fetch('https://auth.epicenter.so/api/sync/token', {
			method: 'POST',
			credentials: 'include',
			body: JSON.stringify({ workspaceId }),
		});
		return (await res.json()).token;
	},
});
```

Mode 2 uses a static `token` string. Mode 3 uses a `getToken` function that fetches a fresh short-lived JWT on each connect/reconnect.

#### Network Topology

The primary model is **single server**: one sync server that all your devices connect to.

```
PRIMARY: Single Self-Hosted Server
────────────────────────────────────

  Phone ──────► Mac Mini ◄────── Laptop
    WS            :3913            WS
                   │
              ┌────┴────┐
              │ *.yjs    │
              └──────────┘

  All devices connect to one server.
  Server handles sync and persistence. No auth database.
```

**Hot-swapping** between self-hosted and cloud is a client-side concern: the client changes which URL it connects to. No server-to-server communication needed because clients bridge data via CRDTs.

```typescript
// Connect to both simultaneously: client bridges via CRDTs
.withExtension('syncLocal', createWebsocketSyncProvider({
  url: 'ws://mac-mini.local:3913/workspaces/{id}/sync',
}))
.withExtension('syncCloud', createWebsocketSyncProvider({
  url: 'wss://sync.epicenter.so/workspaces/{id}/sync',
  getToken: async (wsId) => { /* ... */ },
}))
```

### What This Spec Does NOT Cover

These are handled by companion specs:

| Concern                    | Spec                                                 | Summary                                                                                                                 |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Client-side E2EE           | `20260213T120813-encryption-at-rest-architecture.md` | AES-256-GCM encryption of Yjs updates before they leave the client. Key hierarchy (KEK → DK). Server is zero-knowledge. |
| Cloudflare Durable Objects | `20260213T120800-cloud-sync-durable-objects.md`      | Separate codebase. DO class wraps `createRoom()`. CF Worker validates JWTs. Hibernation API for cost efficiency.        |
| Credential storage         | `20260213T120813-encryption-at-rest-architecture.md` | API keys in E2EE Yjs, refresh tokens in device keychain, OAuth per-device.                                              |

## Implementation Plan

### Phase 1: Package Extraction (COMPLETE)

- [x] **1.1** Create `packages/server/` directory with `package.json`, `tsconfig.json`
  - Name: `@epicenter/server`
  - Peer dep: `@epicenter/workspace` (for types)
  - Direct deps: `elysia`, `@elysiajs/openapi`, `lib0`, `y-protocols`, `yjs`, `wellcrafted`
- [x] **1.2** Copy server source files from `packages/epicenter/src/server/` to `packages/server/src/`
  - `server.ts`, `actions.ts`, `tables.ts`, `index.ts`
  - `sync/index.ts`, `sync/protocol.ts`
  - `actions.test.ts`, `sync/protocol.test.ts`
- [x] **1.3** Update imports in copied files
  - `../static/types` → `@epicenter/workspace/static` (for `AnyWorkspaceClient`, `TableHelper`)
  - `../shared/actions` → `@epicenter/workspace` (for `Actions`, `iterateActions`, `isAction`)
  - Verify all imports resolve correctly
- [x] **1.4** Update `packages/epicenter/src/cli/cli.ts` to use dynamic import
  - Changed static import to `const { createServer } = await import('@epicenter/server')` with try/catch
  - `@epicenter/server` is NOT a dependency of `@epicenter/workspace`: no circular deps
  - If `@epicenter/server` is not installed, the `serve` command prints a helpful error and exits
- [x] **1.5** Remove `./server` export from `packages/epicenter/package.json`
  - Deleted the `"./server": "./src/server/index.ts"` entry
  - Also removed `@elysiajs/openapi` from `@epicenter/workspace` dependencies (now owned by `@epicenter/server`)
- [x] **1.6** Delete `packages/epicenter/src/server/` directory entirely
- [x] **1.7** Verify the server README at `packages/epicenter/src/server/README.md` is moved to `packages/server/README.md`
- [x] **1.8** Run existing tests in new location: `bun test` from `packages/server/`: 50 pass, 0 fail
- [x] **1.9** Run `bun typecheck` on both `@epicenter/server` and `@epicenter/workspace`: all errors are pre-existing upstream, none related to extraction
- [x] **1.10** No documentation references to `@epicenter/workspace/server` found outside the spec itself

### Phase 2: Room Extraction + Three-Mode Auth (Design Only: Implementation Deferred)

- [ ] **2.1** Extract `createRoom()` into `sync/room.ts`
  - Move connection tracking, awareness lifecycle, broadcast logic out of `sync/index.ts`
  - Define `Connection` interface: `{ send(data: Uint8Array): void; id: string }`
  - Room is transport-agnostic: no Elysia, no Buffer, no WebSocket types
  - Export from package for reuse by Durable Objects adapter (separate codebase)
- [ ] **2.2** Create `sync/auth.ts` with `createAuthValidator()`
  - Implement all three modes: open, shared secret, JWT
  - Token extraction: parse `Sec-WebSocket-Protocol` header (primary) and `?token=` query param (fallback)
  - JWT validation: `jose` library (works on Bun and CF Workers): verify signature, check `exp`, check `docId` claim
  - Return `{ allowed: boolean; userId?: string }`
- [ ] **2.3** Refactor `sync/index.ts` → `sync/elysia-plugin.ts`
  - Thin adapter: maps Elysia WS events to `room.addConnection`, `room.handleMessage`, `room.removeConnection`
  - Calls auth validator on WebSocket upgrade: reject with 4001 if not allowed
  - Manages multiple rooms (one per workspace), evicts empty rooms
- [ ] **2.4** Update `createServer()` to accept `auth` option
  - `auth?: { secret: string } | { jwtSecret: string }`: undefined means open (Mode 1)
  - Pass auth config through to `createSyncPlugin`
  - Also gate REST table endpoints (not just WebSocket)
- [ ] **2.5** Verify existing tests pass with no behavioral changes
  - Default (no auth) should behave identically to current code
  - Add tests for Mode 2 (secret) and Mode 3 (JWT) rejection/acceptance
- [ ] **2.6** Add CORS configuration
  - Default: allow localhost origins
  - Configurable: trusted origins list
  - Auto-detect Tauri app origins
- [ ] **2.7** Update exports in `sync/index.ts` barrel
  - Export `createRoom`, `createAuthValidator`, `createSyncPlugin`
  - Export `Connection` type for Durable Objects adapter

## Edge Cases

### Phase 1: CLI `serve` Command Without Circular Dependency

1. `@epicenter/workspace` currently exports the server AND defines the types the server uses
2. After extraction, `@epicenter/server` depends on `@epicenter/workspace` for types
3. The CLI's `serve` command (in `@epicenter/workspace`) needs `createServer` from `@epicenter/server`
4. **`@epicenter/workspace` must NEVER depend on `@epicenter/server`**: no circular deps

**Resolution**: The CLI uses a dynamic import: `const { createServer } = await import('@epicenter/server')`. This makes `@epicenter/server` an optional peer dep. If not installed, the `serve` command prints "Install @epicenter/server to use this command." Later, the entire CLI will be extracted to `@epicenter/cli` which depends on both packages normally.

### Phase 2: Mode 2 Secret in URL Logs

If using `?token=secret` query param fallback, the secret appears in server access logs and potentially browser history.

**Resolution**: `Sec-WebSocket-Protocol` header is the primary transport: it's not logged by default. Query param is documented as a fallback for environments where protocol headers can't be set. Documentation should warn about log exposure.

### Phase 2: Mode 3 JWT Expiry During Active Sync

1. Client connects with a 5-minute JWT
2. Client syncs happily for 30 minutes
3. JWT has been expired for 25 minutes

**Resolution**: Validate JWT only at connection time. Once connected, the client is trusted for the duration of that WebSocket session. If the auth service revokes access, the client will fail to get a new token on next reconnect. Periodic revalidation adds complexity for marginal security gain: defer unless a security audit requires it.

### Phase 2: Shared Secret Rotation

1. User changes the shared secret on the server
2. Connected clients still have the old secret
3. Clients reconnect after a network blip → rejected

**Resolution**: Server restart is required to change the secret (it's a config value). Connected WebSockets survive until the next disconnect. Clients need to update their configured token. This is acceptable for Mode 2's use case (single user, few devices).

## Resolved Decisions

| Question                   | Decision                                                                   | Rationale                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Auth default               | No auth (Mode 1) is the default                                            | Self-hosted on trusted network shouldn't require OAuth setup.                     |
| Better Auth on sync server | No. Auth lives in a separate service.                                      | Sync server is a relay, not an identity provider.                                 |
| Server-side encryption     | No. Encryption is client-side (E2EE).                                      | Server relays opaque blobs. See encryption spec.                                  |
| Elysia on Durable Objects  | Not possible. DO Hibernation API is class-based, incompatible with Elysia. | Cloud path is a separate codebase sharing only protocol + room layers.            |
| Token transport            | `Sec-WebSocket-Protocol` header (primary), query param (fallback)          | Browser WS API can't set custom headers. Protocol header is clean and not logged. |
| JWT library                | `jose` (works on Bun, Node, and CF Workers)                                | Cross-runtime compatibility for shared auth validation code.                      |
| Server-to-server sync      | Deferred entirely                                                          | Clients bridge servers via CRDTs. Single-server covers 90%+ of use cases.         |

## Remaining Open Questions

1. **Should Mode 3 JWT validation also be exported as a standalone function?** The Durable Objects adapter (separate codebase) needs the same JWT validation. Exporting `validateSyncToken(token, jwtSecret)` from `@epicenter/server` means the DO codebase depends on this package, which adds `elysia` as a transitive dep. Alternative: extract JWT validation into a tiny shared package like `@epicenter/sync-auth`.

2. **REST endpoint auth**: Should table REST endpoints (`/workspaces/{id}/tables/...`) also be gated by the same auth modes? Currently they're public. Mode 2 (secret) and Mode 3 (JWT) should probably gate them too, but the token transport differs (HTTP headers vs WebSocket protocol headers).

3. **Room eviction for idle workspaces**: When the self-hosted server has many workspaces, should idle rooms be evicted from memory (unload Y.Doc, reload from persistence on next connection)? Deferred to a future phase, but the `createRoom()` interface should support a `destroy()` method to enable this later.

## Success Criteria

### Phase 1 (COMPLETE)

- [x] `@epicenter/server` package exists at `packages/server/`
- [x] `bun test` passes in `packages/server/` (50 pass, 0 fail)
- [x] `bun typecheck` passes in both packages (all errors pre-existing, none from extraction)
- [x] `epicenter serve` CLI command uses dynamic import from `@epicenter/server`
- [x] `@epicenter/workspace` no longer contains server code in `src/server/`
- [x] No `./server` export in `@epicenter/workspace/package.json`
- [x] `@epicenter/workspace` has NO dependency (direct or peer) on `@epicenter/server` in package.json
- [x] Dependency direction is strictly one-way: `@epicenter/server` → `@epicenter/workspace`

### Phase 2

- [ ] `createRoom()` extracted to `sync/room.ts`, transport-agnostic
- [ ] `createAuthValidator()` in `sync/auth.ts` handles all three modes
- [ ] `createSyncPlugin()` refactored to use room + validator
- [ ] Default (no auth) behaves identically to current code: zero regressions
- [ ] Mode 2: connect with correct secret → accepted; wrong secret → 4001
- [ ] Mode 3: connect with valid JWT → accepted; expired/invalid/wrong-docId JWT → 4001
- [ ] `createRoom`, `Connection` type exported for Durable Objects adapter consumption
- [ ] Existing tests pass; new tests cover auth modes

## References

- `packages/server/src/server.ts`: `createServer()` factory (176 lines)
- `packages/server/src/actions.ts`: Action router (79 lines)
- `packages/server/src/tables.ts`: Tables CRUD plugin (78 lines)
- `packages/server/src/sync/index.ts`: WebSocket sync plugin (294 lines): refactor target
- `packages/server/src/sync/protocol.ts`: Protocol encode/decode (276 lines): unchanged
- `specs/20260213T120800-cloud-sync-durable-objects.md`: Durable Objects cloud path (separate codebase)
- `specs/20260213T120813-encryption-at-rest-architecture.md`: Client-side E2EE architecture
- [jose](https://github.com/panva/jose): JWT library (works on Bun, Node, CF Workers)
- [Secsync](https://github.com/nikgraf/secsync): E2EE CRDT architecture reference
- [Elysia CF Worker adapter](https://elysiajs.com/integrations/cloudflare-worker): Experimental, HTTP only, not for DOs

## Review: Phase 1 Extraction (2026-02-13)

### Summary

Phase 1 was a pure extraction: ~95% move/rename, ~5% glue code. No business logic was changed.

### What Changed

**New package: `packages/server/`**

- `package.json`: `@epicenter/server`, peer dep on `@epicenter/workspace`, direct deps on `elysia`, `@elysiajs/openapi`, `lib0`, `y-protocols`, `yjs`, `wellcrafted`
- `tsconfig.json`: mirrors `@epicenter/workspace` compiler options
- `src/index.ts`: 1-line re-export of `createServer`, `DEFAULT_PORT`, `ServerOptions`
- `src/server.ts`: moved from `packages/epicenter/src/server/server.ts`, import paths updated
- `src/actions.ts`: moved, import paths updated (`../shared/actions` → `@epicenter/workspace`)
- `src/tables.ts`: moved, import paths updated (`../static/types` → `@epicenter/workspace/static`)
- `src/sync/index.ts`: moved verbatim (no import changes needed, all deps are external)
- `src/sync/protocol.ts`: moved verbatim
- `src/actions.test.ts`: moved, import paths updated
- `src/sync/protocol.test.ts`: moved verbatim
- `README.md`: moved verbatim

**Modified in `@epicenter/workspace`:**

- `src/static/index.ts`: added `AnyWorkspaceClient` to type exports (was missing, needed by server package)
- `src/cli/cli.ts`: replaced static `import { createServer }` with dynamic `await import('@epicenter/server')` + try/catch error handling
- `package.json`: removed `"./server"` export, removed `@elysiajs/openapi` dependency

**Deleted from `@epicenter/workspace`:**

- `src/server/`: entire directory

### Verification Results

| Check                                | Result                                          |
| ------------------------------------ | ----------------------------------------------- |
| `bun install`                        | 1257 packages, no errors                        |
| `bun test` (packages/server)         | 50 pass, 0 fail                                 |
| `bun test` (packages/epicenter)      | 560 pass, 0 fail, 0 regressions                 |
| `bun typecheck` (packages/server)    | 7 errors: all pre-existing upstream            |
| `bun typecheck` (packages/epicenter) | 28 errors: all pre-existing, 0 from extraction |

### Notes for Phase 2

- The `DEFAULT_PORT` constant (3913) is now hardcoded in the CLI fallback since it can't import from `@epicenter/server` at module level. When Phase 2 adds auth config, the CLI will need `@epicenter/server` installed anyway, so this becomes moot.
- `AnyWorkspaceClient` was not previously exported from `@epicenter/workspace/static`. It is now. This is the only new public API surface from Phase 1.
- The `@elysiajs/openapi` dependency moved from `@epicenter/workspace` to `@epicenter/server`. If anything else in `@epicenter/workspace` used it, it would break, but nothing does.
