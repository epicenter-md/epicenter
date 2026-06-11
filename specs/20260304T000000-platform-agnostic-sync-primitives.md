# Platform-Agnostic Sync Primitives

**Goal**: Extract framework-agnostic TypeScript primitives from `@epicenter/server-elysia` (formerly `@epicenter/server`) so the same sync logic can power both an Elysia/Bun deployment (local/remote self-hosted) and a Hono/Cloudflare Workers + Durable Objects deployment (cloud-hosted).

**Status**: Phase 1 Implemented (sync-core extraction + server refactor + rename to `server-elysia`)

### Dependency Graph

```
@epicenter/sync                  (pure: yjs + lib0 + y-protocols only)
├── @epicenter/server-elysia          (Elysia plugins: sync, auth, discovery)
│   ├── @epicenter/server-local       (local desktop server)
│   └── @epicenter/server-remote      (self-hosted remote server)
└── @epicenter/server-cloudflare      (Hono + Durable Objects) [Phase 2]
```

---

## Problem

Previously, `@epicenter/server` (now `@epicenter/server-elysia`) tightly coupled Yjs sync protocol logic with Elysia plugin construction. The protocol encoding (`protocol.ts`), room management (`rooms.ts`), and storage interface (`storage.ts`) were _almost_ framework-agnostic, but they lived inside an Elysia-dependent package and some pieces (like the WS message handler in `ws/plugin.ts`) mixed protocol dispatch with Elysia's `ws.sendBinary()` / `ws.raw` patterns.

This means:
- We can't reuse the sync logic in a Cloudflare Durable Object (which uses `WebSocketPair` + `webSocketMessage()`)
- We can't reuse it in a Hono Worker (which uses `upgradeWebSocket()` from `hono/cloudflare-workers`)
- The HTTP sync plugin is already nearly stateless but is wrapped in Elysia guard/plugin boilerplate
- Auth verification is threaded through Elysia-specific `beforeHandle` hooks

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    @epicenter/sync (NEW)                    │
│  Pure TypeScript. Zero framework deps. Only yjs + lib0 + y-protocols.    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  protocol.ts  │  │   rooms.ts   │  │      storage.ts        │ │
│  │  (encode/     │  │  (room       │  │  (SyncStorage iface,   │ │
│  │   decode)     │  │   lifecycle) │  │   encode/decode,       │ │
│  │              │  │              │  │   compaction)          │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    handlers.ts (NEW)                         ││
│  │  Framework-agnostic request/message handlers.                ││
│  │  Pure functions: bytes in → bytes out + side effects.        ││
│  │                                                              ││
│  │  handleWsOpen(...)    → Uint8Array[] (messages to send)      ││
│  │  handleWsMessage(...) → { response?: Uint8Array,             ││
│  │                          broadcast?: Uint8Array }            ││
│  │  handleWsClose(...)   → void                                 ││
│  │  handleHttpSync(...)  → { status, body? }                    ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                      auth.ts (NEW)                           ││
│  │  Pure token extraction + verification interface.             ││
│  │  extractBearerToken(header) → string | undefined             ││
│  │  type TokenVerifier = (token: string) => boolean | Promise<> ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
          │                            │
          ▼                            ▼
