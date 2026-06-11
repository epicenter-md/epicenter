# CLI Remote Peer RPC

**Date**: 2026-04-23
**Status**: shipped (Phases 1 & 2); Phase 3 (docs) deferred
**Author**: AI-assisted
**Depends on**: `specs/20260423T010000-unify-dot-path-format.md` (shipped)

## Shipped Summary

Phases 1 and 2 landed with deliberate simplifications. The verdict: **worth it.** The RPC pipeline was already paid for; wiring the CLI into it was a small, self-contained change (~3 files net), and the remote column now mirrors the local column symmetrically. No new primitives, no wire changes, as planned.

### Deviations from the original plan

| Planned artifact | Shipped reality | Why the change is fine (or better) |
| --- | --- | --- |
| `util/render-peers.ts` separate file | Rendering inlined into `commands/peers.ts:66-102` (commit `94082c5`) | Single consumer; split was premature extraction. Rule of thumb: don't extract a shared util for symmetry alone: shared files earn their place by 2+ consumers. |
| `util/peer-option.ts` | `peerOption` and `timeoutOption` inlined in `run.ts:31-41` | Same rule: single-consumer flags stay inline. `workspaceOption`/`dirOption` earn shared files because they're reused 3×. |
| `util/handle-peers.ts` | Renamed to `util/handle-attachments.ts` and widened to cover both `sync` and `awareness` | Module describes the capability (reading optional attachments off an arbitrary bundle), not the first caller. |
| "Case-insensitive exact" fuzzy fallback | **Substring-of-lowercased** match (`find-peer.ts:66-73`) | Strictly more useful: `MACBOOK` correctly disambiguates `myMacbook` vs `workMacbook` instead of silently being `not-found`. Documented in the source jsdoc and covered by tests. Spec wording is stale, not the code. |
| Phase 3: `packages/workspace/README.md` convention section | Not done | Convention is described as JSDoc in `packages/cli/src/util/handle-attachments.ts` instead; workspace README hasn't needed it yet. Revisit when a second app adopts `deviceName`. |

### Code smells found during status audit

1. **Post-dispose awareness-settle loop is duplicated** in `run.ts:75-82` and `peers.ts:46-53`: both do `await dispose()` then iterate entries awaiting `sync.whenDisposed`. This is a small DRY violation that matters because future commands will copy it. Candidate: fold into `loadConfig`'s returned `dispose()` so callers get clean teardown for free.
2. **`exact.length > 1` returns `case-ambiguous`** (`find-peer.ts:77-79`): technically correct shape, but the error message "multiple peers match case-insensitively" is misleading when the collisions are case-*sensitively* equal (two peers sharing `deviceName: "myMacbook"`). Minor; edge case.
3. **`run.ts:184-186` re-reads `readPeers(entry.handle)` after the find loop** to get `peerState` for error formatting. If the peer disconnects between resolution and RPC dispatch, `peerState` is `{}` and the error message loses deviceName/version. Acceptable (caller sees a different error anyway), but worth a one-line comment.
4. **`POLL_INTERVAL_MS = 100` hardcoded** in `run.ts:28`. Fine for now; flag if tests ever need to control it.
5. **Spec wording drift on fuzzy matching**: spec says "case-insensitive exact", code does substring. Update the spec (below) or the code. Code is the better behavior; spec is wrong.

### Leftover work

- [ ] Spec-wording fix: replace "case-insensitive exact" language in the Design Decisions table + Target Resolution section with "case-insensitive substring." (Cosmetic; code is correct.)
- [ ] Phase 3 docs: deferred until a second app adopts the `deviceName` convention.
- [ ] Optional refactor: move the `sync.whenDisposed` post-dispose wait into `loadConfig`'s dispose contract so `run.ts` and `peers.ts` don't each reimplement it.

## Overview

The CLI surface is two verbs (enumerate, invoke) × two scopes (local, remote). The local column ships: `list` enumerates actions, `run` invokes them. This spec fills in the remote column:

```
               Local            Remote
             ┌─────────┬─────────────────┐
 Enumerate   │  list   │  peers          │  ← this spec
 Invoke      │  run    │  run --peer     │  ← this spec
             └─────────┴─────────────────┘
```

No new primitives. No wire protocol changes. No framework-injected actions. The CLI uses the **local config as the authoritative schema**, and remote peers are pure executors. `--peer` is an address, not a mode. The verb and schema are unchanged, only the dispatch target moves.

