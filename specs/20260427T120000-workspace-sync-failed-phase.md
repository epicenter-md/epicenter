# Workspace sync: add `failed` phase, reject `whenConnected` on permanent failure

**Status**: Partially implemented; frame design superseded
**Owner**: TBD
**Tracking**: replaces the CLI-side `--connect-timeout` stopgap

**Review 2026-05-01**: The workspace-layer behavior exists: `SyncStatus`
includes `failed`, `SyncFailedError` exists, `whenConnected` rejects on failed
status, permanent auth failure stops retrying, and `reconnect()` clears that
failure. The proposed `MESSAGE_TYPE.AUTH = 41` frame did not land. Current code
uses WebSocket close code `4401` with a JSON reason. The remaining useful
follow-up is small: make CLI `up` render failed sync status clearly if needed.

## One-line goal

Make `whenConnected` reject promptly when a workspace's connection fails for reasons that won't fix themselves on retry (auth rejected, protocol incompatible), so callers can give up cleanly without bolting wallclock timers on top.

---

## The problem

Today, `attachSync` has two terminal states:

```
                    ┌──────────────────┐
                    │ retries forever  │
   offline ──→ connecting ──┐
                    └──→ connected
                                  ↑
                     (whenConnected resolves here)
```

A doc destroy is the only thing that rejects `whenConnected`. Auth failures, expired tokens, protocol mismatches: all fall into the unbounded retry loop at `attach-sync.ts:1115`. The supervisor backs off forever. There is **no concept of "give up."**

This forces every caller that wants bounded startup to invent its own clock. The CLI does it via `--connect-timeout` (now a hardcoded 10 s ceiling). A future Tauri app would have to do the same. That's a missing semantic at the workspace layer.

### Why the protocol can't already tell

When the relay rejects auth, it just closes the WebSocket. The client sees `onclose`. There's no payload that says *"this isn't a network blip, don't bother retrying."* So the supervisor treats every close as transient and loops.

```
   client                 relay
     │                      │
     │── handshake ────────→│
     │                      │ (token invalid)
     │←──── socket close ───│
     │                      │
     │  "must be a network  │
     │   blip, retry…"      │
```

Two distinct failure modes: bad credentials vs. flaky wifi: surface as the same close event. Until the wire carries the distinction, the client can't act on it.

---

## The design

Three coordinated changes:

### 1. New `phase: 'failed'` in `SyncStatus`

```ts
// packages/workspace/src/document/attach-sync.ts

export type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; retries: number; lastError?: SyncError }
  | { phase: 'connected'; hasLocalChanges: boolean }
  | { phase: 'failed'; reason: SyncError };  // ← NEW: permanent
```

Semantics:

- `failed` means *"stop retrying. The cause is not transient."*
- Entering `failed` halts the supervisor loop.
- `reconnect()` resets `failed` → `connecting` (e.g. after `epicenter auth login`, the user wants to retry with a fresh token).

### 2. `whenConnected` rejects on `failed`

Today, `whenConnected` resolves on first successful handshake and rejects only on doc destroy. After this change:

```ts
status.subscribe((next) => {
  if (next.phase === 'connected' && !handshakeSettled) {
    settleConnected(resolveConnected);
    handshakeSettled = true;
  } else if (next.phase === 'failed' && !handshakeSettled) {
    settleConnected(rejectConnected, new SyncFailedError(next.reason));
    handshakeSettled = true;
  }
});
```

Now `await sync.whenConnected` follows three paths:

| Outcome | Means |
|---|---|
| Resolves | First handshake completed |
| Rejects with `SyncFailedError` | Permanent failure (auth, protocol) |
| Rejects with destroy error | Doc destroyed before handshake |

The CLI's `runUp` deletes its `raceTimeout`/`CONNECT_TIMEOUT_MS` and just `await`s.

### 3. Server sends explicit auth-rejection frame

The wire change. Use the reserved `MESSAGE_TYPE.AUTH = 41` slot at `packages/sync/src/protocol.ts`:

