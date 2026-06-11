# Head Doc + Epoch Strategy for `gc: false` Workspaces

**Date**: 2026-04-23
**Status**: queued
**Author**: AI-assisted (conversation with Braden)
**Branch**: none yet

## Overview

Retrofit the archived HeadDoc/epoch pattern onto workspaces that currently construct a single `new Y.Doc({ gc: false })` (Fuji today, likely others). Add helpers: `attachStandardProviders`, `attachHead`, `defineMapTable`: and commit to **hard reload on epoch change** instead of in-place doc swapping. This unlocks snapshot/rollback and schema-migration epochs without the lifecycle complexity that killed the original design.

## Motivation

### Current State

`apps/fuji/src/lib/client.svelte.ts:32-47`:

```ts
export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });

  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, fujiTables);
  const kv = encryption.attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, { url: ..., awareness: awareness.raw, requiresToken: true });
  // ...
}
```

One flat doc. `gc: false` is already set, which means the *primitive* for snapshots works (you can `Y.encodeStateAsUpdate` any time): but there's nothing built on top of it.

### Problems

1. **No snapshots or rollback.** The user has `gc: false` paying the storage cost but getting none of the time-travel benefit.
2. **No schema-migration story.** A breaking change to `fujiTables` has nowhere to go except "hope existing data is compatible."
3. **Boilerplate repeats per app.** Every `open*` function re-wires idb + broadcast + sync + awareness by hand. Honeycrisp and Fuji already diverge on the small details.
4. **YKeyValueLww + `gc: false` = ~800× storage bloat** (`docs/articles/archived-head-registry-patterns.md:391`). If we're committing to `gc: false`, table storage must move to Y.Map.

### Desired State

```ts
export function openFuji() {
  const head = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
  const headApi = attachHead(head, { url, getToken: () => auth.token });
  await headApi.whenReady;

  const epoch = headApi.getEpoch();
  const ydoc = new Y.Doc({ guid: `epicenter.fuji-${epoch}`, gc: false });
  const providers = attachStandardProviders(ydoc, { url, getToken: () => auth.token });

  const encryption = attachEncryption(ydoc);
  const tables = {
    entries: defineMapTable(ydoc, 'entries', EntrySchema),
    // ...
  };

  return { head: headApi, ydoc, tables, providers, /* ... */ };
}

// Epoch change = reload. No in-place swap.
async function rollbackTo(snapshotBytes: Uint8Array) {
  await stashSnapshotForBoot(snapshotBytes);
  headApi.bumpEpoch();
  location.reload();
}
```

## Research Findings

All documented in prior conversation and `docs/articles/archived-head-registry-patterns.md`. Key points recalled here:

| Pattern | What it solves | Pitfall |
|---|---|---|
| Per-client MAX epoch map | Concurrent epoch bumps without losing one | Need MAX aggregation, not a counter |
| Content-doc guid = `${id}-${epoch}` | Clean rollback: old epoch's IDB/sync room untouched | Every attach* must re-run when epoch changes |
| YKeyValueLww + `gc: false` | Append-log history | ~800× storage bloat: unusable |
| Y.Map + `gc: false` | In-place overwrite | ~2× bloat: acceptable (loses LWW timestamp metadata, rarely needed) |

**Key finding**: The original archived design died on the "every attach* must re-run when epoch changes" clause. Every open subscription, every Svelte `$effect`, every cached derived value captured a reference to `tables.entries` on the old content doc. Swapping in place = silent stale-read bugs forever.

