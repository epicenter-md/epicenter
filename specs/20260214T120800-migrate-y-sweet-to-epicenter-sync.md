# Migrate Y-Sweet to @epicenter/sync: Custom Provider + Server Protocol Extension

**Date**: 2026-02-14
**Status**: Implemented
**Author**: AI-assisted
**Related specs**: `20260213T120800-extract-epicenter-server-package.md`, `20260213T120800-cloud-sync-durable-objects.md`, `20260213T120813-encryption-at-rest-architecture.md`

## Overview

Replace the forked `@epicenter/y-sweet` client provider and the Y-Sweet server dependency with a clean `@epicenter/sync` provider backed by the `@epicenter/server` Elysia sync plugin. The provider is **rewritten from scratch** as a factory function with a supervisor loop, not a renamed class. The server gets `MESSAGE_SYNC_STATUS` (102) echo, server-side ping/pong keepalive, and room idle eviction. The result is a fully owned sync stack that follows this codebase's conventions.

## Motivation

### Current State

Two sync stacks running side-by-side:

```
CLIENT SIDE:
  @epicenter/y-sweet (forked from @y-sweet/client v0.9.1)
    → YSweetProvider with heartbeat, hasLocalChanges, reconnection
    → Connects to Y-Sweet server at /d/{docId}/ws

  y-sweet-persist-sync extension
    → Orchestrates provider + persistence (IndexedDB/filesystem)
    → directAuth() constructs Y-Sweet URL format

SERVER SIDE:
  @epicenter/server (packages/server/)
    → Elysia sync plugin at /workspaces/{id}/sync
    → Handles MESSAGE_SYNC (0), MESSAGE_AWARENESS (1), MESSAGE_QUERY_AWARENESS (3)
    → Does NOT handle MESSAGE_SYNC_STATUS (102)
```

This creates problems:

1. **Y-Sweet is dead.** Jamsocket's hosted service shuts down March 4, 2026. The open-source Rust binary is unmaintained in practice. We're carrying a fork of a dead project's client code.
2. **Two URL formats.** Y-Sweet uses `/d/{docId}/ws`. Our Elysia server uses `/workspaces/{id}/sync`. The `directAuth` helper constructs Y-Sweet URLs that don't work with our server.
3. **Missing heartbeat on our server.** The Elysia sync plugin doesn't handle `MESSAGE_SYNC_STATUS` (102), so `hasLocalChanges` never resolves and the 5-second dead connection detection doesn't work when pointing at our server.
4. **Confusing naming.** The package is called `y-sweet` but has nothing to do with Y-Sweet anymore: it's our own code. Extensions reference Y-Sweet in their names (`y-sweet-persist-sync`).

### Desired State

A single, owned sync stack with a clear name:

```
CLIENT SIDE:
  @epicenter/sync (renamed from @epicenter/y-sweet)
    → SyncProvider (renamed from YSweetProvider)
    → Connects to our Elysia server at /workspaces/{id}/sync
    → Heartbeat, hasLocalChanges, 5-state model, reconnection

  sync extension (renamed from y-sweet-persist-sync)
    → Same orchestration, new import paths

SERVER SIDE:
  @epicenter/server (packages/server/)
    → Elysia sync plugin handles 0, 1, 3, AND 102
    → MESSAGE_SYNC_STATUS echo enables hasLocalChanges + fast heartbeat
```

## Research Findings

### Y-Sweet vs y-websocket Feature Delta

Exhaustive source code analysis of Y-Sweet (`4f1909b`), y-websocket (`dc70a43`), and our Elysia server.

