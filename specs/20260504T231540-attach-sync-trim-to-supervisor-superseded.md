# Trim `attachSync` back to the supervisor it claims to be

**Date**: 2026-05-04
**Status**: Superseded by `specs/20260504T233223-sign-out-preserves-local-data.md`
**Author**: AI-assisted (Claude)
**Branch**: not started
**Related**:
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md` (ready for review; refined by `specs/20260430T114949-peer-presence-rename-and-sync-split.md`)
- `specs/sync-client-simplification.md` (implemented in old `packages/sync-client`; partially reverted by the workspace collapse)
- `specs/20260310T235239-sync-status-102.md` (original SYNC_STATUS introduction)

## One-sentence test

This spec **strips two custom protocol extensions out of `attach-sync.ts` (peer RPC and `SYNC_STATUS`/`hasLocalChanges` version tracking) and adds the missing JSDoc that explains why the file's third weird-looking feature (the text `"ping"` heartbeat) is actually load-bearing**, so the file's code matches its file-level docstring claim of being a "minimal Y.Doc sync attachment."

## Overview

`packages/workspace/src/document/attach-sync.ts` currently bundles the supervisor with two custom protocol extensions and one underdocumented Cloudflare-specific mechanism. This spec separates the three:

- **Cut #1: RPC extraction**: execute the existing `attachRpc` split spec. Removes ~150 LOC.
- **Cut #2: SYNC_STATUS removal**: re-apply the previously-implemented simplification. Removes ~50 LOC.
- **Doc #3: Ping/liveness**: keep the mechanism, add JSDoc explaining the Cloudflare DO `setWebSocketAutoResponse` binding. No code removed; ~20 LOC of comments added.

Combined: ~200 LOC out of 1130 (~18% reduction), zero functional regressions if both removed features have no live consumers.

## Motivation

### Current State

The file's own header (line 50-69) advertises a focused primitive:

```
Minimal Y.Doc sync attachment: connects a Y.Doc to a WebSocket sync server.

This is a low-level primitive for `packages/document`. It handles the
Y.Doc sync protocol (STEP1/STEP2/UPDATE), supervisor loop with exponential
backoff, liveness detection, and graceful shutdown.

**Not included** (workspace-layer concerns):
- BroadcastChannel cross-tab sync (separate `attachBroadcastChannel` helper)
- Peer directory helpers over an attached awareness state
- Peer RPC (`sync.attachRpc(actions)`)
```

But the same file (line 152, 886-963) implements `attachRpc` as a method on the result. The doc is wrong, or the code is wrong; pick one.

The file also implements:

```ts
// SYNC_STATUS version tracking (lines 396-408, 484-491, 739-751)
let localVersion = 0;
let ackedVersion = 0;
let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;
// ...debounce, send encodeSyncStatus, on echo update ackedVersion, recompute hasLocalChanges
```

This is a custom protocol extension (confirmed by deepwiki against `yjs/y-protocols`: only SYNC, AWARENESS, QUERY_AWARENESS are standard).

And:

```ts
// Text "ping" heartbeat (lines 560-565, 1010-1018)
pingInterval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send('ping');
}, PING_INTERVAL_MS);
```

This **looks** like duct tape but is actually intentional: the server at `apps/api/src/base-sync-room.ts:141-142` configures `setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`. Cloudflare answers at the edge without waking the Durable Object. There is zero in-file documentation explaining this binding.

### Problems

1. **Type-doc mismatch.** Anyone reading the file-header comment learns that peer RPC is "not included." Anyone reading the code finds it implemented. New contributors will trust the wrong source.
2. **Custom extensions inflate the supervisor.** RPC (~150 LOC) and SYNC_STATUS (~50 LOC) are independent features bolted into a file that the docstring promises is "minimal." They make the supervisor's actual job (Y.Doc sync + reconnection) harder to read.
3. **Hidden Cloudflare coupling.** The `"ping"` string mechanism is a vendor-specific liveness optimization with zero in-file explanation. The next reader will either rip it out (breaking hibernation behavior) or re-implement it elsewhere with a different magic string (breaking the auto-response match).
4. **Prior simplification was reverted silently.** `specs/sync-client-simplification.md` removed `hasLocalChanges`/SYNC_STATUS once already, with the explicit finding "zero consumers across all apps." When `packages/sync-client` collapsed into `packages/workspace`, the feature came back without a fresh consumer or rationale.

### Desired State

```
attach-sync.ts (~700-750 LOC)
  WebSocket supervisor for a Y.Doc.
  - Y.Doc sync protocol (STEP1/STEP2/UPDATE)
  - reconnection + exponential backoff
  - auth via openWebSocket capability
  - text "ping"/"pong" liveness via Cloudflare DO auto-response (documented)
  - graceful dispose, whenConnected, status emitter

