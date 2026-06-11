# Drop manifest from awareness: collapse to argless `system.describe`

**Status**: Shipped; API details superseded
**Date**: 2026-04-26
**Supersedes**: `specs/20260426T220000-system-describe-wire-trim.md` on the awareness-wire-shape and `system.*` API questions. The earlier spec trimmed `input` from the wire manifest while keeping a "lite" manifest in awareness; this spec finishes the job by removing the manifest from awareness entirely.

**Review 2026-05-01**: The core change shipped. Awareness carries peer
identity only, and action discovery is fetched on demand through argless
`system.describe`. Later API work replaced the proposed `peerSystem()` helper
with `createRemoteClient({ peerDirectory, rpc }).describe(peerId)`. The old
`epicenter list --peer` detail flow is no longer the current CLI model.

## Why this exists

The previous spec (`20260426T220000`) trimmed `input` from the wire manifest, getting us 70% of the way to "awareness only carries awareness-shaped data." It left behind a lite manifest (`{type, title, description}` per action) in awareness for "fast enumeration," and split introspection into two RPC operations (`system.describe(path)` for input fetch, with the lite manifest serving the enumerate role).

Two findings made the lite-manifest residue indefensible:

1. **y-protocols official guidance** (verified via deepwiki on `yjs/y-protocols`): "for larger, relatively static per-peer metadata (1-10kB of capability manifests or profile data), experienced Yjs users would typically store this information in a shared Yjs document (Y.Doc) itself, rather than in awareness states." Even the lite manifest (~800B/peer × N²/15s) violates this.

2. **Codebase audit confirmed zero app consumers** of the manifest. `apps/whispering`, `apps/api`, `apps/tab-manager`: none of them read `device.offers` or call cross-peer RPC. The entire cross-peer story is exercised by the CLI and workspace tests. The manifest is paying broadcast costs for one consumer.

The clean answer: **delete `device.offers` entirely; introspection becomes a single argless RPC that returns the full local action tree on demand.**

## Decision

```
Awareness state per peer (was):           Awareness state per peer (now):
─────────────────────────────             ─────────────────────────────
device: {                                 device: {
  id, name, platform,                       id, name, platform,
  offers: { ...lite manifest... }         }
}
```

```
RPC system actions (was):                 RPC system actions (now):
─────────────────────────────             ─────────────────────────────
system.describe({ path }) → ActionMeta    system.describe() → ActionManifest
                                          // no args; returns full local tree
```

One operation, one mode. Argless. Returns the entire local manifest including `input` schemas. CLI calls once per `epicenter list --peer <name>` invocation, renders tree from the response, looks up paths locally for detail mode.

### Why argless `system.describe()` over `system.list` + `system.describe(path)`

Splitting into "list paths" + "describe one" optimizes for "trees so large you can't fetch them all." For Epicenter's scale (~20-50 actions per app), the entire tree fits in ~3kB. Pay one RTT, fetch everything, look up locally. The split is engineering-for-imaginary-scale.

When the trip wire fires (an app with 500+ actions), introduce `system.list()` as an additive operation. For now, one operation is the simplest possible API.

### Why `peerSystem(sync, deviceId)` as a separate proxy

The previous spec considered merging `system: { describe }` into the typed `peer<TActions>` proxy, giving consumers `peer<MyActions>(sync, 'mac').system.describe()`. This pollutes the user's `TActions` type with infrastructure surface. Cleaner: a separate function for system access.

```ts
// User actions: typed by the app:
peer<MyActions>(sync, 'mac').tabs.close({...})

// System actions: universal across all peers:
peerSystem(sync, 'mac').describe()
```

Two surfaces, two functions, zero type pollution.

## Wire-cost change (final)

| Configuration | Per-peer awareness payload | N=10 wire @ 15s |
|---|---|---|
| Original | ~10kB | ~6.7 kB/s |
| After 220000 spec | ~800B | ~530 B/s |
| **After this spec** | **~150B** | **~100 B/s** |

Plus: introspection RTT cost moves from "every peer paying 800B every 15s" to "one CLI invocation paying ~3kB on demand." Total bytes-over-time drop ~100x for typical workspaces.

## Files changed

