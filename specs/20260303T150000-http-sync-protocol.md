# HTTP Sync Protocol

> Add stateless HTTP polling sync alongside the existing WebSocket sync.
> Same CRDT guarantees, no server-side Y.Doc, deployable to stateless targets.

## Status: Implemented

## Motivation

The current sync layer (`packages/sync`, `packages/server/src/sync/`) uses WebSocket connections for Yjs document synchronization. This works but creates architectural constraints:

- **Server must hold Y.Doc in memory** for each active room (the room manager pattern)
- **WebSocket requires Durable Objects on Cloudflare**: stateless Workers can't hold connections
- **Elysia's Cloudflare support is experimental**: WebSocket handling relies on Bun-specific APIs
- **Room lifecycle management** adds complexity (join, leave, eviction timers, connection tracking)

### Why not SSE?

SSE (Server-Sent Events) was considered as a middle ground: HTTP POST for client→server, SSE for server→client. But SSE doesn't actually solve the statefulness problem:

- **SSE requires an in-memory connection map** (`Map<docId, Set<controller>>`) for fan-out: that's server state, same as WebSocket's room manager
- **Cloudflare Workers can't hold SSE connections** (30s execution limit on free, 15min on paid): you'd need Durable Objects anyway, same as WebSocket
- **`EventSource` API doesn't support auth headers**: forces token-in-query-param (leaks to logs/referrer) or abandoning `EventSource` for `fetch()` streaming (loses auto-reconnect, the main SSE selling point)
- **Awareness over HTTP POST feels bad**: each cursor movement is a full round-trip, debounced at 100ms+, noticeably worse than WebSocket broadcast

SSE is an awkward middle ground: it has the connection management complexity of WebSocket without the bidirectional performance. Instead, go to both extremes:

| Deployment | Transport | Tradeoff |
|------------|-----------|----------|
| Stateless (Workers, Lambda, edge) | **HTTP polling** | Higher latency (~250ms avg), zero server state |
| Stateful (Bun server, Durable Objects) | **WebSocket** (existing) | Low latency (~50ms), requires persistent connections |

Both share the same storage layer and the same HTTP endpoints. WebSocket is additive. It's the existing real-time channel layered on top of the HTTP foundation.

## Architecture

### Server never holds a Y.Doc

The server stores opaque binary blobs. It uses three Yjs utility functions: all pure functions that operate on raw `Uint8Array` without instantiating a `Y.Doc`:

| Function | Purpose | Needs Y.Doc? |
|----------|---------|:---:|
| `Y.mergeUpdatesV2(updates[])` | Compact multiple updates into one | No |
| `Y.diffUpdateV2(update, stateVector)` | Compute only what a client is missing | No |
| `Y.encodeStateVectorFromUpdateV2(update)` | Extract state vector from a merged update | No |

This means the server can do **efficient diffing**: not just "send everything and let the client deduplicate." The server merges its stored updates, diffs against the client's state vector, and returns only the missing bytes.

### Endpoints

All endpoints live under the existing `/rooms/:room` namespace. The `:room` parameter is a workspace ID or row GUID.

```
POST   /rooms/:room          Sync (push updates + pull diff)         [required]
WS     /rooms/:room          Real-time sync (awareness + updates)   [required for real-time]
GET    /rooms/:room          Full snapshot (convenience)             [optional sugar]
```

Two endpoints form the protocol. One optional endpoint for convenience.

### `POST /rooms/:room`: the sync endpoint

The single HTTP endpoint for document synchronization. Handles both directions: client pushes updates and pulls missing state: in one round-trip. This is the y-websocket SyncStep1/SyncStep2 exchange compressed into a single HTTP request.

**Request:**
```
Content-Type: application/octet-stream
Authorization: Bearer <token>
Body: <stateVector> [<update>]
```

The body is a concatenation of two length-prefixed binary frames:
1. **State vector** (required): `Y.encodeStateVector(localDoc)`: tells the server what the client has
2. **Update** (optional, zero-length if nothing to push): batched local changes to append to storage

For cold bootstrap (no local state), the client sends an empty state vector and no update. The server returns the full document.

**Response (has updates):**
```
HTTP 200
Content-Type: application/octet-stream
Body: Y.diffUpdateV2(mergedServerState, clientStateVector)
```

**Response (already up to date):**
```
HTTP 304 Not Modified
```