attach-rpc.ts (~200 LOC, NEW)
  Peer-to-peer RPC over the supervisor's wire.
  Built per existing split spec.
```

## Research findings

### Cuts have prior implementation history

| Cut | Prior spec | Status of prior work |
|---|---|---|
| RPC extraction | `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md` | Ready for review; refined by `specs/20260430T114949-peer-presence-rename-and-sync-split.md`. Not yet implemented in current `attach-sync.ts`. |
| SYNC_STATUS removal | `specs/sync-client-simplification.md` | Implemented in old `packages/sync-client/src/provider.ts`. Reintroduced in `attach-sync.ts` during the collapse. **Need to investigate why.** |
| Ping/liveness removal | This spec originally proposed it | **Withdrawn** after research: it's load-bearing for CF DO hibernation. |

### `"ping"` string is a Cloudflare DO contract

Server side (`apps/api/src/base-sync-room.ts:141-142`):

```ts
ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair('ping', 'pong'),
);
```

From `specs/sync-client-simplification.md:17`:

> `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` responds to text `"ping"` with `"pong"` at the edge, without waking the DO.

Why this matters more than the y-websocket comparison: y-websocket runs on long-lived Node servers. We run on Cloudflare Durable Objects with hibernation. A binary heartbeat would wake the DO every interval, costing CPU time and defeating hibernation. The text auto-response was specifically chosen to keep idle connections cheap.

The y-websocket reference impl (per deepwiki against `yjs/y-websocket`) doesn't ping at all. It relies on inbound traffic. We can't do that because:
1. Our server filters out the awareness echo trick (per `sync-client-simplification.md:36-39`)
2. Idle connections genuinely have no inbound traffic
3. CF's documented idle behavior is "uncertain and undocumented" (per simplification spec line 18-19)

### `hasLocalChanges` consumer audit (TODO during implementation)

Prior spec found zero consumers across `apps/whispering`, `apps/tab-manager`, `apps/api`. This spec must verify the same is true today across:
- `apps/whispering`
- `apps/tab-manager`
- `apps/api/dashboard` (didn't exist when the original audit ran)
- `apps/cli`
- Any new apps under `apps/*`

If any current code path reads `status.hasLocalChanges` or subscribes to it via `onStatusChange` and switches on `connected.hasLocalChanges`, the cut must either:
- Replace that code path first, or
- Be downgraded to "leave SYNC_STATUS alone."

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cut #1 implementation | Follow existing split spec | Decision already made and refined. No reason to redesign. |
| Cut #2 default | Remove if zero consumers | Matches prior `sync-client-simplification` finding. Re-verify before pulling. |
| Cut #2 fallback | Keep but extract | If a real consumer exists, lift `hasLocalChanges` into a sibling `attachSyncStatus` rather than baking it into the base supervisor. |
| Cut #3 (ping) | Keep, document | Load-bearing for CF DO hibernation. Smell was lack of comments, not the code. |
| Logging additions | Add `log.info` on phase transitions and `log.warn` on permanent failure | Current file has only 2 `log.warn` calls; debugging sync issues in production has no breadcrumbs. |
| Order of cuts | RPC first, then SYNC_STATUS, then docs | RPC is biggest blast radius; do it first under the existing approved spec. SYNC_STATUS is independent. Docs are no-risk. |
| Ping mechanism rename | Defer | Could rename to `LIVENESS_HEARTBEAT_*` or extract a `createCloudflareLiveness` helper, but adds churn. Documentation is enough for now. |

## Architecture

### Before (current `attach-sync.ts`, ~1130 LOC)

```
┌────────────────────────────────────────────────────────────┐
│                     attach-sync.ts                         │
│                                                            │
│  ┌────────────────────┐  ┌────────────────────────────┐   │
│  │  Supervisor core   │  │  RPC dispatcher (~150 LOC) │   │
│  │  - Y.Doc protocol  │  │  - pendingRequests map     │   │
│  │  - reconnect/back. │  │  - request/response corr.  │   │
│  │  - waitFor barrier │  │  - system.* injection      │   │
│  │  - whenConnected   │  │  - per-call timeout        │   │
│  │  - dispose         │  └────────────────────────────┘   │
│  │  - awareness wire  │                                   │
│  └────────────────────┘  ┌────────────────────────────┐   │
│                          │  SYNC_STATUS (~50 LOC)     │   │
│  ┌────────────────────┐  │  - localVersion counter    │   │
│  │  Liveness (~40 LOC)│  │  - ackedVersion counter    │   │
│  │  - text ping/pong  │  │  - 100ms debounce timer    │   │
│  │  - tab focus probe │  │  - hasLocalChanges flag    │   │
│  │  - 90s timeout     │  └────────────────────────────┘   │
│  │  ⚠ undocumented    │                                   │
│  │     CF binding     │                                   │
│  └────────────────────┘                                   │
└────────────────────────────────────────────────────────────┘
```

### After (~700-750 LOC across two files)

```
┌────────────────────────────────────────────────────────────┐
│                   attach-sync.ts                           │
│                                                            │
│  ┌────────────────────┐  ┌──────────────────────────────┐ │
│  │  Supervisor core   │  │  Liveness (CF auto-resp)     │ │
│  │  - Y.Doc protocol  │  │  - text ping/pong            │ │
│  │  - reconnect/back. │  │  - tab focus probe           │ │
│  │  - waitFor barrier │  │  - 90s timeout               │ │
│  │  - whenConnected   │  │  ✅ JSDoc explains binding   │ │
│  │  - dispose         │  │     to base-sync-room.ts     │ │
│  │  - awareness wire  │  └──────────────────────────────┘ │
│  │  - raw.send /      │                                   │
│  │    raw.onMessage   │                                   │
│  └────────────────────┘                                   │
└─────────────────────────┬──────────────────────────────────┘
                          │ raw.send / raw.onMessage
                          ▼
┌────────────────────────────────────────────────────────────┐
│                    attach-rpc.ts (NEW)                     │
│  - pendingRequests map                                     │
│  - request/response correlation                            │
│  - system.* injection                                      │
│  - per-call timeout / Disconnected handling                │
└────────────────────────────────────────────────────────────┘
```

## Implementation plan

### Phase 0: Verify the cuts are still safe (~30 min)

- [ ] **0.1** Grep `apps/*` and `packages/*` for `hasLocalChanges`, `onLocalChanges`, `connected.hasLocalChanges`, and any subscribers that destructure `s.hasLocalChanges` from `onStatusChange`. If non-empty, escalate Cut #2 to "extract instead of remove."
- [ ] **0.2** Confirm the existing split spec at `specs/20260430T103959-...md` and its refinement at `specs/20260430T114949-...md` are still the intended direction. If superseded, follow the newer spec for Cut #1.
- [ ] **0.3** Confirm `apps/api/src/base-sync-room.ts:141-142` is the only `setWebSocketAutoResponse` call. If multiple sync rooms use different pairs, Cut #3 (the JSDoc) must enumerate them.

### Phase 1: Cut #1: execute the RPC split (per existing spec)

Defer to `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md` Phase 1-3. Summary of what lands in this work:

- [ ] **1.1** Create `packages/workspace/src/document/attach-rpc.ts`.
- [ ] **1.2** Add `raw: { send, onMessage }` to `SyncAttachment`.
- [ ] **1.3** Move RPC state and logic out of `attach-sync.ts` into `attach-rpc.ts`.
- [ ] **1.4** Update callers (`apps/whispering`, `apps/cli`, `apps/tab-manager`, etc.) to call `sync.attachRpc(actions)` explicitly.
- [ ] **1.5** Move RPC tests from `attach-sync.test.ts` to `attach-rpc.test.ts`.
- [ ] **1.6** Update `attach-sync.ts` file-level JSDoc to remove the now-truthful "Peer RPC not included" line, since RPC is now genuinely a sibling primitive.

### Phase 2: Cut #2: remove SYNC_STATUS / hasLocalChanges

- [ ] **2.1** Remove `localVersion`, `ackedVersion`, `syncStatusTimer` from `attach-sync.ts`.
- [ ] **2.2** Remove SYNC_STATUS encoding from `handleDocUpdate`.
- [ ] **2.3** Remove the `MESSAGE_TYPE.SYNC_STATUS` branch from `onmessage`.
- [ ] **2.4** Collapse `SyncStatus` from `connected: { hasLocalChanges: boolean }` to `connected` (no payload), or `connected: {}` if a discriminator is needed.
- [ ] **2.5** Remove server-side SYNC_STATUS echo from `apps/api/src/sync-handlers.ts` (and any sibling handlers).
- [ ] **2.6** Update `@epicenter/sync` to remove `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus` (or mark deprecated and unexport).
- [ ] **2.7** Update tests that exercise the version round-trip.

### Phase 3: Doc #3: JSDoc the ping/pong contract

- [ ] **3.1** Add a header block to `createLivenessMonitor` (line 995) explaining:
  - The text `"ping"` is sent every `PING_INTERVAL_MS` (60s).
  - The server answers via `setWebSocketAutoResponse('ping', 'pong')` at the CF edge, never waking the Durable Object.
  - The `"pong"` arrives as a text frame; `onmessage` short-circuits string frames at line 697 but still calls `liveness.touch()` first (line 696), so the timer resets.
  - `LIVENESS_TIMEOUT_MS` (90s) is generous to absorb a missed ping in a throttled background tab.
  - File reference: `apps/api/src/base-sync-room.ts:141-142`.
- [ ] **3.2** Add a one-line comment at line 564 (`websocket.send('ping')`) cross-referencing the helper.
- [ ] **3.3** Add a `log.info` call on each `status.set(...)` that is *not* `connecting` (i.e., on `offline`, `connected`, `failed`) so production has breadcrumbs. Keep `connecting` quiet to avoid log spam during retry loops.
- [ ] **3.4** Add a `log.warn` when `parsePermanentFailure` returns non-null, including the close code and parsed reason.

### Phase 4: Verify

- [ ] **4.1** Typecheck `packages/workspace`, `apps/api`, `apps/whispering`, `apps/cli`, `apps/tab-manager`.
- [ ] **4.2** Run `attach-sync.test.ts` and `attach-rpc.test.ts`.
- [ ] **4.3** Manual smoke: open Whispering, edit a recording, observe sync status transitions in dev tools. Verify no `hasLocalChanges` references in UI.
- [ ] **4.4** Manual smoke: idle a tab for 90s+ with the API in dev mode; confirm reconnect works after the liveness timeout. (Note: per `sync-client-simplification.md:22`, `setWebSocketAutoResponse` has known `workerd` bugs in local dev: deploy to a preview environment if local dev misbehaves.)

## Edge cases

### A consumer reads `status.hasLocalChanges`

1. Phase 0 grep returns a real consumer.
2. Don't remove SYNC_STATUS. Instead, extract it to `attachSyncStatus(sync)` as a sibling.
3. The base `SyncStatus` collapses to `connecting | connected | offline | failed`; the extension exposes `hasLocalChanges` separately.

### Cloudflare auto-response misbehaves in local dev

1. Per `sync-client-simplification.md:22`: known `workerd` bugs (cloudflare/workerd#1009, #1259).
2. Local dev liveness may rely on the `LIVENESS_TIMEOUT_MS` fallback closing the socket.
3. Document this in Phase 3.1 so contributors don't think the heartbeat is broken.

### A non-Cloudflare deployment runs the same client code

1. The text `"ping"` becomes outbound-only with no echo.
2. `liveness.touch()` only fires on inbound messages, so an idle non-CF connection will close after 90s.
3. The supervisor reconnects. Connection is wasteful but not broken.
4. If we ever support non-CF servers as a real deployment, revisit by making the heartbeat strategy a config option.

### `attachRpc` callers break during the split

1. RPC extraction is a public API change.
2. Phase 1.4 must update all callers in the same PR or feature branch.
3. The split spec already enumerates files touched.

## Open questions

1. **Why did SYNC_STATUS come back after `sync-client-simplification` removed it?**
   - Options: (a) intentional new requirement, (b) carried over by accident during the collapse, (c) added by a separate spec we haven't found.
   - **Recommendation**: git-blame the SYNC_STATUS lines in `attach-sync.ts` to find the commit that re-introduced them. If the commit message cites a real consumer, escalate Cut #2 to "extract." If it's a copy-from-old-code accident, proceed with removal.

2. **Should we also rename the constants to make the CF binding obvious?**
   - Today: `PING_INTERVAL_MS`, `LIVENESS_TIMEOUT_MS`.
   - Alternative: `CLOUDFLARE_AUTO_RESPONSE_PING_MS` (clearer but ugly), or extract `createCloudflareLiveness(ws)` helper.
   - **Recommendation**: Defer. Adding a JSDoc that names the file is enough for now. Rename only if a non-CF deployment becomes a real plan.

3. **Should `connected.hasLocalChanges` collapse to `connected` (no payload) or `connected: {}` (empty object)?**
   - The empty-object version preserves the discriminated-union shape for future extension.
   - The bare `{ phase: 'connected' }` version is cleaner but requires no payload check.
   - **Recommendation**: `{ phase: 'connected' }` with no payload. We can add fields later when a real need exists.

4. **Should this spec block on the existing split spec being implemented first, or land them together?**
   - Together = larger PR but truthful end state.
   - Sequenced = reviewable but `attach-sync.ts` lives in an "RPC removed but doc still says it isn't here" state if Cut #1 lands without #2.
   - **Recommendation**: Together, in the order Phase 1 → Phase 2 → Phase 3, with one PR per phase if size demands.

## Success criteria

- [ ] `attach-sync.ts` is between 700 and 800 LOC (down from 1130).
- [ ] File-level JSDoc accurately describes what the file contains. No "not included" lies.
- [ ] `attach-rpc.ts` exists and is composed via `sync.attachRpc(actions)`.
- [ ] No reference to `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `localVersion`, `ackedVersion`, or `hasLocalChanges` in `packages/workspace`, `apps/api/src/sync-handlers.ts`, or any consumer.
- [ ] `createLivenessMonitor` has a JSDoc block citing `apps/api/src/base-sync-room.ts:141`.
- [ ] At least one `log.info` per terminal status transition; one `log.warn` on permanent failure with parsed close code.
- [ ] `attach-sync.test.ts` passes; `attach-rpc.test.ts` exists and passes.
- [ ] Manual smoke on Whispering shows sync still reconnects after a 90s+ idle.

## References

- `packages/workspace/src/document/attach-sync.ts`: the file being trimmed
- `apps/api/src/base-sync-room.ts:141`: the CF auto-response that makes the text ping load-bearing
- `apps/api/src/sync-handlers.ts`: server-side SYNC_STATUS echo to remove
- `packages/sync/src/index.ts`: `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus` to remove or deprecate
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`: Cut #1 reference spec
- `specs/20260430T114949-peer-presence-rename-and-sync-split.md`: refinement of the split spec
- `specs/sync-client-simplification.md`: prior implementation of Cut #2 in old `sync-client`
- `specs/20260310T235239-sync-status-102.md`: original SYNC_STATUS introduction
- y-websocket reference (`yjs/y-websocket/src/y-websocket.js`): for comparison on liveness; note the comparison is misleading because we run on CF DOs, not Node