┌──────────────────────────┐   ┌──────────────────────────────────┐
│  @epicenter/server-elysia │   │  @epicenter/server-cloudflare     │
│  (Elysia/Bun)             │   │  (Hono + Durable Objects)         │
│                      │   │                                   │
│  createWsSyncPlugin  │   │  Worker (Hono):                   │
│  createHttpSyncPlugin│   │    - Auth middleware               │
│  createTokenGuard    │   │    - POST /:room (HTTP sync)      │
│  createAuthPlugin    │   │    - GET /:room/ws → route to DO  │
│                      │   │                                   │
│  Wraps sync-core     │   │  Durable Object (raw CF API):     │
│  handlers in Elysia  │   │    - YjsRoom class                │
│  plugin boilerplate  │   │    - fetch() for WS upgrade       │
│                      │   │    - webSocketMessage/Close        │
│                      │   │    - Uses sync-core handlers       │
│                      │   │    - DO SQLite for persistence     │
└─────────────────────┘   └──────────────────────────────────┘
```

## Detailed Design

### 1. `@epicenter/sync`: The New Package

This package extracts everything that is currently framework-agnostic (or can be made so) from `@epicenter/server-elysia/src/sync/`.

**Dependencies**: `yjs`, `y-protocols`, `lib0` only. Zero framework deps. Zero Node/Bun/CF-specific APIs.

#### 1.1 `protocol.ts`: Move as-is

The current `packages/server-elysia/src/sync/ws/protocol.ts` is already pure. Move it unchanged.

Exports:
- `MESSAGE_TYPE`, `SYNC_MESSAGE_TYPE`
- `encodeSyncStep1`, `encodeSyncStep2`, `encodeSyncUpdate`
- `handleSyncMessage`
- `encodeSyncStatus`, `decodeSyncStatus`
- `encodeAwareness`, `encodeAwarenessStates`, `encodeQueryAwareness`
- `decodeMessageType`, `decodeSyncMessage`

#### 1.2 `storage.ts`: Move as-is

The current `packages/server-elysia/src/sync/http/storage.ts` is already pure. Move it unchanged.

Exports:
- `SyncStorage` interface
- `encodeSyncRequest`, `decodeSyncRequest`
- `stateVectorsEqual`
- `createMemorySyncStorage`
- `compactDoc`

#### 1.3 `rooms.ts`: Move with minor cleanup

The current `rooms.ts` is _almost_ pure. The only coupling is the JSDoc mentioning `ws.raw`. The actual API takes `object` as connection identity and `(data: Uint8Array) => void` as send function: already framework-agnostic.

Move it as-is. The connection identity is just `object`: Elysia passes `ws.raw`, Durable Objects pass the `WebSocket` instance, etc.

#### 1.4 `handlers.ts`: NEW: Framework-Agnostic Message Handlers

This is the key new file. It extracts the _logic_ from `ws/plugin.ts`'s `open`, `message`, and `close` handlers into pure functions that any framework adapter can call.

```typescript
import * as decoding from 'lib0/decoding';
import { type Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import {
  encodeAwareness, encodeAwarenessStates, encodeSyncStatus,
  encodeSyncStep1, encodeSyncUpdate, handleSyncMessage, MESSAGE_TYPE,
} from './protocol';
import type { createRoomManager } from './rooms';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque connection identity. Elysia uses ws.raw, CF uses WebSocket instance. */
type ConnectionId = object;

/** Result of handling a WS open event. */
type WsOpenResult =
  | { ok: true; initialMessages: Uint8Array[]; doc: Y.Doc; awareness: Awareness }
  | { ok: false; closeCode: number; closeReason: string };

/** Result of handling a single WS message. */
type WsMessageResult = {
  /** Message to send back to the sender (e.g., SyncStep2 response, SYNC_STATUS echo). */
  response?: Uint8Array;
  /** Message to broadcast to all OTHER connections in the room. */
  broadcast?: Uint8Array;
};

/** Per-connection state that the adapter must store. */
type ConnectionState = {
  roomId: string;
  doc: Y.Doc;
  awareness: Awareness;
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  controlledClientIds: Set<number>;
  connId: ConnectionId;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle a new WebSocket connection opening.
 *
 * The adapter calls this when a WebSocket connects. It returns:
 * - Messages to send to the client (sync step 1 + awareness states)
 * - A ConnectionState the adapter must store for the connection's lifetime
 * - An updateHandler that the adapter must register on doc.on('update')
 *
 * The adapter is responsible for:
 * - Sending the initialMessages to the client
 * - Registering doc.on('update', state.updateHandler)
 * - Storing the ConnectionState (keyed however makes sense for the framework)
 */
function handleWsOpen(
  roomManager: ReturnType<typeof createRoomManager>,
  roomId: string,
  connId: ConnectionId,
  send: (data: Uint8Array) => void,
): WsOpenResult & { state?: ConnectionState } {
  const result = roomManager.join(roomId, connId, send);
  if (!result) {
    return { ok: false, closeCode: 4004, closeReason: `Room not found: ${roomId}` };
  }

  const { doc, awareness } = result;
  const controlledClientIds = new Set<number>();

  // Build initial messages
  const initialMessages: Uint8Array[] = [encodeSyncStep1({ doc })];
  const awarenessStates = awareness.getStates();
  if (awarenessStates.size > 0) {
    initialMessages.push(
      encodeAwarenessStates({ awareness, clients: Array.from(awarenessStates.keys()) })
    );
  }

  // Create update handler (adapter registers this on doc.on('update'))
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === connId) return; // Don't echo back to sender
    send(encodeSyncUpdate({ update }));
  };

  const state: ConnectionState = {
    roomId, doc, awareness, updateHandler, controlledClientIds, connId,
  };

  return { ok: true, initialMessages, doc, awareness, state };
}