## Motivation

The RPC pipeline is already built end-to-end:

```
sync.rpc(clientId, action, input)              ← client, attach-sync.ts:779-840
[101, REQUEST, reqId, targetId, ...]           ← wire, protocol.ts:449-621
DO routes by controlledClientIds               ← server, base-sync-room.ts:368-442
dispatchAction(actions, path, input)           ← receiver, actions.ts:471-488
[101, RESPONSE, reqId, ...]
```

Every other client (browser extension, desktop app) uses `sync.rpc` already. The CLI: despite being the "scripting-first" surface: has no way to reach remote peers.

## Architecture

The CLI's local config is the authoritative source for action trees, schemas, and typing. Remote peers are invocation targets, not schema sources.

```
┌──────────────────────────────────────────────────────────┐
│ LOCAL                                                    │
│                                                          │
│  epicenter.config.ts                                     │
│    └─ handle (actions, schemas, sync, awareness)         │
│          ↑                                               │
│          │ (authoritative for everything CLI does)       │
│          │                                               │
│  CLI ────┘                                               │
│   ├── list       → walk handle's actions                 │
│   ├── peers      → read handle.awareness.getStates()     │
│   ├── run x.y    → handle.x.y(input)  [direct call]      │
│   └── run --peer → handle.sync.rpc(id, "x.y", input)     │
│                       │                                  │
└───────────────────────┼──────────────────────────────────┘
                        │ ws://... RPC msg 101
                        ↓
┌──────────────────────────────────────────────────────────┐
│ REMOTE PEER (same workspace code)                        │
│   rpc.dispatch("x.y", input)                             │
│     → dispatchAction(actions, "x.y", input)              │
│     → actions.x.y(input)                                 │
│   returns result via msg 101                             │
└──────────────────────────────────────────────────────────┘
```

## Terminal Sessions (the north star)

Everything below exists to make these sessions work.

```bash
# Discovery: one console.table per workspace
$ epicenter peers

tabManager
┌──────────┬────────────┬─────────┬────────────────┐
│ clientID │ deviceName │ version │ activeTabCount │
├──────────┼────────────┼─────────┼────────────────┤
│    42    │ myMacbook  │ 1.5.0   │ 12             │
│   188    │ workLaptop │ 1.5.0   │ 4              │
│   203    │ phone      │ 1.4.2   │ 2              │
└──────────┴────────────┴─────────┴────────────────┘

whispering
┌──────────┬────────────┐
│ clientID │ deviceName │
├──────────┼────────────┤
│    55    │ myMacbook  │
└──────────┴────────────┘

# Narrowed: workspace header elided
$ epicenter peers -w tabManager
┌──────────┬────────────┬─────────┬────────────────┐
│ clientID │ deviceName │ version │ activeTabCount │
├──────────┼────────────┼─────────┼────────────────┤
│    42    │ myMacbook  │ 1.5.0   │ 12             │
│   188    │ workLaptop │ 1.5.0   │ 4              │
│   203    │ phone      │ 1.4.2   │ 2              │
└──────────┴────────────┴─────────┴────────────────┘

$ epicenter peers
no peers connected

# Local invocation: unchanged
$ epicenter run tabs.close --tab-ids 1 2 3
closed 3 tabs

# Remote: three target modes
$ epicenter run --peer myMacbook tabs.close --tab-ids 1 2 3       # bare → deviceName
closed 3 tabs on myMacbook

$ epicenter run --peer deviceName=workLaptop tabs.close ...        # k=v → explicit field
closed 3 tabs on workLaptop

$ epicenter run --peer 42 tabs.close ...                           # digits → clientID
closed 3 tabs on clientID 42

# Error ergonomics
$ epicenter run --peer mymacbook tabs.close
error: no peer matches "mymacbook"
did you mean: myMacbook?

$ epicenter run --peer MACBOOK tabs.close
error: no peer matches "MACBOOK"
multiple peers match case-insensitively:
  myMacbook        (42)
  workMacbook      (188)

$ epicenter run --peer ghost tabs.close
error: no peer matches "ghost"
run `epicenter peers` to see connected peers

$ epicenter run --peer ghost tabs.close -w tabManager
error: no peer matches "ghost" in workspace tabManager
run `epicenter peers -w tabManager` to see connected peers

$ epicenter run --peer myMacbook tabs.closeAll
error: ActionNotFound "tabs.closeAll" on myMacbook (42, v1.4.2)
       local version: 1.5.0

$ epicenter run --peer myMacbook tabs.close --tab-ids 1
error: timeout after 5000ms waiting for peer myMacbook
```