**Implication**: Either pay that cost, or reload. Reload is the honest answer for a desktop/Tauri/web app where the user initiates epoch changes rarely and deliberately.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Head doc structure | `Y.Map('epochs')` (clientID → number) + `Y.Map('meta')` | From archived spec; CRDT-safe MAX aggregation |
| Content doc guid | `${workspaceId}-${epoch}` | Per-epoch IDB + sync room isolation |
| Epoch-change strategy | **Hard `location.reload()`** | Correctness by construction; no stale-reference bugs |
| History viewing | **Separate read-only viewer doc**, not live workspace epoch-swap | Decouples "browse history" from "own the workspace" |
| Table storage | `Y.Map` keyed by row id, replacing YKeyValueLww | 400× storage improvement under `gc: false` |
| Snapshots | Raw files (`Y.encodeStateAsUpdate` bytes on disk) | No Yjs structure needed; trivial to list/restore |
| Registry | **Skipped for single-workspace apps** like Fuji | YAGNI; add when an app has multiple workspaces |
| Head sync | **Deferred**: head is local-only for now | Tiny doc, rare writes; cross-device epoch reconciliation can wait |
| `attachStandardProviders` shape | Composition function returning `{ idb, awareness, sync, whenReady }` | Parallel to existing `attach*` style; not a class, not a factory |
| `attachHead` composition | Calls `attachStandardProviders` internally, layers on epoch/meta helpers | Head IS a standard-provider doc + extras: compose, don't duplicate |

## Architecture

### Doc layout

```
┌──────────────────────────────────────────┐
│ HEAD DOC                                 │
│ guid: "epicenter.fuji"                   │
│   Y.Map('epochs')  clientID → number     │
│   Y.Map('meta')    name, icon, desc      │
│ providers: idb + broadcast (+ sync TBD)  │
└────────────────┬─────────────────────────┘
                 │ getEpoch() = MAX(epochs.values())
                 ▼
┌──────────────────────────────────────────┐
│ CONTENT DOC                              │
│ guid: "epicenter.fuji-{epoch}"           │
│   Y.Map('table:entries')  id → row       │
│   Y.Map('table:...')                     │
│   Y.Map('kv')                            │
│ providers: idb + broadcast + sync + awa  │
└──────────────────────────────────────────┘
```

### Epoch-change flow (rollback example)

```
STEP 1: User clicks "Restore snapshot"
────────────────────────────────────────
Read snapshot bytes from {epoch}/snapshots/{ts}.ysnap
Write to boot-intent file: pendingRestore = { targetEpoch, snapshotPath }

STEP 2: Bump epoch on head doc
────────────────────────────────────────
headApi.bumpEpoch()  // MAX + 1, persisted via head's idb provider

STEP 3: location.reload()
────────────────────────────────────────
All JS state gone. No stale references possible.

STEP 4: Boot path reads pendingRestore
────────────────────────────────────────
If set: construct ydoc at new epoch, Y.applyUpdate(ydoc, snapshotBytes),
clear pendingRestore, proceed as normal.
Otherwise: normal boot with current epoch.
```

### History viewing flow (no epoch change)

```
User opens /history/{snapshotId} (route or separate window)
    ▼
new Y.Doc({ guid: 'viewer', gc: false })  // throwaway
Y.applyUpdate(viewerDoc, readSnapshotBytes(snapshotId))
    ▼
Render tables read-only from viewerDoc
    ▼
On close: viewerDoc.destroy()
```

The live workspace is untouched. No epoch machinery involved.

## Helper Contracts

### `attachStandardProviders(ydoc, opts)`

Yes, this should be a composition function. It's the "every synced doc needs these four things" shortcut.

```ts
export function attachStandardProviders(ydoc: Y.Doc, opts: {
  url: (docId: string) => string;
  getToken: () => string | null;
  requiresToken?: boolean;
}) {
  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const awareness = attachAwareness(ydoc, {});
  const sync = attachSync(ydoc, {
    url: opts.url,
    waitFor: idb.whenLoaded,
    awareness: awareness.raw,
    requiresToken: opts.requiresToken ?? false,
  });
  return { idb, awareness, sync, whenReady: idb.whenLoaded };
}
```

Apps that want to customize (e.g. local-only, no sync) skip this helper and call `attachIndexedDb` etc. directly. Opting out is one-level, not hidden behind a flag.

### `attachHead(ydoc, opts)`

Layers epoch/meta on top of `attachStandardProviders`. One-call setup for the head.