/**
 * Handle an incoming WebSocket binary message.
 *
 * Pure dispatch on MESSAGE_TYPE. Returns what the adapter should send/broadcast.
 * The adapter is responsible for actually sending the bytes.
 */
function handleWsMessage(
  data: Uint8Array,
  state: ConnectionState,
  roomManager: ReturnType<typeof createRoomManager>,
): WsMessageResult {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_TYPE.SYNC: {
      const response = handleSyncMessage({ decoder, doc: state.doc, origin: state.connId });
      return response ? { response } : {};
    }

    case MESSAGE_TYPE.AWARENESS: {
      const update = decoding.readVarUint8Array(decoder);
      // Track controlled client IDs (best-effort, errors swallowed)
      try {
        const decoder2 = decoding.createDecoder(update);
        const len = decoding.readVarUint(decoder2);
        for (let i = 0; i < len; i++) {
          const clientId = decoding.readVarUint(decoder2);
          decoding.readVarUint(decoder2); // clock
          const awarenessState = JSON.parse(decoding.readVarString(decoder2));
          if (awarenessState === null) {
            state.controlledClientIds.delete(clientId);
          } else {
            state.controlledClientIds.add(clientId);
          }
        }
      } catch { /* best effort */ }

      applyAwarenessUpdate(state.awareness, update, state.connId);
      const broadcast = encodeAwareness({ update });
      return { broadcast };
    }

    case MESSAGE_TYPE.QUERY_AWARENESS: {
      const awarenessStates = state.awareness.getStates();
      if (awarenessStates.size > 0) {
        return {
          response: encodeAwarenessStates({
            awareness: state.awareness,
            clients: Array.from(awarenessStates.keys()),
          }),
        };
      }
      return {};
    }

    case MESSAGE_TYPE.SYNC_STATUS: {
      const payload = decoding.readVarUint8Array(decoder);
      return { response: encodeSyncStatus({ payload }) };
    }

    default:
      return {};
  }
}

/**
 * Handle a WebSocket connection closing.
 *
 * The adapter calls this during its close handler.
 * The adapter is responsible for:
 * - Calling doc.off('update', state.updateHandler) before this
 * - Cleaning up any framework-specific state (ping intervals, etc.)
 */
function handleWsClose(
  state: ConnectionState,
  roomManager: ReturnType<typeof createRoomManager>,
): void {
  state.doc.off('update', state.updateHandler);

  if (state.controlledClientIds.size > 0) {
    removeAwarenessStates(state.awareness, Array.from(state.controlledClientIds), null);
  }

  roomManager.leave(state.roomId, state.connId);
}

/**
 * Handle an HTTP sync request (POST /:room).
 *
 * Stateless: no Y.Doc instantiated. Works with raw SyncStorage.
 * Returns a result the adapter maps to an HTTP response.
 */
async function handleHttpSync(
  storage: SyncStorage,
  roomId: string,
  body: Uint8Array,
): Promise<{ status: 200 | 304 | 404; body?: Uint8Array }> {
  const { stateVector: clientSV, update } = decodeSyncRequest(body);

  if (update.byteLength > 0) {
    await storage.appendUpdate(roomId, update);
  }

  const updates = await storage.getAllUpdates(roomId);
  if (updates.length === 0) {
    return { status: 304 };
  }

  const merged = Y.mergeUpdatesV2(updates);
  const serverSV = Y.encodeStateVectorFromUpdateV2(merged);

  if (stateVectorsEqual(serverSV, clientSV)) {
    return { status: 304 };
  }

  const diff = Y.diffUpdateV2(merged, clientSV);
  return { status: 200, body: diff };
}
```

#### 1.5 `auth.ts`: Pure Token Extraction

```typescript
/** Extract a Bearer token from an Authorization header value. */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice(7);
}

/** Token verification function. Adapters wire this into their middleware. */
export type TokenVerifier = (token: string) => boolean | Promise<boolean>;
```

#### 1.6 Package structure

```
packages/sync-core/
  package.json          # deps: yjs, y-protocols, lib0 only
  src/
    index.ts            # re-exports everything
    protocol.ts         # moved from server-elysia/src/sync/ws/protocol.ts
    rooms.ts            # moved from server-elysia/src/sync/ws/rooms.ts
    storage.ts          # moved from server-elysia/src/sync/http/storage.ts
    handlers.ts         # NEW: framework-agnostic handlers
    auth.ts             # pure token extraction + TokenVerifier type