All non-success paths exit `1`.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Schema source | Local config only | CLI and peer share the same workspace package in practice. Drift surfaces as `ActionNotFound`. |
| Sync connection | Reuse `entry.handle.sync` | Factory already attaches sync + auth + awareness via `attachSessionUnlock`. The CLI is already a peer. |
| Target resolution | Three modes, no overlap | `all digits` → clientID • `contains '='` → field match • `else` → `deviceName` match |
| Fuzzy fallback | Case-insensitive exact, not Levenshtein | Catches the common typo (capitalization) without risking wrong suggestions |
| Miss-with-no-suggestion | Point to `epicenter peers` | Teaches the discovery command; no guessing |
| Peer enumeration | `console.table` per workspace | Homogeneous schema within a workspace; heterogeneous across |
| Column order | `clientID` first; rest alphabetical | Framework-owned column is anchored; user columns stable |
| Device naming | Convention, privileged by CLI | Framework stays arbitrary K/V. CLI leans on `deviceName` for bare-match ergonomics. |
| Settle timing | `run --peer`: bounded poll • `peers`: fixed 500ms window | Target-known case polls deterministically; enumeration is best-effort snapshot |
| Timeout | 5000ms default, `--timeout <ms>` override | Standard; adjustable per invocation |
| Exit codes | Flat: `0` success, `1` any failure | Granularity only when a real script needs it |
| Peer row order | `clientID` ASC | Stable across runs; scripts get determinism |
| Process exit | Await `sync.whenDisposed` before `process.exit` | Prevents stale awareness on other peers after the CLI returns |
| CLI identity | Silent by default | `--announce` deferred as non-goal; CLI is ephemeral |

## Target Resolution

```
--peer 42                    → all digits          → clientID (numeric)
--peer deviceName=myMacbook  → contains '='        → match that field exactly
--peer myMacbook             → else                → match `deviceName` exactly

miss paths:
  exact miss + unique case-insensitive match  → "did you mean: <actual>?"
  exact miss + multiple case-insensitive hits → "multiple peers match case-insensitively: ..."
  exact miss + no case-insensitive match      → "run `epicenter peers` to see connected peers"

edge:
  --peer key=val=with=equals   → split on first '='. key="key", value="val=with=equals"
  --peer 42 when deviceName="42" → routes to clientID; escape with `--peer deviceName=42`
```

## Render Rules (`peers`)

```
1. Group peers by workspace             (framework-owned)
2. Omit workspace header if -w narrows to one
3. Within a workspace:
   - column #1: clientID
   - remaining columns: union of awareness keys in that workspace, alphabetical
   - rows: sorted by clientID ASC
   - empty cells render blank
4. "no peers connected" when nothing connects within the 500ms settle window
```

## Settle Timing

| Command | Barrier |
| --- | --- |
| `peers` | `await sync.whenConnected; await sleep(500)` then snapshot `awareness.getStates()` |
| `run --peer <X>` | `await sync.whenConnected`, then poll `awareness.getStates()` until `findPeer(X)` resolves or `--timeout` elapses |

`handle.whenReady` alone is insufficient. It resolves on local IDB load, not remote awareness.

## Process Lifecycle

```
1. openHandle()                        (factory, attachSync starts supervisor)
2. await handle.whenReady              (local IDB)
3. --peer only: await whenConnected + settle
4. invoke (local dispatchAction or handle.sync.rpc)
5. print result / error
6. handle.dispose()                    (sync return; async teardown in background)
7. await handle.sync.whenDisposed      ← prevents stale awareness on peers
8. process.exit(code)
```

## Non-Goals (v1)