```ts
export function attachHead(ydoc: Y.Doc, opts: ProviderOpts) {
  const providers = attachStandardProviders(ydoc, opts);
  const epochsMap = ydoc.getMap<number>('epochs');
  const metaMap = ydoc.getMap('meta');

  return {
    ...providers,
    getEpoch: () => Math.max(0, ...epochsMap.values()),
    bumpEpoch() {
      const next = Math.max(0, ...epochsMap.values()) + 1;
      epochsMap.set(ydoc.clientID.toString(), next);
      return next;
    },
    observeEpoch(cb: (n: number) => void) {
      const handler = () => cb(Math.max(0, ...epochsMap.values()));
      epochsMap.observe(handler);
      return () => epochsMap.unobserve(handler);
    },
    meta: {
      get: () => metaMap.toJSON(),
      set: (m: Partial<Meta>) => ydoc.transact(() => {
        for (const [k, v] of Object.entries(m)) metaMap.set(k, v);
      }),
    },
  };
}
```

### `defineMapTable(ydoc, name, schema)`

Replaces YKeyValueLww-backed tables for `gc: false` workspaces. One `Y.Map` per table, keys = row ids, values = validated rows.

```ts
export function defineMapTable<T>(ydoc: Y.Doc, name: string, schema: Type<T>) {
  const map = ydoc.getMap<T>(`table:${name}`);
  return {
    get: (id: string) => map.get(id),
    set: (id: string, row: T) => map.set(id, schema.assert(row)),
    delete: (id: string) => map.delete(id),
    has: (id: string) => map.has(id),
    all: () => Array.from(map.entries()).map(([id, row]) => ({ id, ...row })),
    observe: (cb: () => void) => {
      map.observe(cb);
      return () => map.unobserve(cb);
    },
  };
}
```

**Trade-off accepted**: loses LWW timestamp metadata. Y.Map already has last-write-wins semantics at the op level, which is what most tables actually need. Field-level concurrent editing (two users editing different fields of the same row simultaneously) requires nested `Y.Map` values: add per-table when needed, don't make it the default.

## Implementation Plan

### Phase 1: Helpers in `@epicenter/workspace`

- [ ] **1.1** Add `attachStandardProviders(ydoc, opts)` to the package's public surface
- [ ] **1.2** Add `attachHead(ydoc, opts)` (composes `attachStandardProviders` + epoch/meta)
- [ ] **1.3** Add `defineMapTable(ydoc, name, schema)` alongside existing `defineTable`
- [ ] **1.4** Decide: does `attachHead` wire sync, or is head local-only by default? (See Open Questions)

### Phase 2: Fuji migration (first consumer)

- [ ] **2.1** Wrap `openFuji` so it constructs head doc first, reads epoch, then content doc
- [ ] **2.2** Migrate `fujiTables` entries to `defineMapTable`
- [ ] **2.3** Verify `applySession` still works: only content-doc sync needs token; head is session-independent (or re-check if head syncs)
- [ ] **2.4** Unblock the module-scope `export const workspace = openFuji()`: head resolution is async (see Open Questions)

### Phase 3: Snapshot + rollback UX

- [ ] **3.1** File layout `{workspaceId}/{epoch}/snapshots/{ts}.ysnap`: plain bytes
- [ ] **3.2** `createSnapshot(label)` and `listSnapshots(epoch)` functions
- [ ] **3.3** Boot-intent file mechanism (`pendingRestore` on disk, read at startup)
- [ ] **3.4** Rollback = write intent → `bumpEpoch` → `location.reload()`

### Phase 4: History viewer

- [ ] **4.1** Route or window that constructs throwaway `gc: false` ydoc from a snapshot
- [ ] **4.2** Read-only table rendering against the viewer doc
- [ ] **4.3** Decide: same window + route swap, or separate Tauri window?

### Phase 5: Honeycrisp + other apps

- [ ] **5.1** Audit other `open*` functions, migrate to the helpers
- [ ] **5.2** Table storage audit: any remaining YKeyValueLww under `gc: false` is a latent storage bomb

## Edge Cases

### Module-scope singleton breaks under async head resolution

