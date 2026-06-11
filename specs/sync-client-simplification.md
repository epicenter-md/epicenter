# Sync Client Simplification: Implemented

> Drop SYNC_STATUS (102), use Cloudflare auto-response for liveness, simplify to 3-state status model.

## Problem

The sync provider (`packages/sync-client/src/provider.ts`) has ~745 lines with 11 closure state variables and 7 interacting mechanisms (heartbeat, connection timeout, ack tracking, liveness detection, reconnection, status management, browser events). Several of these exist to power `hasLocalChanges` / `onLocalChanges`: a feature with **zero consumers** across all apps.

The heartbeat/ack system also has concrete bugs:
- **Idle liveness gap:** When `ackedVersion === localVersion` (clean), the heartbeat probe is skipped. A silently-dead idle connection is never detected.
- **False ack on reconnect:** `localVersion`/`ackedVersion` are not reset on reconnect. The first SYNC_STATUS echo marks everything as acked: even updates lost on the dead connection.
- **Ack doesn't prove persistence:** The server echoes SYNC_STATUS in the same handler that processes updates, before confirming SQLite write success.

## Key Constraints (from research)

### Cloudflare Durable Objects
- `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` responds to **text** `"ping"` with `"pong"` **at the edge, without waking the DO**. Already configured in the constructor.
- Messages matching the auto-response pair are handled at the edge without waking the DO. All other messages (binary or non-matching text) wake the DO. Since auto-response only matches text strings, binary messages inherently always wake the DO.
- No documented idle timeout specifically for DO WebSocket connections. The ~100s CDN proxy read timeout is widely reported in community forums but not officially documented for DO WebSockets. The 400s figure is the HTTP keep-alive timeout from Cloudflare's connection limits docs, not TCP keepalive: unclear if it applies to WebSocket connections through DOs.
- On DO crash: client gets close code 1006. With hibernation (which we use), eviction does NOT close WebSocket connections: they survive on Cloudflare's network. Without hibernation, eviction after 70-140s of inactivity terminates connections. On code deploy: all WebSocket connections are terminated immediately.
- Max idle time without app-level heartbeats: uncertain and undocumented. **Must send heartbeats.**
- **Local dev caveat:** `setWebSocketAutoResponse` has known bugs in `workerd` ([#1009](https://github.com/cloudflare/workerd/issues/1009), [#1259](https://github.com/cloudflare/workerd/issues/1259)). Tests relying on auto-response behavior may not work in local development.

### Browser WebSocket API
- **Cannot** send or observe protocol-level ping/pong frames. Only application-level messages.
- `readyState` can show `OPEN` on a dead connection for **minutes to hours** (half-open TCP).
- TCP keepalive is disabled by default on most OSes (2-hour default when enabled).
- Chrome throttles background tab timers to once per minute after 5 minutes. After prolonged background time, may fully suspend JS execution.
- Mobile browsers (iOS/Android) suspend JS on screen lock. WebSocket stays TCP-alive but heartbeat timers stop.

### Tauri Desktop
- macOS: `backgroundThrottlingPolicy` can be set to `"throttle"` or `"none"` to keep timers running when minimized.
- Windows/Linux: no equivalent API currently exposed in Tauri.

### y-websocket Reference Implementation
- Solves idle liveness by having the **server echo awareness updates back to the sender** every ~15s. Our server filters these out (`otherWs !== ws`), so this trick doesn't work for us.
- Uses a 45s `socketTimeout` (no message received → close) with a 4s check interval.
- Had a historical bug where removing local awareness state on disconnect broke the heartbeat cycle (fixed in 1.3.8).

## Architecture: Auto-Response Heartbeat

Use the Cloudflare auto-response mechanism that's already configured for zero-cost liveness detection. Drop the custom SYNC_STATUS message type entirely.

```
                    Client                          CF Edge                    DO
                      │                               │                        │
  (idle, every 30s)   │──── text "ping" ─────────────▶│                        │ (sleeping)
                      │◀─── text "pong" ──────────────│  auto-response,        │ (still sleeping)
                      │     resets liveness timer      │  never wakes DO        │
                      │                               │                        │
  (user types)        │──── binary sync update ──────▶│───────────────────────▶│ (wakes, persists)
                      │◀─── binary sync step2 ────────│◀──────────────────────│ (broadcasts)
                      │     resets liveness timer      │                        │
                      │                               │                        │
  (45s, no message)   │  liveness timer fires          │                        │
                      │  close socket, reconnect       │                        │
```

### What changes

| Removed | Replacement |
|---|---|
| `localVersion`, `ackedVersion` | Nothing (add back when UI needs it) |
| `incrementLocalVersion()`, `updateAckedVersion()` | Nothing |
| `emitLocalChanges()`, `localChangesListeners` | Nothing |
| `sendSyncStatus()`, `armConnectionTimeout()` | Text `"ping"` every 30s + liveness timer |
| `heartbeatHandle`, `connectionTimeoutHandle` | `pingInterval` + `livenessHandle` (scoped inside `attemptConnection`) |
| `clearHeartbeat()`, `clearConnectionTimeout()`, `resetHeartbeat()` | Inline in `attemptConnection` |
| `MESSAGE_TYPE.SYNC_STATUS` handler in `onmessage` | Handle text `"pong"` (just reset timer) |
| `onLocalChanges()` on public API | Nothing |
| `hasLocalChanges` getter | Nothing |
| 5-state status: `offline\|connecting\|handshaking\|connected\|error` | 3-state: `offline\|connecting\|connected` |
| Server `SYNC_STATUS` echo in `sync-handlers.ts` | Nothing |

### Closure state (11 → 7)

```typescript
let desired: 'online' | 'offline' = 'offline';
let status: SyncStatus = 'offline';          // 3 states now
let runId = 0;
let connectRun: Promise<void> | null = null;
let retries = 0;
let websocket: WebSocketLike | null = null;
let reconnectSleeper: Sleeper | null = null;
```

Removed: `localVersion`, `ackedVersion`, `heartbeatHandle`, `connectionTimeoutHandle`.

## Detailed Design

### 1. Liveness detection via text ping/pong

Inside `attemptConnection`, after `onopen`:

```typescript
// Liveness state (scoped to this connection attempt)
let lastMessageTime = Date.now();
const PING_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 45_000;

// Send text "ping" every 30s: CF auto-response echoes "pong" without waking DO
const pingInterval = setInterval(() => {
    if (ws.readyState === WS.OPEN) ws.send('ping');
}, PING_INTERVAL_MS);

// Check liveness every 10s: uses wall clock, robust against timer throttling
const livenessInterval = setInterval(() => {
    if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
        ws.close();
    }
}, 10_000);
```

In `onmessage`:
```typescript
ws.onmessage = (event: MessageEvent) => {
    lastMessageTime = Date.now();

    // Text "pong" from auto-response: liveness confirmed, nothing else to do
    if (typeof event.data === 'string') return;

    // Binary messages: existing sync protocol decode
    const data = new Uint8Array(event.data);
    // ...
};
```

In `onclose`:
```typescript
clearInterval(pingInterval);
clearInterval(livenessInterval);
```

**Why `setInterval` + wall clock instead of `setTimeout` chains:** Background tab throttling delays timer callbacks, but `Date.now()` always returns the real wall clock time. A throttled check at 60s still correctly compares against the 45s threshold. If the connection died while backgrounded, the first check after the tab resumes will detect it.

### 2. Simplified `handleDocUpdate`

```typescript
function handleDocUpdate(update: Uint8Array, origin: unknown) {
    if (origin === SYNC_ORIGIN) return;
    send(encodeSyncUpdate({ update }));
}
```

No `incrementLocalVersion()`. No `sendSyncStatus()`. Just send the update.

### 3. Browser event handlers

```typescript
function handleOnline() {
    reconnectSleeper?.wake();
}

function handleOffline() {
    // Trust the event: close and let the supervisor loop reconnect.
    // False positives (e.g., WiFi drops but Ethernet stays) cause a cheap
    // reconnect: new WebSocket, sync handshake, empty diff.
    websocket?.close();
}
```

### 4. `visibilitychange` handler

Add `visibilitychange` alongside the existing `online`/`offline` listeners:

```typescript
function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;

    // Tab just became visible. Timer callbacks may have been throttled,
    // so check wall clock directly: if the connection looks stale, close it.
    // If alive, send an immediate ping to verify.
    if (websocket?.readyState === WS.OPEN) {
        websocket.send('ping');
    }
}
```

The ping triggers a "pong" response. If the connection is dead, the liveness interval will detect the stale `lastMessageTime` on its next tick and close the socket.

### 5. Three-state status model

```typescript
type SyncStatus = 'offline' | 'connecting' | 'connected';
```

- `'offline'`: not trying to connect
- `'connecting'`: supervisor loop active, socket not yet synced
- `'connected'`: sync handshake complete

`'handshaking'` merges into `'connecting'`: the UI shows the same spinner for both. `'error'` merges into `'connecting'`: the supervisor loop is still running and will retry.

### 6. Handshake detection

The current handshake detection logic stays the same. When we receive `SYNC_MESSAGE_TYPE.STEP2` or `SYNC_MESSAGE_TYPE.UPDATE` during the handshake phase, the connection is considered synced and status transitions to `'connected'`. The `handshakeComplete` boolean is scoped inside `attemptConnection` (already the case).

### 7. Server-side cleanup

Remove the `MESSAGE_TYPE.SYNC_STATUS` case from `sync-handlers.ts`:

```typescript
// Before:
case MESSAGE_TYPE.SYNC_STATUS: {
    const payload = decoding.readVarUint8Array(decoder);
    return { response: encodeSyncStatus({ payload }) };
}

// After: delete this case entirely
```

The `MESSAGE_TYPE.SYNC_STATUS = 102` constant can stay in `protocol.ts` for now (it's just a number), or be removed if nothing else references it. The `encodeSyncStatus` function should be removed.

### 8. WebSocketLike type update

The `WebSocketLike` interface needs to support `send(data: string)` for text ping:

```typescript
export type WebSocketLike = {
    // ...existing...
    send(data: ArrayBufferLike | Uint8Array | string): void;  // add string
    // ...
};
```

### 9. Public API changes

```typescript
export type SyncProvider = {
    readonly status: SyncStatus;          // 3 states now
    readonly awareness: Awareness;
    connect(): void;
    disconnect(): void;
    onStatusChange(listener: (status: SyncStatus) => void): () => void;
    destroy(): void;
};
```

Removed: `hasLocalChanges`, `onLocalChanges()`. These are re-added when the "Saving.../Saved" UI is built: at which point we design a proper persistence-confirmed ack (server sends ack after SQLite write, not an echo of client bytes).

### 10. `destroy()` calls `disconnect()`

DRY up the overlap:

```typescript
destroy() {
    this.disconnect();    // sets offline, bumps runId, wakes sleeper, closes socket
    doc.off('updateV2', handleDocUpdate);
    awareness.off('update', handleAwarenessUpdate);
    removeAwarenessStates(awareness, [doc.clientID], 'window unload');
    statusListeners.clear();
}
```

`disconnect()` already handles: `desired = 'offline'`, `runId++`, `reconnectSleeper?.wake()`, `websocket?.close()`, `setStatus('offline')`, `removeWindowListeners()`.

## Implementation Plan

### Wave 1: Client provider simplification
**Files:** `packages/sync-client/src/provider.ts`, `packages/sync-client/src/types.ts`

- [x] **1.1** Remove `localVersion`, `ackedVersion`, `heartbeatHandle`, `connectionTimeoutHandle` state vars
- [x] **1.2** Remove `incrementLocalVersion`, `updateAckedVersion`, `emitLocalChanges`, `localChangesListeners`
- [x] **1.3** Remove `sendSyncStatus`, `armConnectionTimeout`, `clearConnectionTimeout`, `resetHeartbeat`, `clearHeartbeat`
- [x] **1.4** Simplify `handleDocUpdate`: just send the update
- [x] **1.5** Simplify `handleOffline`: just close the websocket
- [x] **1.6** Add text ping interval + wall-clock liveness check inside `attemptConnection`
- [x] **1.7** Handle text `"pong"` in `onmessage` (reset timer, return early)
- [x] **1.8** Add `visibilitychange` listener alongside `online`/`offline`
- [x] **1.9** Collapse status to 3 states; remove `'handshaking'` and `'error'` transitions
- [x] **1.10** DRY `destroy()` by calling `disconnect()` internally
- [x] **1.11** Update `SyncProvider` type: remove `hasLocalChanges`, `onLocalChanges`
- [x] **1.12** Update `WebSocketLike` type: add `string` to `send()` parameter
- [x] **1.13** Update `SyncStatus` type: 3 states

### Wave 2: Server-side cleanup
**Files:** `packages/server-remote/src/sync-handlers.ts`, `packages/sync-server/src/handlers.ts`, `packages/sync/src/protocol.ts`, `packages/sync/src/index.ts`

- [x] **2.1** Remove `MESSAGE_TYPE.SYNC_STATUS` case from CF `handleWsMessage`
- [x] **2.2** Remove `MESSAGE_TYPE.SYNC_STATUS` case from generic `handleWsMessage`
  > **Note**: Spec only listed the CF handler, but `sync-server/handlers.ts` had identical SYNC_STATUS handling.
- [x] **2.3** Remove `encodeSyncStatus` and `decodeSyncStatus` from `protocol.ts`
- [x] **2.4** Remove `encodeSyncStatus` and `decodeSyncStatus` from `index.ts` exports
- [x] **2.5** Keep `MESSAGE_TYPE.SYNC_STATUS = 102` constant for future ack protocol

### Wave 3: Test updates
**Files:** `packages/sync-client/src/provider.test.ts`

- [x] **3.1** Remove `hasLocalChanges` / `onLocalChanges` tests
- [x] **3.2** Remove SYNC_STATUS message construction helpers
- [x] **3.3** Update status transition tests (3 states, no `'handshaking'` or `'error'`)
- [x] **3.4** Update protocol.test.ts: remove MESSAGE_SYNC_STATUS describe block, encodeSyncStatus/decodeSyncStatus imports
- [x] **3.5** Update sync-server handlers.test.ts: replace SYNC_STATUS echo test with silent-ignore test
- [ ] **3.6** Add liveness detection tests (text ping/pong, liveness timeout): deferred to follow-up
- [ ] **3.7** Add `visibilitychange` handling tests: deferred to follow-up
- [ ] **3.8** Add `handleOffline` → close behavior test: deferred to follow-up

### Wave 4: Extension + consumer updates
**Files:** `packages/epicenter/src/extensions/sync.ts`, any consumers

- [x] **4.1** Update any references to removed `SyncStatus` values: none found in consumers
- [x] **4.2** Update any references to `hasLocalChanges` / `onLocalChanges`: only README reference, updated

## Future: Adding Ack Tracking Back

When the "Saving.../Saved" UI is built, design a proper persistence-confirmed ack:

1. Server sends ack **after** the SQLite write succeeds, not as an echo of client bytes
2. Ack payload includes the server's state vector hash (or equivalent), so the client knows exactly what the server has persisted
3. The ack message type can reuse tag 102 or use a new tag
4. Deploy server first (adds handler), then client (starts sending): the server's `default` case silently ignores unknown tags, so no coordination needed
5. Add `hasLocalChanges` and `onLocalChanges` back to the provider API

## Review

**Completed**: 2026-03-09
**Branch**: `braden-w/tab-mgr-sync-upgrade`

### Summary

Replaced the SYNC_STATUS (102) heartbeat/ack system with text ping/pong liveness detection using Cloudflare's `setWebSocketAutoResponse`. Provider reduced from ~745 to ~715 lines, closure state from 11 to 7 variables, status model from 5 to 3 states. Removed `hasLocalChanges`/`onLocalChanges` (zero consumers). Server-side SYNC_STATUS echo removed from both CF Durable Object and generic sync-server handlers.

### Deviations from Spec

- `sync-server/handlers.ts` was also cleaned up (spec only listed the CF handler): it had identical SYNC_STATUS handling
- `encodeSyncStatus`/`decodeSyncStatus` removed from protocol (spec said "remove encodeSyncStatus", decodeSyncStatus was also cleaned up)
- `MESSAGE_TYPE.SYNC_STATUS = 102` constant kept for future ack protocol (spec said "optionally remove")
- New liveness/visibility/offline behavior tests (spec items 3.6-3.8) deferred to follow-up

### Follow-up Work

- Add test coverage for text ping/pong liveness detection, visibilitychange handler, and handleOffline → close behavior
- Design and implement persistence-confirmed ack for "Saving.../Saved" UI (see Future section above)