```

### 2. `@epicenter/server-elysia`: Elysia Adapter (Refactored)

After extraction, this package becomes a thin Elysia wrapper around `@epicenter/sync`. Renamed from `@epicenter/server` to make the framework explicit.

**Dependencies**: `elysia`, `@epicenter/sync`

#### 2.1 `createWsSyncPlugin`: Simplified

The current 300-line plugin becomes ~100 lines that:
1. Creates a `roomManager` from sync-core
2. Maps Elysia WS events to sync-core handlers
3. Manages Elysia-specific concerns (WeakMap keyed on `ws.raw`, ping intervals, `queueMicrotask`)

```typescript
import { Elysia, t } from 'elysia';
import {
  createRoomManager, handleWsOpen, handleWsMessage, handleWsClose,
  type ConnectionState, type TokenVerifier,
} from '@epicenter/sync';

export function createWsSyncPlugin(config?: WsSyncPluginConfig) {
  const roomManager = createRoomManager(config);
  const connStates = new WeakMap<object, ConnectionState>();
  const pingIntervals = new WeakMap<object, ReturnType<typeof setInterval>>();

  return new Elysia()
    .get('/', () => ({ rooms: roomManager.roomInfo() }))
    .ws('/:room', {
      query: t.Object({ token: t.Optional(t.String()) }),

      async beforeHandle({ query, status }) {
        if (!config?.verifyToken) return;
        if (!query.token || !(await config.verifyToken(query.token))) return status(401);
      },

      open(ws) {
        const rawWs = ws.raw;
        const result = handleWsOpen(roomManager, ws.data.params.room, rawWs, (data) => ws.sendBinary(data));

        if (!result.ok) {
          ws.close(result.closeCode, result.closeReason);
          return;
        }

        result.doc.on('update', result.state!.updateHandler);
        connStates.set(rawWs, result.state!);

        // Defer initial messages to next tick (Elysia WS readiness)
        queueMicrotask(() => {
          for (const msg of result.initialMessages) ws.sendBinary(msg);
        });

        // Elysia/Bun-specific: server-side ping/pong keepalive
        const interval = setInterval(() => ws.raw.ping(), 30_000);
        pingIntervals.set(rawWs, interval);
      },

      message(ws, message) {
        const state = connStates.get(ws.raw);
        if (!state) return;

        const data = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        const result = handleWsMessage(data, state, roomManager);

        if (result.response) ws.sendBinary(result.response);
        if (result.broadcast) roomManager.broadcast(state.roomId, result.broadcast, ws.raw);
      },

      close(ws) {
        const state = connStates.get(ws.raw);
        if (!state) return;

        const interval = pingIntervals.get(ws.raw);
        if (interval) clearInterval(interval);

        handleWsClose(state, roomManager);
        connStates.delete(ws.raw);
        pingIntervals.delete(ws.raw);
      },
    });
}
```

#### 2.2 `createHttpSyncPlugin`: Simplified

```typescript
import { Elysia } from 'elysia';
import { extractBearerToken, handleHttpSync, type SyncStorage, type TokenVerifier } from '@epicenter/sync';