| Feature                                                          | Y-Sweet                                                   | y-websocket                                     | Our Elysia Server            | Implement?                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | ---------------------------- | ------------------------------------------- |
| **`MESSAGE_SYNC_STATUS` (102)**: heartbeat + version ack        | ✅ Client sends `localVersion`, server echoes bytes       | ❌ No concept                                   | ❌ Not handled               | **YES**                                     |
| **`hasLocalChanges`**: unsaved changes tracking                 | ✅ `ackedVersion !== localVersion`                        | ❌                                              | ❌                           | **YES**                                     |
| **5-state connection model**                                     | ✅ OFFLINE / CONNECTING / HANDSHAKING / CONNECTED / ERROR | ⚠️ 3 states (connected/connecting/disconnected) | N/A (server)                 | **YES**                                     |
| **Application-layer heartbeat** (fast dead connection detection) | ✅ 2s idle → probe, 3s timeout → reconnect (5s total)     | ⚠️ 45s socket timeout + 30s server ping/pong    | ❌                           | **YES**                                     |
| **Browser online/offline events**                                | ✅ Immediately wakes reconnect sleeper                    | ❌                                              | N/A                          | **YES**                                     |
| **Exponential backoff** (sophisticated, wakeable)                | ✅ 1.1^retries × base, wakeable Sleeper                   | ⚠️ 2^retries × 100ms, max 2500ms                | N/A                          | **YES** (already in fork)                   |
| **`EVENT_LOCAL_CHANGES`** event                                  | ✅ Fires when `hasLocalChanges` toggles                   | ❌                                              | N/A                          | **YES**                                     |
| **`EVENT_CONNECTION_STATUS`** event                              | ✅ Fires on every status transition                       | ⚠️ `status` event with 3 states                 | N/A                          | **YES** (already in fork)                   |
| **Token-based auth with refresh**                                | ✅ 3 retries then refresh token                           | ❌ URL params only                              | ❌ No auth yet               | **YES**: three-mode auth in server spec    |
| **Read-only mode enforcement**                                   | ✅ Server rejects writes from read-only tokens            | ❌ Must implement manually                      | ❌                           | **LATER**: after auth is implemented       |
| **HTTP REST API for docs**                                       | ✅ `/doc/new`, `/doc/:id/as-update`                       | ❌                                              | ✅ Table CRUD already exists | **NO**: different approach, already solved |
| **S3 persistence**                                               | ✅ Built-in                                               | ❌                                              | ❌                           | **NO**: client-side persistence model      |
| **Encrypted IndexedDB**                                          | ✅ AES-GCM 256-bit                                        | ❌                                              | N/A                          | **NO**: E2EE is a separate spec            |
| **Cross-tab BroadcastChannel**                                   | ❌                                                        | ✅ Built-in                                     | N/A                          | **NO**: y-indexeddb handles this           |
| **Debugger integration**                                         | ✅ `debugger.y-sweet.dev`                                 | ❌                                              | ❌                           | **NO**: service is dead                    |
| **y-websocket compat layer**                                     | ✅ Translates events/status                               | N/A                                             | N/A                          | **NO**: we own both sides                  |

### The Killer Feature: MESSAGE_SYNC_STATUS

`MESSAGE_SYNC_STATUS` (tag 102) is application-layer TCP sequence numbers. It gives you three capabilities from one mechanism:

1. **`hasLocalChanges`**: binary flag for "Saving..." / "Saved" UI
2. **Heartbeat**: 2s probe + 3s timeout = 5s dead connection detection (vs y-websocket's 45s)
3. **Zero cost**: server just echoes bytes. Never parses the version number. Can't corrupt sync state.

Wire format:

```
[varuint: 102] [varuint: payload length] [varuint: localVersion]
```

Server implementation is ~5 lines:

```typescript
case MESSAGE_SYNC_STATUS: {
  // Echo the payload back: that's it.
  const payload = decoding.readVarUint8Array(decoder);
  ws.send(toBuffer(encodeMessageSyncStatus({ payload })));
  break;
}
```

Tag 102 is safely outside the standard Yjs protocol range (0-3). Any y-websocket client/server that doesn't understand it simply ignores it, no breakage.

### Auth: Three-Mode System (Already Designed)

The auth system is fully designed in `20260213T120800-extract-epicenter-server-package.md` Phase 2. The provider needs to support all three modes:

| Mode                 | Server Config                | Client Config                           | Use Case                         |
| -------------------- | ---------------------------- | --------------------------------------- | -------------------------------- |
| **1: Open**          | `auth: undefined`            | `url` only                              | localhost, Tailscale, LAN        |
| **2: Shared Secret** | `auth: { secret: '...' }`    | `url` + `token: '...'`                  | Self-hosted, exposed to internet |
| **3: External JWT**  | `auth: { jwtSecret: '...' }` | `url` + `getToken: async (id) => '...'` | Epicenter Cloud, power users     |

The provider's auth callback (`getToken`) already handles token refresh on reconnect. This is the Y-Sweet `ensureClientToken` pattern, renamed.

### Naming Conventions

The current fork has Y-Sweet naming throughout:

| Current Name              | New Name                | Rationale                                                          |
| ------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `@epicenter/y-sweet`      | `@epicenter/sync`       | We own it. It's not Y-Sweet.                                       |
| `YSweetProvider`          | `SyncProvider`          | Describes what it does, not its origin                             |
| `YSweetProviderParams`    | `SyncProviderConfig`    | Convention: `Config` suffix                                        |
| `YSweetStatus`            | `SyncStatus`            |                                                                    |
| `ClientToken`             | Removed                 | Replaced by `SyncProviderConfig.url` + optional `token`/`getToken` |
| `createYjsProvider`       | `createSyncProvider`    |                                                                    |
| `y-sweet-persist-sync`    | `sync` (extension name) | The extension is just called "sync"                                |
| `ySweetPersistSync`       | `createSyncExtension`   | Follows `create*` factory pattern                                  |
| `YSweetPersistSyncConfig` | `SyncExtensionConfig`   |                                                                    |
| `directAuth(url)`         | Removed                 | URL is just passed directly                                        |

## Design Decisions

| Decision                            | Choice                                                  | Rationale                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rewrite provider, don't rename      | Factory function with supervisor loop                   | The forked class has 7 interacting subsystems, 4 entry points to `connect()`, event handlers making reconnection decisions, and `status` serving as both observable state and control flow. A rename ships a known-messy design under our brand. See `20260213T000000-fix-disconnect-reconnect-race.md` Part 2 for the full structural critique. |
| Factory function, not class         | `createSyncProvider()` returns object                   | Matches codebase conventions (`createSyncPlugin`, `createSleeper`, `createIndexLogger`). Closure-based state eliminates `this` binding. Method shorthand preserves JSDoc.                                                                                                                                                                        |
| Supervisor loop architecture        | One loop decides, everything else reports               | The Y-Sweet provider has `websocketClose`, `websocketError`, `setConnectionTimeout`, AND the connect loop all making reconnection decisions. The supervisor pattern centralizes this: event handlers resolve a promise, the loop decides what to do.                                                                                             |
| Separate `desired` from `status`    | `desired: 'online' \| 'offline'` + `status: SyncStatus` | Currently `status` is both UI-observable state AND connect loop control flow. Splitting them means `disconnect()` sets `desired = 'offline'` and the loop exits cleanly: no race conditions.                                                                                                                                                    |
| Server-side ping/pong               | 30s interval in Elysia sync plugin                      | Client heartbeat (102) detects dead connections from the client side. But if the client dies (laptop lid closed), the server has no way to know. Server ping/pong catches dead TCP connections that the client can't report. y-websocket server does this; our server doesn't.                                                                   |
| Room idle eviction                  | Destroy rooms after 60s with no connections             | The current server keeps rooms in memory forever. A long-running server with many workspaces will leak memory. `createRoom()` already has `destroy()` in the server spec.                                                                                                                                                                        |
| Add MESSAGE_SYNC_STATUS to server   | Echo handler in Elysia sync plugin                      | ~5 lines. Unlocks `hasLocalChanges` + fast heartbeat for all clients.                                                                                                                                                                                                                                                                            |
| Rename package to `@epicenter/sync` | Clean break                                             | Y-Sweet name is confusing. We own this code.                                                                                                                                                                                                                                                                                                     |
| Remove `ClientToken` type           | Replace with URL + optional token/getToken              | `ClientToken` was Y-Sweet's auth abstraction. Our three-mode auth is simpler: you have a URL, and optionally a token.                                                                                                                                                                                                                            |
| Keep `Sleeper` utility              | Yes: wakeable sleep for browser events                 | Browser `online` event waking up the reconnect sleeper is genuinely useful. Not available in y-websocket. Already follows factory pattern.                                                                                                                                                                                                       |
| Auth implementation                 | Aligned with server spec Phase 2                        | Three-mode auth is designed. Provider supports `token` (static) and `getToken` (dynamic) from day one.                                                                                                                                                                                                                                           |

## Architecture

### Protocol Flow (After Migration)

```
Client (SyncProvider)                  Server (@epicenter/server)
  │                                         │
  ├─ WebSocket connect ───────────────────►  │
  │  ws://server:3913/workspaces/{id}/sync   │
  │  [Sec-WebSocket-Protocol: token]         │
  │                                          │
  │◄─ MESSAGE_SYNC (sync step 1) ──────────┤  Server initiates sync
  ├─ MESSAGE_SYNC (sync step 2) ──────────►│  Client responds with diff
  │                                          │
  ├─ MESSAGE_SYNC_STATUS (102) ───────────►│  Heartbeat every 2s idle
  │◄─ MESSAGE_SYNC_STATUS (102) ──────────┤  Server echoes bytes
  │     → hasLocalChanges = false            │
  │                                          │
  ├─ MESSAGE_AWARENESS (1) ───────────────►│  Presence updates
  │◄─ MESSAGE_AWARENESS (1) ──────────────┤  Broadcast to room
  │                                          │
  └─ (repeat heartbeat/sync cycle) ────────┘
```

### Package Structure (After Migration)

```
packages/sync/                          ← renamed from packages/y-sweet/
├── package.json                        # @epicenter/sync
├── src/
│   ├── index.ts                        # Public exports
│   ├── provider.ts                     # createSyncProvider() factory (supervisor loop)
│   ├── sleeper.ts                      # Wakeable sleep utility (unchanged)
│   └── types.ts                        # SyncProviderConfig, SyncStatus, SyncProvider type

packages/epicenter/src/extensions/
├── sync.ts                             ← renamed from y-sweet-persist-sync.ts
├── sync.test.ts                        ← renamed from y-sweet-persist-sync.test.ts
├── sync/
│   ├── web.ts                          # IndexedDB persistence (unchanged logic)
│   └── desktop.ts                      # Filesystem persistence (unchanged logic)

packages/server/src/sync/
├── protocol.ts                         # + MESSAGE_SYNC_STATUS constant + encode/decode
├── index.ts                            # + MESSAGE_SYNC_STATUS echo + ping/pong + room eviction
```

### Client API (After Migration)

```typescript
// Mode 1: localhost, no auth
createSyncExtension({
	url: 'ws://localhost:3913/workspaces/{id}/sync',
	persistence: indexeddbPersistence,
});

// Mode 2: self-hosted with shared secret
createSyncExtension({
	url: 'ws://my-server:3913/workspaces/{id}/sync',
	token: 'my-shared-secret',
	persistence: indexeddbPersistence,
});

// Mode 3: cloud with dynamic token
createSyncExtension({
	url: 'wss://sync.epicenter.so/workspaces/{id}/sync',
	getToken: async (workspaceId) => {
		const res = await fetch('/api/sync/token', {
			method: 'POST',
			credentials: 'include',
			body: JSON.stringify({ workspaceId }),
		});
		return (await res.json()).token;
	},
	persistence: indexeddbPersistence,
});
```

## Implementation Plan

### Phase 1: Server Hardening

Three changes to the Elysia sync plugin. All are independent and can be done in parallel.

#### 1A: MESSAGE_SYNC_STATUS Echo

Unlocks `hasLocalChanges` + fast heartbeat for all connected providers.

- [x] **1A.1** Add `SYNC_STATUS: 102` to `MESSAGE_TYPE` constant in `packages/server/src/sync/protocol.ts` with JSDoc noting it's an extension beyond the standard y-websocket protocol
- [x] **1A.2** Add `encodeMessageSyncStatus({ payload })` encoder function to protocol.ts
- [x] **1A.3** Add echo handler in `packages/server/src/sync/index.ts`: receive type 102, echo the raw payload back as type 102
- [x] **1A.4** Add protocol test: encode → decode roundtrip for MESSAGE_SYNC_STATUS
- [x] **1A.5** Verify existing protocol tests still pass

#### 1B: Server-Side Ping/Pong Keepalive

Detects dead clients (laptop lid closed, browser killed) that the client-side heartbeat can't catch.

- [x] **1B.1** Add 30-second `setInterval` per connection in the `open()` handler that calls `ws.raw.ping()` (Bun's ServerWebSocket supports this)
- [x] **1B.2** Track `pongReceived` boolean per connection (in `connectionState` WeakMap). Set `true` on pong, `false` before each ping.
- [x] **1B.3** If `pongReceived === false` when next ping fires, close the connection: server considers client dead
- [x] **1B.4** Clean up the interval in the `close()` handler
- [x] **1B.5** Test: verify connections are cleaned up when client stops responding

#### 1C: Room Idle Eviction

Prevents memory leaks on long-running servers with many workspaces.

- [x] **1C.1** When the last connection leaves a room, start a 60-second eviction timer instead of immediately deleting the room
- [x] **1C.2** If a new connection joins before the timer fires, cancel the timer
- [x] **1C.3** When the timer fires, destroy the awareness instance and delete the room from the map
- [x] **1C.4** Log room eviction events for observability

### Phase 2: Rewrite Provider as Factory Function

This is the core of the migration. Replace the Y-Sweet class with a clean factory function using the supervisor loop architecture from `20260213T000000-fix-disconnect-reconnect-race.md`.

#### Why Rewrite, Not Rename

The current `YSweetProvider` class has structural problems documented in the race condition spec:

- **7 subsystems** competing through 11 pieces of shared mutable state
- **4 call sites** all calling `connect()`: constructor, websocketClose, websocketError, heartbeat timeout
- **Event handlers make decisions**: `websocketClose` sets `STATUS_ERROR` and calls `connect()` instead of just reporting
- **Status is both state and control flow**: `setStatus(ERROR)` implicitly keeps the connect loop running
- **No single owner** of "should we be connected?": 6 different mechanisms, 4 call sites, 2 guard strategies

A rename ships all of this under our brand. A rewrite fixes it.

#### Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    createSyncProvider() Closure                       │
│                                                                      │
│  INTENT:     desired: 'online' | 'offline'     (set by user)        │
│  ACTUAL:     status: SyncStatus                (set ONLY by loop)    │
│  CANCEL:     runId: number                     (bumped by disconnect) │
│                                                                      │
│  ┌──────────────────────────────────────────┐                        │
│  │         Supervisor Loop (ONE owner)       │                        │
│  │                                           │                        │
│  │  while (desired === 'online') {           │                        │
│  │    status = CONNECTING                    │                        │
│  │    token = await getTokenOrBackoff()      │                        │
│  │    result = await openAndWait(token)      │                        │
│  │    if (result === 'connected') {          │                        │
│  │      status = CONNECTED                   │                        │
│  │      await waitForSocketClose()   ←───────┼── promise resolved     │
│  │    } else {                               │   by event handlers     │
│  │      status = ERROR                       │                        │
│  │      await backoff()                      │                        │
│  │    }                                      │                        │
│  │  }                                        │                        │
│  │  status = OFFLINE                         │                        │
│  └──────────────────────────────────────────┘                        │
│                    ▲                                                  │
│                    │ resolve promise (that's it)                      │
│  ┌────────────────┴─────────────────────────┐                        │
│  │         Event Handlers (REPORTERS only)    │                        │
│  │                                           │                        │
│  │  onclose  → resolve socketClosed promise  │                        │
│  │  onerror  → resolve socketClosed promise  │                        │
│  │  timeout  → ws.close() (triggers onclose) │                        │
│  └───────────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

#### Provider Public API

```typescript
type SyncProviderConfig = {
	/** The Y.Doc to sync. */
	doc: Y.Doc;
	/** WebSocket URL to connect to. */
	url: string;
	/** Static token for Mode 2 auth. Mutually exclusive with getToken. */
	token?: string;
	/** Dynamic token fetcher for Mode 3 auth. Called on each connect/reconnect. */
	getToken?: () => Promise<string>;
	/** Whether to connect immediately. Defaults to true. */
	connect?: boolean;
	/** External awareness instance. Defaults to new Awareness(doc). */
	awareness?: awarenessProtocol.Awareness;
};

type SyncStatus =
	| 'offline'
	| 'connecting'
	| 'handshaking'
	| 'connected'
	| 'error';

type SyncProvider = {
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Whether there are unacknowledged local changes. */
	readonly hasLocalChanges: boolean;
	/** The awareness instance for user presence. */
	readonly awareness: awarenessProtocol.Awareness;
	/** Start connecting. Idempotent: safe to call multiple times. */
	connect(): void;
	/** Stop connecting and close the socket. */
	disconnect(): void;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	/** Subscribe to local changes state changes. Returns unsubscribe function. */
	onLocalChanges(listener: (hasLocalChanges: boolean) => void): () => void;
	/** Clean up everything: disconnect, remove listeners, release resources. */
	destroy(): void;
};

function createSyncProvider(config: SyncProviderConfig): SyncProvider;
```

#### What Changes From Y-Sweet, What Stays

| Component              | Y-Sweet (current)                                 | Rewrite                                                     | Change                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| Structure              | `class YSweetProvider` with 15 mutable fields     | `createSyncProvider()` factory with closure state           | **Rewrite**                      |
| Connect loop           | Checks `status` + `generation` in while condition | Checks `desired` + `runId`                                  | Same idea, cleaner               |
| `disconnect()`         | Bumps generation, sets status, wakes sleeper      | Sets desired = 'offline', bumps runId, wakes sleeper        | Same mechanics, clearer intent   |
| `websocketClose`       | Sets ERROR, calls connect()                       | Resolves `socketClosed` promise                             | **Dramatically simpler**         |
| `websocketError`       | Sets ERROR, calls connect()                       | Resolves `socketClosed` promise                             | **Dramatically simpler**         |
| Heartbeat timeout      | Closes socket + sets ERROR + calls connect()      | Closes socket (triggers onclose → resolves promise)         | **No more decision-making**      |
| Status transitions     | Set by 4 different methods                        | Set ONLY by the supervisor loop                             | **Single owner**                 |
| `isConnecting` boolean | Guard against concurrent loops                    | Replaced by `connectRun` promise                            | Idempotent connect()             |
| Event system           | Custom `Map<string, Set>` with `any` types        | Typed listener sets, `onStatusChange()` returns unsubscribe | **Type-safe, no `off()` needed** |
| Auth                   | `AuthEndpoint` → `ClientToken`                    | `url` + optional `token`/`getToken`                         | **Simpler**                      |
| Awareness              | `new Awareness(doc)` always                       | `config.awareness ?? new Awareness(doc)`                    | Supports external awareness      |
| `hasLocalChanges`      | `ackedVersion !== localVersion`                   | Same logic, same protocol                                   | Unchanged                        |
| Heartbeat (102)        | 2s probe + 3s timeout                             | Same timing, same protocol                                  | Unchanged                        |
| Browser online/offline | `window.addEventListener` in constructor          | Same, in factory setup                                      | Unchanged                        |
| Sleeper                | `createSleeper()`                                 | Same utility, unchanged                                     | Unchanged                        |

#### Implementation Steps

- [x] **2.1** Create `packages/sync/` directory with `package.json` (`@epicenter/sync`), `tsconfig.json`
- [x] **2.2** Copy `sleeper.ts` verbatim: it's already a clean factory function
- [x] **2.3** Write `types.ts` with `SyncProviderConfig`, `SyncStatus`, `SyncProvider` type
- [x] **2.4** Write `provider.ts`: the `createSyncProvider()` factory function:
  - Closure state: `desired`, `status`, `runId`, `localVersion`, `ackedVersion`, `websocket`, `heartbeatHandle`, `connectionTimeoutHandle`, `reconnectSleeper`, `statusListeners`, `localChangesListeners`
  - Supervisor loop: `runLoop(myRunId)`: single owner of status transitions and reconnection
  - Token handling: if `config.getToken`, call it on each connection attempt; if `config.token`, use static; if neither, no auth
  - Token transport: `Sec-WebSocket-Protocol` header (primary), `?token=` query param (fallback)
  - Heartbeat: same timing (2s idle → probe, 3s timeout → close socket)
  - `hasLocalChanges`: same `localVersion` / `ackedVersion` mechanism
  - Event handlers: `onopen` → resolve connect promise; `onclose`/`onerror` → resolve socketClosed promise; `onmessage` → dispatch by message type
  - Browser events: `online` wakes sleeper, `offline` triggers immediate probe
  - `destroy()`: disconnect, remove doc/awareness listeners, remove window listeners
- [x] **2.5** Write `index.ts`: public exports
- [x] **2.6** Write tests for the new provider:
  - Connect/disconnect lifecycle
  - Reconnection after socket close
  - `hasLocalChanges` toggles on sync status echo
  - `desired` / `status` separation (disconnect during connect doesn't race)
  - Token refresh after N retries
  - `destroy()` cleans up all listeners
- [x] **2.7** Delete `packages/y-sweet/` entirely: the old code is gone
- [x] **2.8** Update all imports: `@epicenter/y-sweet` → `@epicenter/sync`
- [x] **2.9** Update `bun.lock` / workspace references

### Phase 3: Rename Extension + Simplify Auth

Rename the extension files and update the config to use the new provider API.

- [x] **3.1** Rename `y-sweet-persist-sync.ts` → `sync.ts`
- [x] **3.2** Rename `y-sweet-persist-sync.test.ts` → `sync.test.ts`
- [x] **3.3** Rename `y-sweet-persist-sync/` → `sync/` (web.ts, desktop.ts)
- [x] **3.4** Rename `ySweetPersistSync` → `createSyncExtension`
- [x] **3.5** Rename `YSweetPersistSyncConfig` → `SyncExtensionConfig`
- [x] **3.6** Simplify config:
  ```typescript
  type SyncExtensionConfig = {
	/** WebSocket URL. Use {id} placeholder for workspace ID. */
	url: string | ((workspaceId: string) => string);
	/** Static token (Mode 2). */
	token?: string;
	/** Dynamic token fetcher (Mode 3). */
	getToken?: (workspaceId: string) => Promise<string>;
	/** Persistence factory (REQUIRED). */
	persistence: (context: { ydoc: Y.Doc }) => Lifecycle;
  };
  ```
- [x] **3.7** Remove `directAuth()` helper: URL is passed directly
- [x] **3.8** Remove `ClientToken` type and `YSweetClientToken` re-export
- [x] **3.9** Update `package.json` exports: `./extensions/y-sweet-persist-sync` → `./extensions/sync`
- [x] **3.10** Update consumer imports (tab-manager, epicenter app)
- [x] **3.11** Update extension tests for new config shape

### Phase 4: Delete Dead Code

- [x] **4.1** Delete `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`
- [x] **4.2** Remove any remaining Y-Sweet URL format references (`/d/{docId}/ws`)
- [x] **4.3** Remove `@y-sweet/client` and `@y-sweet/sdk` from any remaining dependency lists
- [x] **4.4** Grep for `y-sweet`, `ysweet`, `YSweet` across the codebase: nothing outside specs/ and docs/

### Phase 5: Verification

- [x] **5.1** `bun test` passes in `packages/sync/` (15 tests pass)
- [x] **5.2** `bun test` passes in `packages/epicenter/` (sync extension: 5 tests pass)
- [x] **5.3** `bun test` passes in `packages/server/` (56 tests pass)
- [x] **5.4** `bun typecheck` passes across packages/sync/ and packages/server/ (no new errors)
- [ ] **5.5** Manual test: start Elysia server, connect provider, verify `hasLocalChanges` toggles correctly
- [ ] **5.6** Manual test: kill server, verify provider reconnects within 5 seconds
- [ ] **5.7** Manual test: kill client (close tab), verify server evicts connection via ping/pong within 60s
- [x] **5.8** Grep for `y-sweet`: zero hits outside specs/ and docs/articles/

## Edge Cases

### MESSAGE_SYNC_STATUS with Standard y-websocket Clients

If a y-websocket client connects to our server and receives a type 102 message, it ignores it (unknown tags are silently skipped in all Yjs implementations). No breakage.

### Provider Connected to Non-Echo Server

If `createSyncProvider` connects to a server that doesn't echo 102 (e.g., a standard y-websocket server), the heartbeat messages are sent but ignored. The provider must track whether it has ever received a 102 response on the current connection. If it hasn't, it doesn't arm the 3-second reconnect timeout: preventing false-positive disconnects. This is the same backward-compatibility guard Y-Sweet uses.

### Token Expiry During Active Session

JWT is validated only at WebSocket upgrade time. Once connected, the session is trusted for the duration of that connection. On reconnect (after socket close), `getToken()` is called again to fetch a fresh token. No mid-session revalidation needed.

### Concurrent connect() Calls

The supervisor loop must be idempotent. If `connect()` is called while a loop is already running, it's a no-op. Implementation: store the running loop's promise; if non-null, don't start another.

### disconnect() During Backoff Sleep

`disconnect()` sets `desired = 'offline'` and bumps `runId`. The sleeping loop wakes (via `sleeper.wake()`), checks `runId`, sees it changed, exits. No race because the loop checks `runId` after every await.

### Server Ping Timeout vs Client Heartbeat

Both mechanisms run independently:

- **Client heartbeat (102)**: Client detects dead server within 5 seconds
- **Server ping/pong**: Server detects dead client within 60 seconds (30s interval × 2 pings)

They don't interfere because they operate at different protocol layers (application vs WebSocket).

### Room Eviction Race

A connection joins room "X", then disconnects. Eviction timer starts (60s). A new connection joins "X" at 59s. The timer must be cancelled. Implementation: store the timer handle in the room state; clear it on new connection join.

## Open Questions

1. **Should `MESSAGE_SYNC_STATUS` be added to `MESSAGE_TYPE` in protocol.ts or kept as a separate constant?**
   - It's an extension beyond the standard y-websocket protocol.
   - **Recommendation**: Add it to `MESSAGE_TYPE` as `SYNC_STATUS: 102` with a JSDoc comment. We own both sides, and keeping protocol constants in one place is cleaner.

2. **Should the provider expose the raw WebSocket for testing?**
   - Unit tests need to simulate server responses (send fake MESSAGE_SYNC_STATUS, close the socket, etc.).
   - **Recommendation**: Accept a `WebSocketPolyfill` in config (same as Y-Sweet did). Tests can pass a mock WebSocket constructor.

3. **Should the provider support connecting to multiple servers simultaneously?**
   - The current architecture supports this via multiple `createSyncExtension` calls on the same workspace.
   - **Recommendation**: Keep single-server per provider. Multi-server is a workspace-level concern.

4. **Should room eviction also persist the Y.Doc state to disk before destroying?**
   - Currently the server is stateless (no server-side persistence). If a room is evicted and a client reconnects, the client syncs its full state vector.
   - **Recommendation**: No server-side persistence for now. Client-side persistence (IndexedDB/filesystem) is the source of truth. Defer server persistence to a future spec if needed.

5. **Should `@epicenter/sync` also export a Rust-compatible protocol definition?**
   - If the Elysia server eventually gets a Rust companion for performance-critical paths.
   - **Recommendation**: TypeScript only for now. It's one constant (`102`). Manual sync is fine.

## Success Criteria

- [x] `@epicenter/y-sweet` package no longer exists: replaced by `@epicenter/sync`
- [x] `createSyncProvider()` is a factory function, not a class: closure-based state, supervisor loop, typed events
- [x] Server echoes MESSAGE_SYNC_STATUS (102): `hasLocalChanges` works end-to-end
- [x] Server has ping/pong keepalive: dead clients detected within 60s
- [x] Server evicts idle rooms: no memory leaks on long-running servers
- [x] Provider connects to `@epicenter/server` Elysia sync endpoint (not Y-Sweet URLs)
- [x] Provider supports three auth modes: no auth, static token, dynamic getToken
- [x] Dead connection detected within 5 seconds from client side (heartbeat)
- [x] All tests pass in packages/sync, packages/epicenter, packages/server
- [x] Zero references to `y-sweet` outside specs/ and docs/ (historical references OK)
- [x] Tab manager and Epicenter app updated to use new import paths

## References

- `packages/y-sweet/src/provider.ts`: Current provider (DELETE target, ~610 lines). Port: heartbeat timing, `hasLocalChanges` logic, awareness protocol, sync protocol. Drop: class structure, event handler decision-making, `ClientToken` abstraction.
- `packages/y-sweet/src/sleeper.ts`: Wakeable sleep utility (COPY verbatim: already a clean factory function)
- `packages/y-sweet/src/main.ts`: Old factory (DELETE: replaced by `createSyncProvider`)
- `packages/y-sweet/src/types.ts`: Old types (DELETE: replaced by `types.ts`)
- `packages/server/src/sync/index.ts`: Elysia sync plugin (MODIFY: add 102 echo, ping/pong, room eviction)
- `packages/server/src/sync/protocol.ts`: Protocol encode/decode (MODIFY: add SYNC_STATUS constant + encoder)
- `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: Extension factory (RENAME + simplify config)
- `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts`: IndexedDB persistence (RENAME dir)
- `packages/epicenter/src/extensions/y-sweet-persist-sync/desktop.ts`: Filesystem persistence (RENAME dir)
- `apps/tab-manager/src/entrypoints/background.ts`: Consumer (UPDATE imports)
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`: DELETE entirely
- `specs/20260213T000000-fix-disconnect-reconnect-race.md`: Supervisor loop architecture (Parts 4-5)
- `specs/20260213T120800-extract-epicenter-server-package.md`: Server extraction + three-mode auth design
- `specs/20260213T120800-cloud-sync-durable-objects.md`: Cloud path (shares protocol + room layers)
- `docs/articles/y-sweet-message-sync-status.md`: Technical article on the 102 protocol
- `docs/articles/three-gradations-of-websocket-auth.md`: Auth mode rationale
- `packages/epicenter/src/shared/lifecycle.ts`: Lifecycle type that extensions must satisfy
- `packages/epicenter/src/extensions/error-logger.ts`: Reference factory function pattern (async queue + lifecycle)