| # | File | Change |
|---|---|---|
| 1 | `packages/workspace/src/shared/action-manifest.ts` | **Delete entire file.** No longer needed: wire shape is gone. |
| 2 | `packages/workspace/src/shared/action-manifest.test.ts` | **Delete entire file.** |
| 3 | `packages/workspace/src/document/standard-awareness-defs.ts` | Drop `ActionManifestEntrySchema` (entire const). Drop `offers` field from `PeerDevice`. Drop the `ActionManifestEntrySchema` JSDoc. Update `PeerDevice` JSDoc to reflect presence-only role. |
| 4 | `packages/workspace/src/document/attach-sync.ts` | (a) Remove `actionManifest()` call (no `offers` published). (b) Move the `system.*` user-namespace validator from `action-manifest.ts walk()` to `attach-sync.ts`: reject if user `Actions` has top-level `system` key: throw at attach time with a clear message. (c) Change `system.describe` to argless: returns the full local `ActionManifest` (= `Record<string, ActionMeta>` with `input` retained). (d) Add inline helper `collectActionManifest(actions: Actions): ActionManifest` that walks the tree and returns dot-paths to full local `ActionMeta`. |
| 5 | `packages/workspace/src/index.ts` | Remove `ActionManifest` and `actionManifest` exports. Add `peerSystem` export. Keep `ActionMeta` (still the local-side shape). |
| 6 | `packages/workspace/src/rpc/peer.ts` | No changes: `peer<T>` proxy unchanged. |
| 7 | `packages/workspace/src/rpc/peer-system.ts` (new) | Typed proxy for system actions. ~30 LoC. Calls `sync.rpc(clientId, 'system.describe', undefined)` and returns `Promise<Result<ActionManifest, RpcError>>`. Mirrors `peer()` shape. |
| 8 | `packages/cli/src/commands/list.ts` | (a) Replace all reads of `device.offers` with a single `await peerSystem(sync, deviceId).describe()` call at the top of the peer-mode flow. (b) Render tree from the fetched manifest. (c) Detail mode looks up the path in the same fetched manifest: no second RTT. (d) Remove `actionManifest`/`ActionManifest` imports. |
| 9 | `packages/cli/src/commands/run.ts` | If it reads the manifest at all (audit said it imports `actionManifest`), refactor to use `peerSystem` or fetch on demand. |
| 10 | `packages/cli/src/commands/list.test.ts` | Update mocks: `peerSystem.describe()` returns the manifest fixture. Drop `device.offers` fixtures. Adjust async assertions. |
| 11 | `packages/cli/test/e2e-list-peer-detail.test.ts` | Update e2e: assert detail rendering still works after the single fetch. |
| 12 | `packages/workspace/src/document/system-describe.test.ts` | Update tests: argless call returns full manifest with `input` retained for known paths; reserved-namespace throws now caught at `attachSync` time, not `actionManifest` walk time. |
| 13 | `packages/workspace/src/document/attach-sync.test.ts` | Update awareness-state assertions: `localState.device` no longer has `offers`. |

## Dead code to delete (clean break)