export function createHttpSyncPlugin(config: { storage: SyncStorage; verifyToken?: TokenVerifier }) {
  return new Elysia()
    .guard({
      async beforeHandle({ headers, status }) {
        if (!config.verifyToken) return;
        const token = extractBearerToken(headers.authorization);
        if (!token || !(await config.verifyToken(token))) return status('Unauthorized');
      },
    })
    .post('/:room', async ({ params, request, set }) => {
      const body = new Uint8Array(await request.arrayBuffer());
      const result = await handleHttpSync(config.storage, params.room, body);
      set.status = result.status;
      if (result.body) set.headers['content-type'] = 'application/octet-stream';
      return result.body;
    })
    .get('/:room', async ({ params, set, status }) => {
      // Full doc fetch: delegate to storage directly
      const updates = await config.storage.getAllUpdates(params.room);
      if (updates.length === 0) return status('Not Found');
      const merged = Y.mergeUpdatesV2(updates);
      set.headers['content-type'] = 'application/octet-stream';
      return merged;
    });
}
```

#### 2.3 Auth plugins: Unchanged

`createTokenGuardPlugin` and `createAuthPlugin` (Better Auth) stay in their current packages. They're Elysia-specific by nature and compose via `.use()`. The `TokenVerifier` type from sync-core is what bridges auth into sync.

### 3. `@epicenter/server-cloudflare`: Hono + Durable Objects

**Dependencies**: `hono`, `@epicenter/sync`, `@cloudflare/workers-types`

This is a new package. It has two parts:

#### 3.1 Hono Worker: Auth Gateway + HTTP Sync + DO Router

The Worker handles:
- Auth verification (before anything reaches the DO)
- HTTP sync routes (stateless, uses R2-backed `SyncStorage`)
- WebSocket upgrade routing to the correct Durable Object

```typescript
import { Hono } from 'hono';
import { extractBearerToken, handleHttpSync, type SyncStorage, type TokenVerifier } from '@epicenter/sync';

type Env = {
  Bindings: {
    YROOM: DurableObjectNamespace;        // Durable Object binding
    SYNC_BUCKET: R2Bucket;                // R2 for HTTP sync storage
    AUTH_TOKEN?: string;                   // Pre-shared token mode
    BETTER_AUTH_URL?: string;             // Better Auth remote URL
  };
};

const app = new Hono<Env>();

// Auth middleware
app.use('/rooms/*', async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization'))
    ?? c.req.query('token');   // WS upgrade passes token as query param
  if (!token) return c.text('Unauthorized', 401);

  // Verify token (pre-shared or remote Better Auth session)
  const valid = await verifyToken(c.env, token);
  if (!valid) return c.text('Unauthorized', 401);

  await next();
});

// HTTP sync (stateless: no DO needed)
app.post('/rooms/:room', async (c) => {
  const storage = createR2SyncStorage(c.env.SYNC_BUCKET);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const result = await handleHttpSync(storage, c.req.param('room'), body);

  if (result.status === 304) return c.body(null, 304);
  return c.body(result.body!, 200, { 'content-type': 'application/octet-stream' });
});

// WebSocket upgrade → route to Durable Object
app.get('/rooms/:room/ws', async (c) => {
  const roomId = c.req.param('room');
  const id = c.env.YROOM.idFromName(roomId);
  const stub = c.env.YROOM.get(id);
  // Forward the upgrade request to the DO
  return stub.fetch(c.req.raw);
});

export default app;
```

#### 3.2 Durable Object: `YjsRoom` Class

Each DO instance IS one room. It uses sync-core handlers directly.

```typescript
import {
  handleWsOpen, handleWsMessage, handleWsClose,
  createRoomManager, type ConnectionState,
} from '@epicenter/sync';

export class YjsRoom implements DurableObject {
  private roomManager: ReturnType<typeof createRoomManager>;
  private connStates = new Map<WebSocket, ConnectionState>();

  constructor(private state: DurableObjectState, private env: Env) {
    // Single-room manager. The DO IS the room, so getDoc always returns the same doc.
    // We use standalone mode: the DO manages its own Y.Doc lifecycle.
    this.roomManager = createRoomManager({
      onRoomEvicted: async (roomId, doc) => {
        // Persist to DO SQLite on eviction (optional)
        await this.persistDoc(roomId, doc);
      },
    });

    // Restore doc from storage on wake (if hibernation API is used)
    // this.state.blockConcurrencyWhile(() => this.loadDoc());
  }