```
┌──────────────────────────────────────────────────┐
│ MESSAGE_TYPE.AUTH (41)                           │
├──────────────────────────────────────────────────┤
│ subtype: REJECTED (0x01)                         │
│ reason:  uint8                                   │
│   0x01  invalid_token                            │
│   0x02  token_expired                            │
│   0x03  deauthorized                             │
│   0x04  protocol_incompatible                    │
│ detail:  utf-8 string (variable length)          │
└──────────────────────────────────────────────────┘
```

Server flow:

```
   client                       relay
     │                            │
     │── handshake (token=X) ────→│
     │                            │ (token invalid)
     │←─── AUTH/REJECTED/0x01 ────│
     │←──── socket close ─────────│
     │                            │
     │  client.handleAuth(frame)  │
     │  → status.set({ phase:    │
     │      'failed', reason: { │
     │      type: 'auth',       │
     │      code: 'invalid_token'  │
     │    }})                     │
     │  → supervisor exits loop  │
     │  → whenConnected rejects  │
```

**Why a typed frame and not just a close code?** WebSocket close codes (1000-4999) carry a number but no structured detail. A typed frame is forward-compatible: we can add `reason` codes without burning close codes, and the client can render rich detail (`"token expired at 2026-04-27T11:23"`) without secondary lookups.

### Updated `SyncError`

```ts
export type SyncError =
  | { type: 'auth'; code: AuthRejectCode; detail: string }
  | { type: 'connection'; cause: unknown }
  | { type: 'protocol'; cause: unknown };

type AuthRejectCode =
  | 'invalid_token'
  | 'token_expired'
  | 'deauthorized'
  | 'protocol_incompatible';
```

The `cause: unknown` on `connection` is intentional. It stays freeform because network failures are inherently varied.

---

## How retries change

Today: every close → `lastError = { type: 'connection' }` → retry.

After:

| Cause | Effect |
|---|---|
| Server sends `AUTH/REJECTED` | `phase: 'failed'`; supervisor exits; `whenConnected` rejects |
| Server hangs up without rejection frame | `phase: 'connecting'`; retry with backoff (existing behavior) |
| `getToken()` throws or returns null | `phase: 'connecting'` with `lastError: auth`; retry (existing behavior, no semantic change) |
| Doc destroyed | `whenConnected` rejects with destroy error (existing behavior) |

Note: `getToken()` failures stay transient. The user might call `epicenter auth login` and recover. Permanent auth failure is *only* when the server explicitly says "no" via the rejection frame.

---

## How `reconnect()` changes

```ts
sync.reconnect();
// ↑ from any phase, including 'failed'
//   transitions status to { phase: 'connecting', retries: 0 }
//   re-enters supervisor loop
```

Use case: user runs `epicenter auth login` after `up` has already given up on a workspace. A future `epicenter reconnect --workspace <name>` IPC verb (or restart of `up`) calls `sync.reconnect()` to retry with the freshly-stored token.

---

## Phased plan

The server-side change is the only piece that crosses repos. Plan around that:

### Phase 1: client-only (no server dependency)

Land everything client-side that doesn't need the new frame. Lays the foundation; behavior change is invisible to users until phase 2 lights it up.

- [ ] Add `phase: 'failed'` to `SyncStatus`. Update `SyncError` to carry the structured detail. Update consumers (status emitter, status subscribers).
- [ ] Add `SyncFailedError` typed error class.
- [ ] Wire `whenConnected` to reject when `phase === 'failed'`.
- [ ] `reconnect()` resets `failed` → `connecting`.
- [ ] Tests: status transitions, `whenConnected` rejection on simulated `failed` event, `reconnect()` resets cleanly.

After phase 1 the new states exist but nothing produces `failed` yet. The rest of the system is unchanged.

### Phase 2: server frame (cross-repo coordination)

The relay learns to send `AUTH/REJECTED` before closing on bad credentials.

- [ ] Define `MESSAGE_TYPE.AUTH = 41` payload in `packages/sync/src/protocol.ts` (encoder + decoder).
- [ ] Server: when auth fails, send `AUTH/REJECTED/<reason>/<detail>`, then close.
- [ ] Client: handle the frame in the WebSocket message dispatcher → set `phase: 'failed'`.
- [ ] Tests: protocol round-trip; client sets `failed` on receipt; `whenConnected` rejects.