- `actionManifest()` function: gone with the file.
- `ActionManifest` type alias: gone with the file.
- `ActionManifestEntrySchema` arktype const: gone.
- `offers` field on `PeerDevice`: gone.
- The `system.describe(path)` parameterized form: replaced by argless.
- Any internal helper that derived "lite" manifest entries (e.g., the `walk()` function inside `action-manifest.ts`): gone with the file.
- Stale specs that document the old wire shape: leave as historical record (don't delete; they accurately describe what existed at their date).

## Phases

### Phase 1: Delete the manifest infrastructure

- [x] **1.1** Delete `packages/workspace/src/shared/action-manifest.ts` and its test.
- [x] **1.2** In `standard-awareness-defs.ts`: drop `ActionManifestEntrySchema`, drop `offers` from `PeerDevice`, update JSDoc to reflect presence-only role.
- [x] **1.3** In `index.ts`: remove `actionManifest` and `ActionManifest` exports.
- [x] **1.4** In `attach-sync.ts`: remove `actionManifest()` call from the `setLocal({ device })` block; remove the `actionManifest` import.
- [x] **1.5** Move the user-namespace validator from the deleted `walk()` to `attach-sync.ts`: at the top of `attachSync()`, after `userActions = config.actions ?? docActions`, throw if `userActions && 'system' in userActions` with the clear message.
- [x] **1.6** Verify TypeScript compiles: `bun x tsc --noEmit -p packages/workspace`. Expected to fail in `attach-sync.ts` (system.describe still has path arg) and CLI (still imports deleted things). Continue to phase 2.

### Phase 2: Argless `system.describe` + peerSystem proxy

- [x] **2.1** In `attach-sync.ts`: change `system.describe` handler to argless. Implement `collectActionManifest(actions: Actions): ActionManifest` inline (walks tree, returns flat dot-path → local ActionMeta map with `input` retained). Handler body: `() => collectActionManifest(userActions ?? {})`.
- [x] **2.2** Create `packages/workspace/src/rpc/peer-system.ts`. Export `peerSystem(sync: SyncAttachment, deviceId: string)` returning `{ describe(): Promise<Result<ActionManifest, RpcError>> }`. Mirrors `peer()`: find peer by deviceId, race against peer-removed signal, dispatch `sync.rpc(clientId, 'system.describe', undefined)`.
- [x] **2.3** Re-export `peerSystem` from `index.ts`. Re-export `ActionManifest` type (it's still useful) but sourced from `actions.ts` or a new local definition: ensure it doesn't reference the deleted file.
- [x] **2.4** Update `system-describe.test.ts`: assert argless call returns full manifest including `input` schemas. Assert reserved-namespace test now fails at `attachSync()` call site, not at manifest-walk time. Add test for `peerSystem.describe()`.
- [x] **2.5** Run `bun test packages/workspace`. All pass.

### Phase 3: CLI consumer rewrite

- [x] **3.1** In `list.ts`: at the top of peer-mode handling, fetch the manifest once via `await peerSystem(sync, deviceId).describe()`. Treat `RpcError` paths gracefully (render "schema unavailable" footer instead of crashing).
- [x] **3.2** Remove `device.offers` reads. Remove `actionManifest` / `ActionManifest` imports: replace with the type re-exported from `index.ts` (or import directly from where it lives now).
- [x] **3.3** Render tree from fetched manifest. Detail mode looks up path locally in the same fetched manifest object: no second RTT.
- [x] **3.4** In `run.ts`: same treatment (fetch via `peerSystem` if it needs the manifest).
- [x] **3.5** Update `list.test.ts`: mock `peerSystem.describe()` instead of constructing fake `device.offers`. Adjust async wiring.
- [x] **3.6** Update `e2e-list-peer-detail.test.ts`: detail mode still renders input fields, now from a single fetched manifest.
- [x] **3.7** Run `bun test packages/cli`. All pass.

### Phase 4: Awareness assertions + final verification

- [x] **4.1** Update `attach-sync.test.ts`: any test asserting on `localState.device.offers`: drop the assertion or invert it (`expect(device).not.toHaveProperty('offers')`).
- [x] **4.2** Run full `bun test`. All pass (modulo pre-existing unrelated failures noted in the previous spec's report).
- [x] **4.3** Grep `actionManifest|ActionManifest|ActionManifestEntrySchema|device\.offers` across `packages/` and `apps/`: should produce zero hits in production code (test files / specs / docs are fine to mention historically).
- [x] **4.4** Measure: write a quick unit test that builds an awareness state for a representative `PeerDevice` and asserts `JSON.stringify(state).length < 200` bytes.
- [ ] **4.5** Manual smoke (optional): connect two workspaces locally; run `epicenter list --peer <name>` and `epicenter list --peer <name> <some.path>`: both render correctly. (Skipped: marked optional.)

## Acceptance criteria

- `device.offers` does not exist anywhere in the codebase.
- `actionManifest()`, `ActionManifest` (the type from the deleted file), `ActionManifestEntrySchema`: none exist.
- `system.describe` takes no arguments and returns the full local manifest including `input`.
- `peerSystem(sync, deviceId).describe()` is the public API for cross-peer manifest fetch.
- `peer<T>` proxy is unchanged; type contract for app authors is unchanged.
- Awareness payload per peer is < 200 bytes serialized.
- `bun test` green.
- `epicenter list --peer X` and `epicenter list --peer X some.path` both work end-to-end.
- User attempting to define `actions: { system: {...} }` gets a clear throw at `attachSync()` time.

## Out of scope

- `system.list()`, `system.health()`, `system.version()`: not added now. Add additively when a real consumer materializes.
- Compression: already irrelevant; ~150B awareness payload doesn't need compression.
- META protocol type 102: same reasoning as before.
- Caching `peerSystem.describe()` results: CLI is one-shot; cache wouldn't help. Apps that want caching can build it.

## Migration / breaking change notes

This is a hard wire-format break. Old peers publishing `device.offers` will continue to work (arktype is open by default: extra fields are ignored). New peers won't publish `offers` at all. Mixed-version networks during cutover: old peers' `offers` are simply ignored by new code. No coordination required.

## Open questions

None. All design decisions locked above.