**Server logic:**
1. Parse the request body: extract state vector and optional update
2. If an update is present, append it to storage
3. Read snapshot + all delta updates from storage
4. `Y.mergeUpdatesV2([snapshot, ...deltas])` → `mergedUpdate`
5. `Y.encodeStateVectorFromUpdateV2(mergedUpdate)` → `serverSV`
6. Compare `serverSV` against `clientSV`: if the server has nothing new, return `304`
7. `Y.diffUpdateV2(mergedUpdate, clientStateVector)` → only the missing bytes
8. Return the diff

**Why one endpoint, not two:**

The old design had `POST /rooms/:room` (fire-and-forget push) and `POST /rooms/:room/sync` (pull diff). But every push wants a pull immediately after ("I just pushed, what did I miss?"), and every pull can carry pending updates. Combining them into a single round-trip halves the request count during active editing and eliminates the need for a separate `/sync` path. The server doesn't care whether the update payload is empty. It appends whatever's there (zero is fine), diffs against the state vector, and returns what's missing.

**Why state vectors instead of `?since=version`:**

The state vector *is* the version. It encodes exactly what the client has: per-client-ID clock values. No monotonic counter needed, no sequence gaps to worry about, no "what if the server restarts and loses the counter." The state vector is a Yjs primitive that both sides already maintain. The diff is mathematically precise: zero redundant bytes.

A `?since=` parameter would require the server to maintain an ordered log with version numbers and the client to track its position in that log. State vectors eliminate that bookkeeping entirely.

**Why state vectors are remarkably small:**

A state vector is a map of `clientId → clock` pairs: one entry per unique client that ever edited the document. Each entry is two variable-length integers (~4-10 bytes). The size scales with the **number of unique editors**, not document size or edit count.

| Scenario | Unique clients | State vector size |
|----------|---------------|-------------------|
| Solo user, one device | 1 | ~10 bytes |
| Solo user, multiple devices over months | 10-50 | ~100-500 bytes |
| Team of 5, daily use for a year | 50-200 | ~0.5-2 KB |
| Thousands of editors (Wikipedia-scale) | 5,000 | ~50 KB |

A 10 MB document edited by 3 people has roughly the same state vector (~30-50 bytes) as a 1 KB document edited by 3 people. The state vector is a fixed-cost summary of "what I have," not a log of what happened.