After phase 2, real auth failures get fast-rejection.

### Phase 3: CLI cleanup

- [ ] Delete `CONNECT_TIMEOUT_MS` constant from `packages/cli/src/commands/up.ts`.
- [ ] Delete `RunUpDeps.connectTimeoutMs`.
- [ ] Delete `raceTimeout` and `connectFailedMessage` helpers.
- [ ] Replace `await raceTimeout(...)` with `await entry.workspace.sync?.whenConnected`.
- [ ] When `whenConnected` rejects, render the structured `SyncFailedError` (carries reason + detail).
- [ ] Update `cli-up-long-lived-peer.md` spec: remove the "10 s ceiling" qualifier from the lifecycle table.

---

## Acceptance criteria

- [ ] **Auth rejection is fast.** With a deliberately invalid token, `epicenter up` exits within the round-trip time of one handshake (<500 ms typical, no 10-second wait).
- [ ] **Network blips still retry.** Bringing the relay down briefly with a valid token does not transition the workspace to `failed`. The supervisor retries; banner shows `connecting (retry N)`.
- [ ] **Reconnect after auth fix works.** With a permanently-failed workspace, calling `sync.reconnect()` (programmatically or via a future CLI verb) after `epicenter auth login` reaches `connected`.
- [ ] **`whenConnected` typed rejection.** Catching it surfaces `SyncFailedError` with `reason.type === 'auth'` and a populated `code`. No magic strings.
- [ ] **Multiple workspaces are independent.** One workspace's `failed` state doesn't taint another's `connecting`/`connected`.

---

## Things we're not doing

- **`getLocalDeviceId` getter on `SyncAttachment`.** No real consumer; users configure deviceIds and already know them. Defer until something needs to query.
- **Bounded retries on `connection` errors.** Daemons should keep trying when the network returns. The whole point of `failed` is to distinguish "give up" (auth) from "keep trying" (network).
- **`epicenter reconnect` CLI verb.** The IPC plumbing is implied by `reconnect()` becoming meaningful, but the CLI verb is a separate spec when there's a clear UX for it.
- **Mid-session auth refresh.** If the server *deauthorizes* a connected client (revokes a token mid-session), we should handle that: but that's a separate frame (`AUTH/REVOKED`) and a separate spec.
- **Backwards compatibility with old relays.** The first time we deploy phase 2, clients running phase-1 code will see the `AUTH` frame as an unknown message and ignore it (existing protocol behavior). Old clients connecting to a new relay still get the close-after-frame; they just retry like today. No flag day.

---

## Questions before implementation

1. **Where does the relay live?** Confirm whether `packages/server-remote-cloudflare` is the auth-rejection sender, or if there's a separate relay. (This determines who owns phase 2.)
2. **`MESSAGE_TYPE.AUTH = 41` collision check.** Confirm 41 is genuinely reserved and not already used anywhere. If used, pick the next free number.
3. **Existing `getToken()` failure path.** When `getToken()` returns null and we currently set `lastError: { type: 'auth' }`, should that path *also* set `failed`, or stay transient? My read: keep transient (the user's auth provider might be temporarily unreachable, retry is right). Permanent only on server-rejection frame.
4. **Test infrastructure for the relay-rejection path.** Phase 2 needs a way to fake "relay rejected this token" in tests. Does the existing test harness support custom-frame relay responses, or do we need to extend it?

These don't block phase 1. They block phase 2.

---

## File map

```
packages/sync/src/protocol.ts              # phase 2: define AUTH frame format
packages/workspace/src/document/
  attach-sync.ts                           # all phases: SyncStatus, supervisor, whenConnected
  errors.ts (or wherever SyncError lives)  # phase 1: SyncFailedError, error variants
<relay package>/                            # phase 2: send the frame on auth failure
packages/cli/src/commands/up.ts            # phase 3: delete CONNECT_TIMEOUT_MS + raceTimeout
specs/20260426T235000-cli-up-long-lived-peer.md  # phase 3: drop 10s ceiling note
```

Estimated total: ~300 LOC across 4-5 files, plus the relay-side change (size depends on how the relay's auth code is structured today).
