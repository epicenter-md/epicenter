# Disconnect/Reconnect Race: First-Principles Redesign

**Date**: 2026-02-13
**Status**: Complete (Superseded)
**Implementation notes**: The entire `YSweetProvider` was deleted as part of the migration to `@epicenter/sync` (PR #1350). The new `createSyncProvider()` uses a supervisor loop architecture that eliminates the race conditions analyzed here by design. Option B (supervisor loop redesign) was effectively implemented: just in a new package rather than as a refactor of the old one. All issues identified in this spec (generation counter races, listener leaks, reconnect state machine gaps) no longer exist.

## What This Document Is

A first-principles analysis of the disconnect/reconnect race condition in `YSweetProvider`. Instead of patching the current architecture, this document inventories every moving part, diagnoses the structural causes of the race, and proposes how to reassemble them cleanly.

---

## Part 1: Inventory of Moving Parts

### The Cast of Characters

There are **7 distinct subsystems** involved in the connection lifecycle. They interact through shared mutable state and side effects.

#### 1. The Connect Loop (`connect()`)

An `async` method that runs a retry loop with exponential backoff. It fetches an auth token, opens a WebSocket, and retries on failure.

```
Entry: connect()
Guard: isConnecting boolean (prevents concurrent loops)
Loop:  while (status not OFFLINE/CONNECTED) → get token → try connect → backoff → repeat
Exit:  isConnecting = false
```

**State it touches**: `isConnecting`, `status`, `clientToken`, `retries`, `reconnectSleeper`, `websocket`

#### 2. The Disconnect Method (`disconnect()`)

Synchronous. Sets status to OFFLINE, closes the socket, bumps a generation counter.

```
Entry: disconnect()
Actions: connectGeneration++, setStatus(OFFLINE), wake sleeper, close socket
```

**State it touches**: `connectGeneration`, `status`, `reconnectSleeper`, `websocket`

#### 3. The WebSocket Event Handlers (`websocketOpen`, `websocketClose`, `websocketError`)

Callbacks bound to the WebSocket instance. They set status, trigger reconnection, and manage timers.

```
websocketOpen   → setStatus(HANDSHAKING), send sync step 1, start heartbeat
websocketClose  → clear timers, [if not OFFLINE] setStatus(ERROR) + connect(), clean awareness
websocketError  → clear timers, [if not OFFLINE] setStatus(ERROR) + connect()
```

**State they touch**: `status`, `heartbeatHandle`, `connectionTimeoutHandle`, `awareness`

#### 4. The Heartbeat/Timeout System

Two timers that probe connection liveness:

```
resetHeartbeat()        → after 2s of silence, send MESSAGE_SYNC_STATUS
setConnectionTimeout()  → after 3s without response, close socket + setStatus(ERROR) + connect()
```

**State they touch**: `heartbeatHandle`, `connectionTimeoutHandle`, `status`, `websocket`

#### 5. The Sleeper (Cancellable Backoff)

A `Promise.withResolvers` + `setTimeout` combo. The connect loop `await`s it. Can be woken early by `disconnect()` or the browser `online` event.

```
createSleeper(timeout) → { promise, wake }
```

**State it touches**: `reconnectSleeper` (set by connect loop, read/woken by disconnect and online)

#### 6. The Status/Event System

A simple pub/sub. `setStatus()` writes `this.status` and emits to listeners.

```
setStatus(status) → if changed, write + emit EVENT_CONNECTION_STATUS
```

**Consumers**: The connect loop (reads `status` in while condition), `waitForFirstSync()`, UI components, the websocketClose/Error guards.

#### 7. The Generation Counter

A monotonic integer. `disconnect()` bumps it. The connect loop captures it at entry and checks it before each retry.

```
disconnect() → connectGeneration++
connect()    → const myGeneration = connectGeneration; while (myGeneration === connectGeneration) { ... }
```

**Purpose**: Cancel stale connect loops after explicit disconnect.

---

### Interaction Map

Here's how these 7 subsystems interact. Arrows show "calls into" or "mutates state read by":

```
                    ┌──────────────────────────────────────────────┐
                    │              Shared Mutable State             │
                    │                                              │
                    │  status          isConnecting                │
                    │  connectGeneration   retries                 │
                    │  clientToken     reconnectSleeper            │
                    │  websocket       heartbeatHandle             │
                    │  connectionTimeoutHandle                     │
                    └──────┬───────────────────────┬───────────────┘
                           │                       │
           ┌───────────────┼───────────────────────┼───────────────┐
           │               │                       │               │
     ┌─────▼─────┐   ┌────▼──────┐   ┌───────────▼──┐   ┌───────▼────────┐
     │  connect() │   │disconnect()│   │ websocket    │   │ heartbeat/     │
     │  (loop)    │   │           │   │ handlers     │   │ timeout        │
     │            │   │           │   │              │   │                │
     │ reads:     │   │ writes:   │   │ writes:      │   │ writes:        │
     │  status    │   │  status   │   │  status      │   │  status        │
     │  generation│   │  generation│  │              │   │                │
     │            │   │           │   │ calls:       │   │ calls:         │
     │ writes:    │   │ calls:    │   │  connect()   │   │  connect()     │
     │  status    │   │  wake()   │   │  setStatus() │   │  websocket     │
     │  isConnect │   │  ws.close │   │              │   │   .close()     │
     │  clientTok │   │           │   │              │   │  setStatus()   │
     │  retries   │   │           │   │              │   │                │
     └────────────┘   └───────────┘   └──────────────┘   └────────────────┘
           │                                 │                    │
           │            ┌────────────────────┘                    │
           ▼            ▼                                         ▼
     ┌────────────┐  ┌────────────┐                        ┌────────────┐
     │  sleeper   │  │ status/    │                        │ (also calls│
     │ (backoff)  │  │ event sys  │                        │  connect() │
     │            │  │            │                        │  and sets  │
     └────────────┘  └────────────┘                        │  ERROR)   │
                                                           └────────────┘
```

---

## Part 2: What's Structurally Wrong

The race condition is fixed (generation counter works). But the architecture has deeper problems that make the fix fragile and the code hard to reason about.

### Problem 1: Four Entry Points to `connect()`

`connect()` is called from **four** different places:

| Caller                   | Context                                             |
| ------------------------ | --------------------------------------------------- |
| Constructor              | If `connect !== false`                              |
| `websocketClose()`       | After socket dies (guarded by `status !== OFFLINE`) |
| `websocketError()`       | After socket error (same guard)                     |
| `setConnectionTimeout()` | After heartbeat timeout (**no OFFLINE guard**)      |

The `isConnecting` boolean prevents concurrent loops, but the timeout callback at line 189-196 still **sets STATUS_ERROR and closes the socket** before attempting `connect()`. This means:

1. Timeout fires → closes socket → sets ERROR → calls connect() → returns early (isConnecting)
2. websocketClose fires (from the socket.close() call) → sees ERROR (not OFFLINE) → tries connect() → returns early
3. Meanwhile the existing connect loop sees ERROR status and continues retrying

Net effect: the connect loop keeps running, but the timeout handler has already poisoned the state by setting ERROR. This is technically "fine" because the loop retries anyway, but it's **three things all trying to initiate reconnection simultaneously** for one event.

### Problem 2: Event Handlers Make Decisions

`websocketClose` and `websocketError` don't just report what happened. They:

- Set status
- Call `connect()`
- Clean up awareness

This is the root cause pattern. Event handlers should be **reporters**, not **decision-makers**. When an event handler calls `connect()`, it's a second decision-maker competing with the connect loop. The generation counter patches this, but the complexity remains.

### Problem 3: Status Is Both State and Control Flow

`status` serves two incompatible purposes:

1. **Observable state** for UI (emit to listeners)
2. **Control flow** for the connect loop (`while (status not OFFLINE/CONNECTED)`)

This creates coupling: anything that calls `setStatus()` implicitly affects the connect loop's control flow. The heartbeat timeout sets `STATUS_ERROR`, which keeps the loop running. `disconnect()` sets `STATUS_OFFLINE`, which should stop the loop. But if `websocketClose` fires after `disconnect()` and sets `ERROR` before the loop checks... you get the original race.

The generation counter fixes the race by adding a **separate** control flow signal. But now control flow depends on **both** status and generation, making it harder to reason about.

### Problem 4: No Single Owner of "Should We Be Connected?"

Right now, the "should we reconnect?" decision is distributed across:

- The connect loop's while condition
- `websocketClose`'s `status !== OFFLINE` guard
- `websocketError`'s `status !== OFFLINE` guard
- `setConnectionTimeout`'s implicit assumption (no guard at all)
- `disconnect()`'s generation bump
- The `isConnecting` boolean

Six different mechanisms, four different call sites, two different guard strategies. This is the structural problem. The generation counter adds a seventh mechanism. It works, but it doesn't simplify the system.

### Problem 5: The Heartbeat Timeout Is a Second Reconnection System

`setConnectionTimeout()` (line 184-197) is effectively a mini reconnect loop:

```typescript
this.connectionTimeoutHandle = setTimeout(() => {
	if (this.websocket) {
		this.websocket.close(); // triggers websocketClose
		this.setStatus(STATUS_ERROR); // redundant: websocketClose does this too
		this.connect(); // redundant: websocketClose does this too
	}
}, MAX_TIMEOUT_WITHOUT_RECEIVING_HEARTBEAT);
```

It does the exact same thing as `websocketClose` but from a timer callback. And it has **no OFFLINE guard**, so it can trigger reconnection even after an explicit disconnect if the timing is right (disconnect → timeout fires before socket.close event propagates).

---

## Part 3: How Other Providers Solve This

| Provider                      | Decision-Making Model                                                       |
| ----------------------------- | --------------------------------------------------------------------------- |
| **y-websocket**               | `shouldConnect` boolean. Event handlers check it. Simple.                   |
| **Hocuspocus**                | `shouldConnect` boolean + `forceSync` flag. Event handlers defer to flag.   |
| **y-sweet (current)**         | Generation counter + isConnecting + status guards in 4 places.              |
| **Database connection pools** | Supervisor loop with `desired` state. Events signal the loop; never decide. |
| **gRPC clients**              | Connectivity state machine with a single `run()` loop. Events are inputs.   |

The pattern is clear: **mature systems have one decision-maker**. Event handlers report; the loop decides.

---

## Part 4: First-Principles Redesign

### The Core Principle

> **One thing decides whether to reconnect: the supervisor loop.**
> Everything else just reports events.

### Desired State vs. Actual State

Separate "what the user wants" from "what's happening":

```typescript
private desired: 'online' | 'offline' = 'offline';  // User intent
private status: YSweetStatus = STATUS_OFFLINE;       // Actual state
private runId: number = 0;                           // Loop cancellation
```

`desired` is set by `connect()` and `disconnect()`. `status` is set by the supervisor loop based on what actually happens. No one else touches either.

### The Supervisor Loop

```typescript
private async runLoop(myRunId: number): Promise<void> {
    while (this.desired === 'online' && this.runId === myRunId) {
        this.setStatus(STATUS_CONNECTING);

        // 1. Get token
        const token = await this.fetchTokenOrBackoff(myRunId);
        if (!token || this.runId !== myRunId) break;

        // 2. Open socket and wait for it to connect or die
        const result = await this.openAndWait(token, myRunId);
        if (this.runId !== myRunId) break;

        if (result === 'connected') {
            // 3. We're synced. Wait for socket to die.
            this.retries = 0;
            await this.waitForSocketClose();
            // Socket died. Loop continues → retry.
        } else {
            // 4. Connection failed. Backoff.
            this.retries++;
            if (this.retries >= RETRIES_BEFORE_TOKEN_REFRESH) {
                this.clientToken = null;
                this.retries = 0;
            }
            await this.backoff(myRunId);
        }
    }
}
```

### Event Handlers Become Trivial

```typescript
private websocketClose(_event: CloseEvent) {
    this.clearHeartbeat();
    this.clearConnectionTimeout();
    this.socketClosedResolve?.();  // Signal the loop. That's it.
    this.cleanupAwareness();
}

private websocketError(_event: Event) {
    this.clearHeartbeat();
    this.clearConnectionTimeout();
    this.socketClosedResolve?.();  // Signal the loop. That's it.
}
```

No `setStatus()`. No `connect()`. Just resolve a promise that the loop is awaiting. The loop decides what to do next.

### Heartbeat Timeout Simplifies

```typescript
private setConnectionTimeout() {
    this.connectionTimeoutHandle = setTimeout(() => {
        this.websocket?.close();  // Just close the socket.
        // websocketClose will fire and signal the loop.
        // No setStatus, no connect(), no decisions.
    }, MAX_TIMEOUT_WITHOUT_RECEIVING_HEARTBEAT);
}
```

### Public API

```typescript
// Sets desired = 'online', starts loop if not running
public connect(): void

// Sets desired = 'offline', bumps runId, wakes sleeper, closes socket
public disconnect(): void

// Atomic: optionally swap auth + restart
public reconnect(opts?: { authEndpoint?: AuthEndpoint }): void

// Cleanup
public destroy(): void
```

`connect()` becomes fire-and-forget (no async return needed since the loop runs independently). Status is tracked via events, same as today.

### What Changes, What Stays

| Component          | Current                                      | Redesigned                                         | Change                         |
| ------------------ | -------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| Connect loop       | Checks `status` + `generation`               | Checks `desired` + `runId`                         | Same idea, cleaner             |
| `disconnect()`     | Bumps generation, sets status, wakes sleeper | Sets desired = offline, bumps runId, wakes sleeper | Same mechanics, clearer intent |
| `websocketClose`   | Sets ERROR, calls connect()                  | Resolves promise                                   | **Dramatically simpler**       |
| `websocketError`   | Sets ERROR, calls connect()                  | Resolves promise                                   | **Dramatically simpler**       |
| Heartbeat timeout  | Closes socket + sets ERROR + calls connect() | Closes socket (that's it)                          | **No more decision-making**    |
| Status transitions | Set by 4 different methods                   | Set only by the loop                               | **Single owner**               |
| `isConnecting`     | Boolean guard                                | Replaced by `connectRun` promise                   | Idempotent connect()           |
| Generation counter | Separate from desired state                  | `runId` serves same purpose                        | Unified                        |
| Event system       | Unchanged                                    | Unchanged                                          | No breaking changes            |
| Awareness          | Unchanged                                    | Unchanged                                          | No breaking changes            |
| Auth / token       | Unchanged                                    | Unchanged + optional `reconnect()`                 | Non-breaking addition          |

### The State Transition Table

With a supervisor loop, the state transitions become explicit and centralized:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     State Transitions                                │
│                     (ALL owned by the supervisor loop)                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  connect() called                                                   │
│    → desired = 'online'                                             │
│    → loop starts: OFFLINE → CONNECTING                              │
│                                                                     │
│  Token fetched successfully                                         │
│    → loop: CONNECTING (unchanged, still connecting)                 │
│                                                                     │
│  WebSocket opened                                                   │
│    → loop: CONNECTING → HANDSHAKING                                 │
│                                                                     │
│  Sync step 2 received                                               │
│    → loop: HANDSHAKING → CONNECTED                                  │
│                                                                     │
│  Socket dies (close/error/timeout)                                  │
│    → handler: resolve promise (no status change)                    │
│    → loop: CONNECTED → CONNECTING (loop iteration)                  │
│                                                                     │
│  Token fetch fails                                                  │
│    → loop: CONNECTING → ERROR → backoff → CONNECTING               │
│                                                                     │
│  Connection attempt fails                                           │
│    → loop: CONNECTING → ERROR → backoff → CONNECTING               │
│                                                                     │
│  disconnect() called                                                │
│    → desired = 'offline'                                            │
│    → runId++ (loop exits)                                           │
│    → CONNECTED/CONNECTING/ERROR → OFFLINE                           │
│                                                                     │
│  destroy() called                                                   │
│    → calls disconnect() + cleanup                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 5: Remaining Issues (Not Addressed by the Redesign)

These are bugs/gaps in the current code that exist independently of the race condition. They should be fixed regardless of which approach is taken.

### 1. `setConnectionTimeout` Has No OFFLINE Guard

**Current code** (line 189-196):

```typescript
this.connectionTimeoutHandle = setTimeout(() => {
	if (this.websocket) {
		this.websocket.close();
		this.setStatus(STATUS_ERROR); // No check for OFFLINE
		this.connect();
	}
}, MAX_TIMEOUT_WITHOUT_RECEIVING_HEARTBEAT);
```

If `disconnect()` is called and the timeout fires before the socket close event propagates, this sets ERROR after OFFLINE. The supervisor loop design eliminates this entirely (timeout just closes the socket), but if staying with the current patch, add the OFFLINE guard here too.

### 2. `destroy()` Doesn't Remove All Listeners

```typescript
public destroy() {
    this.disconnect();
    awarenessProtocol.removeAwarenessStates(...);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    // Missing: doc.off('update', this.update)
    // Missing: awareness.off('update', this.handleAwarenessUpdate)
}
```

The `doc.on('update', ...)` listener from line 140 and the `awareness.on('update', ...)` listener from line 130 are never removed. This leaks if the provider is destroyed but the Y.Doc continues living.

### 3. No Try/Catch in `receiveMessage()`

A malformed WebSocket message will throw during decoding and crash the handler. Should wrap in try/catch.

### 4. `waitForFirstSync()` Has No Timeout

If the provider stays in CONNECTING forever (server down, bad URL), the promise never resolves or rejects. UI hangs.

### 5. `clientToken` Is Public and Mutable

External code can set `provider.clientToken = whatever`, bypassing all internal state management. Should be a readonly getter.

---

## Part 6: Decision

### Option A: Keep the Surgical Fix (Current State)

The generation counter works. The race is fixed. Ship it.

**Pros**: Minimal change. Already merged. No risk of regressions.
**Cons**: Structural complexity remains. 4 entry points to connect(). Heartbeat timeout still has no OFFLINE guard. Next developer adds a 5th entry point and reintroduces the race.

### Option B: Supervisor Loop Redesign

Replace the connect loop + event handler decision-making with a single supervisor loop.

**Pros**: Eliminates the entire class of races by design. Event handlers become trivial. Single decision-maker. Enables `reconnect()` for runtime server switching.
**Cons**: Larger change. Needs careful testing. Touches the same 4 methods.

### Recommendation

**Do Option A now (it's done). Plan Option B as a follow-up when runtime server switching is needed.**

The generation counter fix is correct and sufficient. The supervisor loop is architecturally superior, but it's a bigger change than needed to fix the race. The right time to do it is when we need `reconnect()` or `setAuthEndpoint()`: those features require the supervisor loop's architecture naturally.

In the meantime, fix the remaining issues (Part 5) as separate patches:

- Add OFFLINE guard to `setConnectionTimeout`
- Add listener cleanup to `destroy()`
- Add try/catch to `receiveMessage()`
- Add timeout to `waitForFirstSync()`
- Make `clientToken` read-only

---

## References

- `packages/y-sweet/src/provider.ts`: The file analyzed
- `packages/y-sweet/src/sleeper.ts`: Sleeper utility
- `packages/epicenter/src/extensions/y-sweet-sync.ts`: Primary consumer
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`: Direct consumer
- `specs/20260212T190000-y-sweet-persistence-architecture.md`: Persistence architecture context