**Comparison: state vectors vs. persistent-connection diffing (OpenAI's approach)**

AI providers like OpenAI face a similar problem: avoid resending redundant data on every API call. Their solution: WebSocket mode for the Responses API, which keeps a persistent connection so the server holds conversation context in memory (the KV cache). The client sends only new inputs; the server appends to its in-memory state and runs inference without reprocessing the full history.

This works, but the server-side "diff state" (the KV cache) is proportional to `sequence_length × num_layers × hidden_dim × 2`: easily gigabytes for long conversations. It's pinned to a specific GPU/process and can't be serialized into a compact portable token. That's why OpenAI *needs* sticky WebSocket connections: no compact representation exists that would let a stateless server reconstruct what computation has already been done.

Yjs state vectors solve the same problem: don't resend what the other side already has. But the diff state is **portable and tiny**. Any stateless server with access to the stored updates can receive a ~100-byte state vector from the client, compute `diffUpdateV2`, and return only the missing bytes. No persistent connection, no in-memory session, no sticky routing. The math is built into the CRDT.

This is why HTTP polling sync is viable for Yjs but not for LLM inference. The state vector makes statelessness free. The "what do you need?" question costs ~100 bytes to ask and answer precisely. For LLMs, that same question requires gigabytes of server-side state to answer, which forces the persistent connection.

### `GET /rooms/:room`: convenience snapshot (optional)

Returns the full document state as a single merged Yjs update. Sugar for cold bootstrap, curl, and browser debugging. Equivalent to `POST /rooms/:room` with an empty state vector and no update. The server returns everything.

**Response:**
```
Content-Type: application/octet-stream
Body: Y.mergeUpdatesV2(allStoredUpdates)
```

Not part of the sync protocol. A client that only uses `POST` never needs this.

### `WS /rooms/:room`: real-time sync (exists)

The existing WebSocket sync: unchanged. Used when low-latency real-time collaboration and awareness are needed (stateful deployments with Bun, Durable Objects, etc.).

WebSocket provides:
- Real-time update fan-out (no polling delay)
- Awareness (cursors, presence, "who's online")
- The existing y-websocket protocol (SyncStep1/2, awareness, heartbeat)

The same server can offer both HTTP polling and WebSocket simultaneously. A client chooses based on its needs:
- Desktop app on local server → WebSocket (always available, low latency)
- Web app on managed hosting → HTTP polling (works on any serverless platform)
- Web app on Durable Objects → WebSocket (has persistent connections)

## Client-Side Provider

### HTTP Polling Provider

```typescript
type HttpSyncProviderConfig = {
  doc: Y.Doc;
  url: string;          // e.g., "https://api.example.com/rooms/my-workspace"
  getToken?: () => Promise<string>;
  /** Polling interval in ms. Default: 2000. */
  pollInterval?: number;
};

type HttpSyncProvider = {
  connect(): Promise<void>;
  disconnect(): void;
  destroy(): void;
  /** Trigger an immediate poll (e.g., after user action, tab focus). */
  poll(): Promise<void>;

  readonly status: 'offline' | 'connected' | 'error';
  readonly hasLocalChanges: boolean;
};
```

**Three states, not five.** No `connecting` or `handshaking`: there's no persistent connection to establish. Either the last poll worked (`connected`), it didn't (`error`), or you haven't started (`offline`).

### Connection Lifecycle

```
1. connect() called
2. POST /rooms/:room with state vector (no update) → apply returned diff to local doc
3. Start poll timer (setInterval)
4. Attach doc.on('update', handler):
   → on local update: buffer into pending batch
   → on flush (50ms): POST /rooms/:room with state vector + batched update
   → apply returned diff to local doc
5. On poll timer tick: POST /rooms/:room with state vector (no update)
6. On disconnect(): clear timer, detach update handler
```

Every request: whether pushing edits or just polling: goes to the same `POST /rooms/:room` endpoint. The only difference is whether the update frame is empty.

### Adaptive Polling

Instead of a fixed interval, adjust based on activity:

```typescript
let interval = config.pollInterval ?? 2000;

async function adaptivePoll() {
  const { status } = await poll(); // 200 = had updates, 304 = no change
  if (status === 200) {
    // Active collaboration: poll faster
    interval = Math.max(500, interval * 0.5);
  } else {
    // Idle: back off
    interval = Math.min(interval * 1.5, 10_000);
  }
  timer = setTimeout(adaptivePoll, interval);
}
```

Range: 500ms (active) to 10s (idle). Converges to long intervals when nobody's editing, snaps to fast polling when updates are flowing.

### Additional Poll Triggers

Beyond the timer, sync immediately on:
- **`document.visibilitychange`**: user switches back to tab
- **`navigator.onLine`**: device comes back online
- **User-initiated refresh**: expose `provider.poll()` for a manual sync button

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') provider.poll();
});

window.addEventListener('online', () => provider.poll());
```

### Batching Outbound Updates

For rapid typing (10-100 updates/sec), batch before syncing:

```typescript
let pending: Uint8Array[] = [];
let flushTimer: Timer | null = null;

doc.on('update', (update, origin) => {
  if (origin === 'remote') return;
  pending.push(update);
  flushTimer ??= setTimeout(flush, 50); // 50ms batch window
});

function flush() {
  flushTimer = null;
  const merged = Y.mergeUpdatesV2(pending);
  pending = [];
  sync(merged); // single POST: pushes edits + pulls diff in one round-trip
}
```

Reduces HTTP requests from ~100/sec to ~20/sec during active typing with at most 50ms added latency. Each flush is a single round-trip that both pushes and pulls, no separate "post then poll" dance.

### hasLocalChanges Tracking

Simpler than the WebSocket provider's version-counter approach:

```typescript
let pendingSyncs = 0;

doc.on('update', (update, origin) => {
  if (origin === 'remote') return;
  pendingSyncs++;
  // decremented when the batched flush completes successfully
});

get hasLocalChanges() { return pendingSyncs > 0 || pending.length > 0; }
```

## Storage Layer

### Interface

```typescript
interface SyncStorage {
  /** Append an update. */
  appendUpdate(docId: string, update: Uint8Array): Promise<void>;

  /** Read all stored updates (snapshot + deltas). */
  getAllUpdates(docId: string): Promise<Uint8Array[]>;