- **`list --peer`**: local `list` is authoritative.
- **Remote discovery RPC / `__actions__.list`**: add when real users hit version skew.
- **`--all-peers` / `--peer='*'`**: broadcast UX (exit codes, matchers, consistency) needs real use cases before designing.
- **`attachDeviceName` primitive**: two apps use the pattern today; extract on third adoption.
- **`createRpcDispatch` helper**: current inline form `rpc: { dispatch: (a, i) => dispatchAction(actions, a, i) }` is self-documenting; DRY savings aren't real.
- **`--announce` CLI identity**: CLI stays silent; revisit if debugging pain appears.
- **Levenshtein fuzzy match**: case-insensitive fallback + `epicenter peers` pointer covers real typos.
- **`--json` output**: next spec; scripting UX decision independent of this one.
- **Direct peer-to-peer**: all RPC flows through the sync room's DO.
- **Cross-time data attribution**: apps needing stable `deviceId` roll their own (e.g., tab-manager's `devices` table).

## Identity Model

| Layer | Stability | Readability | Source |
| --- | --- | --- | --- |
| `clientID` | Ephemeral (per connection) | Numeric | Yjs, always present |
| `deviceName` (convention) | Stable (persisted by app) | Readable, user-editable | App declares in awareness defs, publishes on init |
| `deviceId` (app-specific) | Stable across renames | Not readable (NanoID) | Apps add on top if needed (e.g. tab-manager `devices` table) |

## Convention (optional, inline)

Apps that want `--peer myMacbook` ergonomics:

```ts
// epicenter.config.ts
const awareness = attachAwareness(ydoc, {
  ...yourDefs,
  deviceName: type('string'),
});

// On init:
const name = storage.get('deviceName') ?? generateDefaultName();
storage.set('deviceName', name);
awareness.setLocalField('deviceName', name);
```

Apps that also want version diagnostics in error messages:

```ts
const awareness = attachAwareness(ydoc, {
  ...yourDefs,
  deviceName: type('string'),
  version: type('string'),
});
awareness.setLocalField('version', PACKAGE_VERSION);
```

## Implementation Plan

TDD against the terminal sessions above. Implementer picks test infrastructure (stub handle, cross-wired `FakeWebSocket` peers, or subprocess) per case: whichever is cheapest.

### Phase 1: `peers` (shipped)

- [x] **1** `packages/cli/src/util/find-peer.ts`: resolver with modes (numeric / `k=v` / `deviceName`) and miss-shape union.
- [x] **2** ~~`util/render-peers.ts`~~: inlined into `commands/peers.ts` (intentional; single consumer).
- [x] **3** `packages/cli/src/commands/peers.ts`: iterate entries (respect `-w`), `await sync.whenConnected`, 500ms settle, render. "no peers connected" when empty.
- [x] **4** Registered in `cli.ts`.
- [x] **5** Unit tests for each resolver mode + each miss shape (`find-peer.test.ts`).

### Phase 2: `run --peer` (shipped)

- [x] **6** ~~`util/peer-option.ts`~~: `peerOption` inlined in `run.ts` (intentional; single consumer).
- [x] **7** `--timeout` option, default 5000ms.
- [x] **8** In `run.ts`: when `--peer` set, `await sync.whenConnected`, poll awareness until resolve-or-timeout, call `handle.sync.rpc(clientId, path, input, { timeout })`, format result/error.
- [x] **9** `emitRpcError`: handles `ActionNotFound`, `Timeout`, `PeerOffline`, `ActionFailed`, `Disconnected` with deviceName/clientID/version where present.
- [x] **10** Process-exit: `await handle.sync.whenDisposed` before `process.exit`.
- [x] **11** Integration tests in `run.test.ts` + `peers.test.ts`.

### Phase 3: Convention docs (deferred)

- [ ] **12** Short section in `packages/workspace/README.md`: `deviceName` convention + optional `version` for diagnostics. *Currently documented as JSDoc in `packages/cli/src/util/handle-attachments.ts`; revisit when a second app adopts the convention.*

## Success Criteria

- [ ] Every terminal session in "Terminal Sessions" produces the output shown.
- [ ] `run` and `list` (no `--peer`) are unchanged behaviorally and performance-wise.
- [ ] An app opts into `--peer <name>` ergonomics in ≤4 lines (awareness def + init publish).
- [ ] Process exits cleanly after CLI return; peer awareness on other devices reflects disconnect within normal sync latency.

## References

- `specs/20260423T010000-unify-dot-path-format.md`: prerequisite (shipped)
- `packages/sync/src/protocol.ts:449-621`: RPC wire protocol
- `packages/workspace/src/document/attach-sync.ts:779-840`: `sync.rpc` client
- `apps/api/src/base-sync-room.ts:368-442`: DO-side RPC routing
- `packages/workspace/src/shared/actions.ts:471-488`: receiver-side dispatch
- `packages/workspace/src/document/attach-awareness.ts`: typed awareness wrapper
- `apps/tab-manager/src/lib/device/device-id.ts`: example device identity pattern