  async fetch(request: Request): Promise<Response> {
    // Only handle WebSocket upgrades
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with hibernation API for cost savings
    this.state.acceptWebSocket(server);

    // Use a fixed room ID since the DO IS the room
    const roomId = 'default';
    const result = handleWsOpen(
      this.roomManager, roomId, server,
      (data) => server.send(data),
    );

    if (!result.ok) {
      server.close(result.closeCode, result.closeReason);
      return new Response(null, { status: 404 });
    }

    result.doc.on('update', result.state!.updateHandler);
    this.connStates.set(server, result.state!);

    // Send initial messages
    for (const msg of result.initialMessages) {
      server.send(msg);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const state = this.connStates.get(ws);
    if (!state) return;

    if (typeof message === 'string') return; // Binary protocol only
    const data = new Uint8Array(message);
    const result = handleWsMessage(data, state, this.roomManager);

    if (result.response) ws.send(result.response);
    if (result.broadcast) this.roomManager.broadcast(state.roomId, result.broadcast, ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = this.connStates.get(ws);
    if (!state) return;

    handleWsClose(state, this.roomManager);
    this.connStates.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
```

#### 3.3 R2 SyncStorage Implementation

```typescript
import { type SyncStorage } from '@epicenter/sync';

export function createR2SyncStorage(bucket: R2Bucket): SyncStorage {
  return {
    async appendUpdate(docId, update) {
      const key = `${docId}/updates/${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await bucket.put(key, update);
    },

    async getAllUpdates(docId) {
      const list = await bucket.list({ prefix: `${docId}/updates/` });
      const updates: Uint8Array[] = [];
      for (const obj of list.objects) {
        const body = await bucket.get(obj.key);
        if (body) updates.push(new Uint8Array(await body.arrayBuffer()));
      }
      return updates;
    },

    async compact(docId, mergedUpdate) {
      // Delete old updates
      const list = await bucket.list({ prefix: `${docId}/updates/` });
      for (const obj of list.objects) {
        await bucket.delete(obj.key);
      }
      // Write single compacted update
      await bucket.put(`${docId}/updates/snapshot`, mergedUpdate);
    },
  };
}
```

Note: R2 is used here for the HTTP sync storage (stateless path). The Durable Object uses its own in-memory Y.Doc (managed by the room manager) and optionally persists to DO SQLite storage. These are two different storage paths for two different deployment patterns.

### 4. Auth Integration

Auth verification must work the same way regardless of framework. The `TokenVerifier` type is the contract:

```typescript
type TokenVerifier = (token: string) => boolean | Promise<boolean>;
```

#### 4.1 Pre-shared token mode

```typescript
// Works everywhere: pure function
const verifyToken: TokenVerifier = (token) => token === process.env.AUTH_TOKEN;
```

#### 4.2 Better Auth session mode

```typescript
// Elysia (self-hosted): uses better-auth directly
import { betterAuth } from 'better-auth';
const auth = betterAuth({ /* ... */ });
const verifyToken: TokenVerifier = async (token) => {
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  return session !== null;
};

// Cloudflare Worker: calls remote Better Auth endpoint
const verifyToken: TokenVerifier = async (token) => {
  const res = await fetch(`${BETTER_AUTH_URL}/auth/get-session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.user !== null;
};
```

The key insight: **the sync-core package doesn't care how tokens are verified**. It just exports the `TokenVerifier` type. Each adapter wires in its own implementation.

### 5. What Stays Where

| File/Concern | Current Location | New Location | Notes |
|---|---|---|---|
| `protocol.ts` (WS encode/decode) | `server-elysia/src/sync/ws/protocol.ts` | `sync-core/src/protocol.ts` | Move as-is |
| `rooms.ts` (room lifecycle) | `server-elysia/src/sync/ws/rooms.ts` | `sync-core/src/rooms.ts` | Move as-is |
| `storage.ts` (SyncStorage + encode) | `server-elysia/src/sync/http/storage.ts` | `sync-core/src/storage.ts` | Move as-is |
| WS message dispatch logic | `server-elysia/src/sync/ws/plugin.ts` (inline) | `sync-core/src/handlers.ts` | Extract from plugin |
| HTTP sync logic | `server-elysia/src/sync/http/plugin.ts` (inline) | `sync-core/src/handlers.ts` | Extract from plugin |
| `extractBearerToken` | `server-elysia/src/auth.ts` | `sync-core/src/auth.ts` | Move (pure function) |
| `TokenVerifier` type | implicit | `sync-core/src/auth.ts` | New explicit type |
| `createTokenGuardPlugin` | `server-elysia/src/auth.ts` | `server-elysia/src/auth.ts` | Stays (Elysia-specific) |
| `createAuthPlugin` (Better Auth) | `server-remote/src/auth/plugin.ts` | Stays | Elysia-specific |
| `createWsSyncPlugin` | `server-elysia/src/sync/ws/plugin.ts` | `server-elysia/src/sync/ws/plugin.ts` | Refactor to call sync-core handlers |
| `createHttpSyncPlugin` | `server-elysia/src/sync/http/plugin.ts` | `server-elysia/src/sync/http/plugin.ts` | Refactor to call sync-core handlers |
| Discovery (awareness.ts) | `server-elysia/src/discovery/` | Stays | Already framework-agnostic, but Elysia-coupled for transport |
| Hono Worker + DO | doesn't exist | `server-cloudflare/` | New |

### 6. Migration Path

**Phase 1: Extract `sync-core`** ✅
1. [x] Create `packages/sync-core/` with `package.json` (deps: yjs, y-protocols, lib0)
2. [x] Move `protocol.ts`, `rooms.ts`, `storage.ts` (these have full test suites: move tests too)
3. [x] Create `handlers.ts` by extracting logic from `ws/plugin.ts` and `http/plugin.ts`
   > **Note**: Added `handleHttpGetDoc` handler (not in original spec) for the GET /:room endpoint.
   > Removed `roomManager` param from `handleWsMessage`: adapter handles broadcast via return value.
4. [x] Create `auth.ts` with `extractBearerToken` and `TokenVerifier`
5. [x] Update `@epicenter/server-elysia` (formerly `@epicenter/server`) to depend on `@epicenter/sync` and import from it
6. [x] Refactor `createWsSyncPlugin` and `createHttpSyncPlugin` to be thin wrappers
7. [x] Verify all existing tests pass (70 sync-core unit + 14 plugin integration = 84 total)
8. [x] Rename `@epicenter/server` → `@epicenter/server-elysia` to make framework explicit in package name

**Phase 2: Add Cloudflare target**
1. Create `packages/server-cloudflare/`
2. Implement Hono Worker with auth middleware + HTTP sync routes
3. Implement `YjsRoom` Durable Object class
4. Implement `createR2SyncStorage` (or `createDOSqliteSyncStorage` for DO-local storage)
5. Wire auth verification (pre-shared token first, Better Auth session later)
6. Test with wrangler dev locally

### 7. Open Questions

1. **Package name**: ~~`sync-core` vs `sync-protocol` vs `sync-primitives`?~~ Resolved: `@epicenter/sync`. Clear distinction from `@epicenter/sync` (client-side provider).

2. **Discovery on Cloudflare**: The device discovery system piggybacks on WS sync rooms via `DISCOVERY_ROOM_ID`. On CF, this would be a dedicated DO. Worth supporting in the first pass or defer?

3. **DO storage strategy**: Use DO SQLite (built-in, free reads) or R2 (shared across DOs, but higher latency)? The DO could use SQLite for hot data and R2 for cold snapshots.

4. **Room manager in DO context**: In a Durable Object, there's exactly one room per DO. The room manager is still useful for its connection tracking and broadcast logic, but the eviction/lifecycle parts are handled by DO hibernation instead. Should we split room manager into "connection tracker" (useful everywhere) and "room lifecycle" (only for self-hosted)?

5. **Awareness on HTTP**: The HTTP sync path doesn't support awareness. Is this acceptable for the CF Workers HTTP route, or do we need awareness via a separate mechanism (e.g., a separate DO for presence)?

6. **Better Auth on CF**: Better Auth needs a database. On CF this would be D1 (Cloudflare's SQLite). Better Auth has a D1 adapter. Worth integrating or keep using a remote Better Auth server?

---

## Review

**Completed**: 2026-03-04 (Phase 1 only)
**Branch**: braden-w/server-pkg-overview-v1

### Summary

Phase 1 extracted all framework-agnostic sync logic from `@epicenter/server` into a new `@epicenter/sync` package and renamed `@epicenter/server` to `@epicenter/server-elysia` to make the framework dependency explicit. The server-elysia package went from ~2300 lines of sync code to ~60 lines of thin Elysia wrappers that delegate to sync-core handlers. All 84 tests pass (70 unit + 14 integration).

### Deviations from Spec

- Added `handleHttpGetDoc` handler (spec only mentioned `handleHttpSync` for POST). The GET /:room endpoint logic was also framework-agnostic and worth extracting.
- Removed `roomManager` parameter from `handleWsMessage`: the handler returns `{ broadcast }` and the adapter calls `roomManager.broadcast()` itself. This keeps the handler truly pure (no side effects).
- The `wellcrafted` dependency was dropped from the refactored WS plugin: the original used `trySync` for awareness parsing, replaced with a plain try/catch since it was the only usage.

### Follow-up Work

- Phase 2: Create `@epicenter/server-cloudflare` (Hono + Durable Objects) consuming sync-core
- Open questions 2-6 remain unresolved (deferred to Phase 2 planning)