  /** Replace all updates with a single compacted snapshot. */
  compact(docId: string, mergedUpdate: Uint8Array): Promise<void>;
}
```

No version counters. No `getUpdatesSince`. The state vector handles versioning. The storage is just a blob store.

### Compaction

Periodically merge all stored updates into a single snapshot:

```typescript
async function compactDoc(storage: SyncStorage, docId: string) {
  const updates = await storage.getAllUpdates(docId);
  if (updates.length <= 1) return; // already compact
  const merged = Y.mergeUpdatesV2(updates);
  await storage.compact(docId, merged);
}
```

Compaction keeps `getAllUpdates` fast and `diffUpdateV2` efficient. Can be triggered by a cron job, after N updates accumulate, or on-demand via an admin endpoint.

`Y.mergeUpdatesV2` is a pure function, no Y.Doc instantiated. The server only needs `yjs` as a dependency for this one function (plus `diffUpdateV2` and `encodeStateVectorFromUpdateV2`).

### Implementations

**SQLite (Tauri sidecar, self-hosted):**
```sql
CREATE TABLE sync_updates (
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
```

`compact()` = delete all rows for doc, insert one row with `seq = 0`.

**Cloudflare KV:**
- Updates: `sync:{docId}:{seq}` → binary value
- List keys with prefix `sync:{docId}:` to get all updates

**Filesystem:**
- Updates: `{dataDir}/{docId}/{seq}.bin`
- `compact()` = delete all files, write `0.bin`

## Topology

### Workspace Y.Doc

```
docId = workspaceId
Updates: structural changes (add row, update field, reorder, delete)
Frequency: 1-10 updates/minute
Poll interval: 2-5s (adaptive)
```

### Content Y.Docs (per-row documents)

```
docId = row GUID
Updates: character-level text edits
Frequency: 10-100 updates/sec during typing, 0 when idle
Poll interval: 500ms-2s (adaptive), only while document is open
```

### Request Count per Client

With HTTP polling (unified POST endpoint):
- 1 sync every 2-10s for the workspace doc
- 0-N syncs every 0.5-2s for open content docs
- Local changes are included in the next sync (batched at 50ms, then sent with the state vector)

Each request is a single round-trip that pushes and pulls simultaneously. A user with one workspace and two open documents ≈ 1-3 requests/second during active editing, ~0.3 requests/second when idle. Well within any rate limit.

## Awareness

Awareness (cursors, presence) is **not supported** over HTTP polling. It requires real-time bidirectional streaming, that's what WebSocket is for.

If a deployment supports WebSocket (local Bun server, Durable Objects), awareness works through the existing WebSocket channel. If deployed to stateless targets (Workers, Lambda), awareness is unavailable. This is an acceptable tradeoff: stateless deployments are typically for personal sync (single user, multiple devices), not real-time collaboration.

For deployments that need presence on stateless targets in the future, a separate lightweight WebSocket or WebRTC channel for awareness-only traffic can be added without changing the document sync protocol.

## Transport Selection

```typescript
// The extension chooses transport based on what the server supports
createSyncExtension({
  transport: 'http',    // HTTP polling: works everywhere
  // or
  transport: 'ws',      // WebSocket: existing behavior, real-time + awareness
  // or
  transport: 'auto',    // Try WebSocket, fall back to HTTP polling
})
```

Both transports use the same underlying HTTP endpoints for initial sync. WebSocket adds a persistent connection on top for real-time fan-out and awareness.

## Server Implementation: Two Composable Plugins

The server side is split into two independent Elysia plugins. Each is self-contained and can be used alone or together.

### Plugin 1: `createHttpSyncPlugin(storage)`: Stateless HTTP

Handles document sync over plain HTTP. No room manager, no connection tracking, no in-memory state. Every request reads from storage, computes, responds.

```typescript
function createHttpSyncPlugin(storage: SyncStorage) {
  return new Elysia()
    .post('/:room', async ({ params, request }) => {
      // Unified sync: push updates + pull diff in one round-trip
      const body = new Uint8Array(await request.arrayBuffer());
      const { stateVector: clientSV, update } = decodeSyncRequest(body);

      // 1. Append client's update (if present)
      if (update.byteLength > 0) {
        await storage.appendUpdate(params.room, update);
      }

      // 2. Compute diff
      const updates = await storage.getAllUpdates(params.room);
      if (updates.length === 0) return new Response(null, { status: 304 });

      const merged = Y.mergeUpdatesV2(updates);
      const serverSV = Y.encodeStateVectorFromUpdateV2(merged);

      // 3. Nothing new? 304.
      if (stateVectorsEqual(serverSV, clientSV)) {
        return new Response(null, { status: 304 });
      }

      // 4. Return only what the client is missing
      const diff = Y.diffUpdateV2(merged, clientSV);
      return new Response(diff, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    })
    .get('/:room', async ({ params }) => {
      // Optional convenience: full snapshot for curl/browser/cold bootstrap
      const updates = await storage.getAllUpdates(params.room);
      if (updates.length === 0) return new Response(null, { status: 404 });
      const merged = Y.mergeUpdatesV2(updates);
      return new Response(merged, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
}
```

**Endpoints provided:** `POST /:room` (required), `GET /:room` (optional convenience)

**Dependencies:** `SyncStorage` implementation, `yjs` (for `mergeUpdatesV2`, `diffUpdateV2`, `encodeStateVectorFromUpdateV2`)

**Deploys to:** Anything. Cloudflare Workers, Lambda, Bun, Node, Deno.

### Plugin 2: `createWsSyncPlugin({ getDoc })`: Stateful WebSocket

The existing WebSocket sync: renamed from `createSyncPlugin` for clarity. Handles real-time update fan-out and awareness via persistent connections. Requires a long-running process.

```typescript
function createWsSyncPlugin({ getDoc }: { getDoc: (roomId: string) => Y.Doc | undefined }) {
  const roomManager = createRoomManager({ getDoc });
  return new Elysia()
    .ws('/:room', {
      // ... existing WebSocket handler (unchanged)
      // SyncStep1/2, awareness, heartbeat, room join/leave
    });
}
```

**Endpoints provided:** `WS /:room`

**Dependencies:** `yjs`, `y-protocols`, room manager (in-memory state)

**Deploys to:** Bun server, Durable Objects: anything with persistent connections.

### Refactoring the existing `createSyncPlugin`

The current `createSyncPlugin` bundles both HTTP endpoints (GET/POST `/:room`) and WebSocket (`WS /:room`) in one plugin. The refactoring is:

1. Extract the POST handler into `createHttpSyncPlugin`: unified sync endpoint backed by `SyncStorage` instead of in-memory Y.Doc, plus optional GET for convenience
2. Extract the WebSocket handler into `createWsSyncPlugin`: keeps the room manager
3. Delete the old `createSyncPlugin`

The existing HTTP endpoints operate on in-memory Y.Docs via the room manager. The new HTTP plugin operates on storage blobs via `SyncStorage`. Same CRDT math, different backend.

### Composition

```typescript
// Stateless deployment (Workers, Lambda)
// HTTP polling only: no awareness, no real-time fan-out
const app = new Elysia({ prefix: '/rooms' })
  .use(createHttpSyncPlugin(storage));

// Stateful deployment (local Bun server)
// Both plugins: HTTP for polling clients, WS for real-time clients
const app = new Elysia({ prefix: '/rooms' })
  .use(createHttpSyncPlugin(storage))
  .use(createWsSyncPlugin({ getDoc }));

// Stateful deployment, WebSocket only (current behavior, backwards compat)
const app = new Elysia({ prefix: '/rooms' })
  .use(createWsSyncPlugin({ getDoc }));
```

A client connecting via HTTP polling talks to plugin 1. A client connecting via WebSocket talks to plugin 2. Both can coexist on the same server because their routes don't overlap (HTTP GET/POST vs WS upgrade on the same path is fine: Elysia/Bun handles this).

### Shared storage concern

When both plugins are active, they need to share storage so that updates posted via HTTP are visible to WebSocket clients and vice versa. Two approaches:

**Option A: Storage as source of truth:** The WebSocket plugin reads from `SyncStorage` on join and writes to it on update. The room manager becomes a cache/fan-out layer on top of storage. This is the cleaner long-term architecture.

**Option B: Write-through:** HTTP POST writes to both storage and the in-memory Y.Doc (via room manager). Simpler to implement initially but couples the plugins.

Option A is recommended. The room manager loads from storage on room creation and flushes to storage on update. Both plugins read/write the same `SyncStorage`.

## Migration from Current WebSocket Sync

### What changes

| Component | Current | New |
|-----------|---------|-----|
| `packages/server/src/sync/plugin.ts` | `createSyncPlugin` (WS + room manager + HTTP, all-in-one) | Split into `createHttpSyncPlugin` + `createWsSyncPlugin` |
| `packages/server/src/sync/rooms.ts` | Room manager with in-memory Y.Docs | Room manager backed by `SyncStorage` |
| `packages/sync/` | `createSyncProvider` (WebSocket supervisor loop) | Add `createHttpSyncProvider` (fetch + timer) alongside |
| `packages/epicenter/src/extensions/sync.ts` | Creates WebSocket sync provider | Accept `transport: 'ws' \| 'http' \| 'auto'` option |

### What stays the same

- WebSocket sync behavior is unchanged: just refactored into its own plugin
- Workspace definition system, extension system, persistence, client API
- y-websocket wire protocol (SyncStep1/2, awareness, heartbeat)

### Implementation Order

1. [x] **`SyncStorage` interface + in-memory implementation**: the storage foundation
   > Implemented in `packages/server/src/sync/storage.ts`. Includes `SyncStorage` interface, `encodeSyncRequest`/`decodeSyncRequest` binary framing, `stateVectorsEqual` utility, and `createMemorySyncStorage` factory. SQLite implementation deferred to when needed.
2. [x] **`createHttpSyncPlugin(storage)`**: unified POST endpoint + optional GET, backed by `SyncStorage`
   > Implemented in `packages/server/src/sync/http-sync-plugin.ts`. Completely stateless: no Y.Doc, no room manager. Uses Elysia's `set.headers` pattern for binary responses.
3. [x] **`createWsSyncPlugin({ getDoc })`**: extract WS handler from existing plugin
   > Implemented in `packages/server/src/sync/ws-sync-plugin.ts`. Exact extraction of WS handler from plugin.ts. Includes GET `/` for room listing.
4. [ ] **Wire room manager to `SyncStorage`**: reads from storage on join, writes on update
   > Deferred: server-local and server-remote now use createWsSyncPlugin (same behavior). HTTP plugin wiring deferred until client HTTP provider is ready.
5. [x] **`createHttpSyncProvider`**: client-side fetch + poll timer
   > Implemented in `packages/sync/src/http-provider.ts` (~290 lines). V2 encoding throughout, adaptive polling (500ms-10s), 50ms update batching, visibility/online triggers, syncing guard against overlapping requests.
6. [x] **Two sync extensions**: `createWsSyncExtension` (rename existing) + `createHttpSyncExtension` (new)
   > Changed from single extension with `transport` option to two separate extensions for type safety.
   > `createWsSyncExtension` in `sync.ts` (renamed, deprecated aliases kept). `createHttpSyncExtension` in `http-sync.ts` (new, wraps HTTP provider, no awareness, includes pollInterval config).
7. [x] **Compaction**: `compactDoc()` utility using `Y.mergeUpdatesV2`
   > Implemented in `packages/server/src/sync/storage.ts`. Pure function, no Y.Doc. Exported from `@epicenter/server/sync`.
8. [ ] **Cloudflare Worker deployment**: `createHttpSyncPlugin` + KV storage backend
   > Deferred: requires KV SyncStorage implementation and Cloudflare Worker setup.

## Review

**Completed**: 2026-03-04
**Branch**: `braden-w/server-pkg-overview-v1`

### Summary

Implemented stateless HTTP polling sync alongside the existing WebSocket sync. The server stores opaque binary blobs and uses pure Yjs utility functions (no Y.Doc instantiation) to compute diffs. Two composable Elysia plugins (`createHttpSyncPlugin` + `createWsSyncPlugin`), a client-side HTTP polling provider with adaptive intervals, and two separate sync extensions for precise typing.

### Deviations from Spec

- **Two extensions instead of one**: The spec proposed a single `createSyncExtension` with a `transport: 'ws' | 'http' | 'auto'` option. Implemented as two separate extensions (`createWsSyncExtension` + `createHttpSyncExtension`) for precise types: no optional awareness, no runtime branching.
- **SQLite SyncStorage deferred**: Only the in-memory implementation was built. SQLite implementation will be added when needed for persistent local server storage.
- **Room manager not wired to SyncStorage**: The WS plugin continues using its existing `getDoc` pattern. Shared storage between HTTP and WS plugins (Option A from spec) deferred until both plugins are mounted on the same server.
- **Cloudflare deployment deferred**: Requires a KV-backed SyncStorage implementation.

### Follow-up Work

- SQLite `SyncStorage` implementation for `server-local` persistent storage
- Wire `createHttpSyncPlugin` into `server-remote` for stateless deployment
- Shared storage between HTTP and WS plugins when both are active
- Cloudflare Worker deployment with KV storage backend
- Compaction scheduling (cron, update count threshold, or admin endpoint)