1. Fuji does `export const workspace = openFuji();` synchronously at module top (`client.svelte.ts:97`).
2. With head doc, we need `await head.whenReady` before we know which epoch's content doc to open.
3. Either `openFuji` returns a promise (all consumers `await`) or we use the sync-construction-async-property pattern (there's a skill for it).

### Unsaved UI state during reload

1. User has a half-written form, clicks "Restore snapshot."
2. `location.reload()` wipes it.
3. **Expected**: confirmation dialog before any epoch-change action. This is correct desktop-app UX, not a regression.

### Concurrent epoch bumps across devices

1. Device A and Device B both click "rollback" while head is syncing.
2. Each writes to `epochs[their-clientID]`. MAX aggregation resolves.
3. Winner: whichever bumped to a higher number. Loser's content-doc IDB on their device is for a now-orphaned epoch.
4. **Mitigation**: if head doesn't sync (Phase 1 default), this can't happen cross-device: only per-device.

### Boot when `pendingRestore` file is stale / corrupt

1. Intent file exists but points to a snapshot that no longer exists.
2. **Expected**: log error, clear intent, boot normally at current epoch. Don't crash.

### Viewing history for an epoch whose content-doc IDB was deleted

1. User cleared "all site data" but snapshot files still exist.
2. Viewer reads from snapshot file, not IDB: should still work.
3. **Expected**: history viewer never depends on content-doc IDB; only on snapshot files.

## Open Questions

1. **Does the head doc sync or stay local-only?**
   - Options: (a) local-only: simplest, no cross-device epoch reconciliation; (b) sync: users' devices converge on same epoch automatically.
   - **Recommendation**: local-only for v1. Cross-device "auto-migrate me to epoch 4" is a UX hazard anyway (unexpected data shape change with no confirmation). Users opt in per device.

2. **Module-scope singleton vs async factory?**
   - Options: (a) `export const workspace = await openFuji()` with top-level await; (b) sync-construction-async-property pattern with a `whenReady` barrier and render gate; (c) explicit `setupWorkspace()` called from `+layout.svelte`.
   - **Recommendation**: (b). The skill `sync-construction-async-property-ui-render-gate-pattern` exists for exactly this.

3. **Should `defineMapTable` support nested `Y.Map` rows for field-level collab?**
   - Options: (a) only plain-object rows; (b) opt-in via a flag; (c) separate helper (`defineNestedMapTable`).
   - **Recommendation**: (a) for v1. Most tables don't need it. Add (c) later when a concrete use case appears.

4. **What's the trigger for bumping an epoch: migration, rollback, both, user-initiated?**
   - Options: (a) only explicit user action (restore snapshot, "start over"); (b) automatic on schema mismatch at boot; (c) both.
   - **Recommendation**: (a) for v1. Automatic schema migration is a separate, larger spec.

5. **Does `attachStandardProviders` hardcode `requiresToken: false` default?**
   - Fuji currently uses `requiresToken: true`. Honeycrisp may differ.
   - **Recommendation**: no default: make it required in `opts` so consumers consciously choose.

6. **Where do snapshot files live: per-epoch folder, or flat keyed by snapshot id?**
   - Options: (a) `{workspaceId}/{epoch}/snapshots/{ts}.ysnap`: epoch-scoped; (b) `{workspaceId}/snapshots/{id}.ysnap` with metadata pointing at origin epoch.
   - **Recommendation**: (a). Matches the archived doc's layout, clearer on disk, easier to garbage-collect an old epoch wholesale.

## Success Criteria

- [ ] `attachStandardProviders`, `attachHead`, `defineMapTable` exported from `@epicenter/workspace` with types
- [ ] Fuji migrated and functionally identical for users who never touch snapshots (epoch stays at 0)
- [ ] Creating a snapshot + restoring it via reload works end-to-end in Fuji
- [ ] History viewer opens a past snapshot read-only without affecting live workspace
- [ ] No YKeyValueLww remains under a `gc: false` ydoc anywhere in the app
- [ ] Storage bloat measured and documented (~2× expected for Y.Map + `gc: false`)
- [ ] `applySession` still works unchanged for the content doc; head-doc lifecycle documented

## References

- `docs/articles/archived-head-registry-patterns.md`: original three-doc design, Y.Map vs YKeyValueLww storage numbers (`:391`), epoch MAX pattern (`:65-86`)
- `apps/fuji/src/lib/client.svelte.ts:32-97`: current single-doc shape, first migration target
- `apps/honeycrisp/src/lib/client.svelte.ts`: second migration target, compare for shared `openX` shape
- `packages/workspace/src/`: home for the three new helpers
- `.claude/skills/sync-construction-async-property-ui-render-gate-pattern/`: pattern for Open Question #2
- `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: prior research on multi-doc architectures
