# `fromTable` Readonly View Redesign

**Date**: 2026-05-06
**Status**: Draft; refreshed 2026-05-07; risky before execution
**Author**: AI-assisted
**Branch**: feat/encrypted-local-workspace-storage
**Refresh note**: The May 7 session cleanup moved Fuji's `fromTable` usage
from `apps/fuji/src/routes/(signed-in)/state/entries.svelte.ts` and
`SignedInSessionProvider.svelte` into `apps/fuji/src/lib/session.svelte.ts`.
The implementation plan below reflects that newer shape.

## Overview

Replace `fromTable`'s `SvelteMap` mirror plus manual `[Symbol.dispose]()` with a `createSubscriber`-driven view exposing `all` and `byId(id)` that reads live from Yjs and self-disposes when no effect is reading it.

## Refresh findings: 2026-05-07

A fresh audit found the spec is still pointed at a real smell, but its first
draft was too casual about migration risk.

```txt
Still true:
  fromTable still returns a SvelteMap mirror plus Disposable.
  Direct writes to returned maps are still absent.
  Most call sites still read values(), get(id), has(id), keys(), size, or iterate.

Stale or too optimistic:
  Fuji now owns its entries view in apps/fuji/src/lib/session.svelte.ts.
  Fuji no longer has SignedInSessionProvider.svelte.
  Several wrappers have non-fromTable cleanup that must stay.
  OpenSidian relies on per-key SvelteMap tracking in filesystem comments and reads.
  OpenSidian explicitly accepts <5000 files, not only sub-1000 row tables.
```

This spec should not be executed as a mechanical "delete every dispose" pass.
Each migrated file needs a lifecycle audit first: remove only the observer
cleanup made unnecessary by `fromTable`, and keep cleanup for chat handles,
message-table observers, filesystem indexes, workspace handles, and other
resources.

## Motivation

### Current State

`packages/svelte-utils/src/from-table.svelte.ts`:

```ts
export type ReactiveTableMap<TRow extends BaseRow> = SvelteMap<string, TRow> & Disposable;

export function fromTable<TRow extends BaseRow>(table: Table<TRow>): ReactiveTableMap<TRow> {
  const map = new SvelteMap<string, TRow>();
  for (const row of table.getAllValid()) map.set(row.id, row);

  const unobserve = table.observe((changedIds) => {
    for (const id of changedIds) {
      const { data: row, error } = table.get(id);
      if (error || row === null) { map.delete(id); continue; }
      map.set(id, row);
    }
  });
  let disposed = false;
  Object.defineProperty(map, Symbol.dispose, {
    value() { if (disposed) return; disposed = true; unobserve(); },
    enumerable: false,
  });
  return map as ReactiveTableMap<TRow>;
}
```

The returned object is structurally a `SvelteMap`, which exposes `.set()`, `.delete()`, `.clear()` to consumers. Wrapper files like `apps/whispering/src/lib/state/recordings.svelte.ts` add `[Symbol.dispose]()` plumbing and `import.meta.hot.dispose(...)` to manage teardown.

This creates problems:

1. **Footgun in the type signature**: `SvelteMap` exposes write methods that, if called, get clobbered by the next observer fire. Audit shows 0 hits across the current `fromTable` bindings, but the type lies about the contract.
2. **Mirror tax**: every row is stored twice (Yjs + SvelteMap), reparsed on every Yjs change to refresh the mirror, then read from cache.
3. **Manual disposal everywhere**: 16 bindings span 15 app files, many consumers wire `[Symbol.dispose]()`, several wrapper files plumb HMR teardown via `import.meta.hot.dispose`, and some component-level cleanup remains. This spec must separate cleanup that only detaches the `fromTable` observer from cleanup that owns other resources.
4. **Mirror-cache hazards block lazier disposal**: switching to `createSubscriber` over the SvelteMap-backed design requires clearing the mirror on unsubscribe, which then leaves outside-effect reads seeing an empty cache. The mirror is the obstacle.

### Desired State

```ts
import { createSubscriber } from 'svelte/reactivity';

export function fromTable<TRow extends BaseRow>(table: Table<TRow>) {
  const subscribe = createSubscriber((update) => table.observe(update));
  return {
    get all(): TRow[] {
      subscribe();
      return table.getAllValid();
    },
    byId(id: string): TRow | undefined {
      subscribe();
      return table.get(id).data ?? undefined;
    },
  };
}
```

Two verbs. No mirror. No `Disposable`. No HMR teardown plumbing. The Yjs observer attaches when the first reader inside an effect appears and detaches a microtask after the last reader's effect tears down.

## Research Findings

### What `SvelteMap` actually is

`node_modules/.bun/svelte@5.55.1/.../reactivity/map.js`. SvelteMap stores three reactive primitives:

- `#sources: Map<key, Source<number>>`: lazy per-key signals, allocated on first `.get`/`.has` of a key.
- `#version: Source<number>`: bumped on add or delete.
- `#size: Source<number>`: bumped on add or delete.

`.values()`, `.entries()`, `forEach`, `[Symbol.iterator]` all read `#version` plus every per-key signal via `#read_all()`. The reactive plumbing is purely signal-based; SvelteMap's per-instance state (the parent `Map` and the source nodes) has no lifecycle requirement of its own. The only thing in `fromTable` that needs explicit cleanup is the `unobserve` callback, because Yjs holds a reference to the observer closure.

**Implication**: SvelteMap is doing two unrelated jobs in `fromTable`. It caches parsed rows (a mirror) and provides reactivity (signals). Replacing the mirror with live Yjs reads dissolves the disposal problem.

### What `createSubscriber` actually is

`node_modules/.bun/svelte@5.55.1/.../reactivity/create-subscriber.js`. Public, documented since Svelte 5.7.0, exported from `svelte/reactivity`.

```ts
export function createSubscriber(start: (update: () => void) => (() => void) | void): () => void
```

Returns a `subscribe()` function. When called inside a tracking effect, it registers a render effect that increments a reference counter. When the count goes 0 to 1, `start` runs and its return value is the cleanup. When the count returns to 0 (after a microtask), cleanup fires.

For `fromTable` this means the Yjs observer attaches lazily on the first reader inside an effect, detaches automatically when readers leave, and deduplicates across multiple consumers.

### What `ReactiveValue` is and why we are not using it

`node_modules/.bun/svelte@5.55.1/.../reactivity/reactive-value.js`. A 24-line class wrapping `createSubscriber` with a `.current` getter.

`node_modules/.bun/svelte@5.55.1/.../reactivity/index-client.js`:

```js
export { SvelteDate, SvelteSet, SvelteMap, SvelteURL, SvelteURLSearchParams, MediaQuery, createSubscriber };
// no ReactiveValue
```

`ReactiveValue` is **not exported**. It surfaces in `types/index.d.ts` only as the base class for `MediaQuery` and `svelte/reactivity/window` exports. Using it requires reaching into Svelte's source tree, which is the same fragility the user wants to avoid.

`createSubscriber` is the public primitive. The `.current` shape ReactiveValue provides is unnecessary if our methods do their own `subscribe()` calls; templates and `$derived` re-invoke methods on every read, which keeps reactivity live without a getter property.

### Call site audit (17 bindings, 16 app files)

| Operation | Count | Where |
|---|---|---|
| Direct WRITE (`.set`/`.delete`/`.clear`) on returned map | **0** | None |
| `[...map.values()]` inside `$derived` | 15 | Wrapper modules and Fuji's session payload |
| `.get(id)` | ~14 | Per-row access |
| `.size` | 5 | folders (semantic), 4 cosmetic counts |
| `for (const [id, row] of map)` directly | 2 | transformation-steps, fs-state |
| `.has` / `.keys` | 3 | All chat-state files |
| Passed to TanStack Table as `data` | **0** | TanStack receives derived sorted arrays |
| Re-exported as `get all() { return map }` | 4 | All whispering state files |

**Key findings**:
- The footgun is not being hit anywhere. Removing write methods costs nothing.
- The `.values()` spread is the dominant pattern. Returning a plain array beats handing back a Map.
- TanStack integration is unaffected because it consumes `$derived`-memoized arrays from the wrappers, not the raw collection.
- `.size` has one semantic use (`folders.svelte.ts:69`, next sortOrder) and four cosmetic counts; replacing with `view.all.length` works at every site.
- The two `for (const [id, row] of map)` sites can read `id` from the row object (`BaseRow.id`) and switch to `for (const row of view.all)`.

### Workspace `Table` API contract

`packages/workspace/src/document/attach-table.ts`:

```ts
get(id: string): Result<TRow | null, TableParseError>;     // re-parses on every call
getAllValid(): TRow[];                                      // walks ykv, parses every row
count(): number;                                            // O(1) on Y.Map size
has(id: string): boolean;                                   // O(1) on Y.Map
observe(callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void): () => void;
```

**Implication**: dropping the mirror moves parse cost from write-time to read-time. `parseRow` runs once per `.byId(id)` call and once per row per `.all` access.

### Cost analysis at scale

For a single observer fire reaching `N` `$derived` consumers of `view.all` over a table with `R` rows, total parse cost per write ≈ `N × R × parse_cost`.

| Workload | N | R | parse | total |
|---|---|---|---|---|
| Whispering recordings, 1 sorted view | 1 | 200 | ~1µs | 0.2ms |
| 5 active components reading | 5 | 200 | ~1µs | 1ms |
| Notes app, 1000 rows, 5 consumers | 5 | 1000 | ~1µs | 5ms |
| Pathological 10K rows, 10 consumers | 10 | 10000 | ~1µs | 100ms |

**Implication**: at the small-table end of this codebase, the cost is likely
fine. OpenSidian is the exception to treat carefully: its filesystem state
comments mention `<5000 files`, and its path helpers currently rely on
`filesMap.get(id)` creating narrow key-level dependencies. A global
`createSubscriber` view would make those reads invalidate on any table change.
That may still be acceptable, but it must be a deliberate tradeoff verified
with the OpenSidian filesystem UI, not a hidden side effect of the migration.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Lifecycle primitive | 1 evidence | `createSubscriber` from `svelte/reactivity` | Verified public export in `index-client.js`. Documented since 5.7.0. |
| Return shape | 2 coherence | Plain object with `all` getter and `byId(id)` method, no `Disposable`, no `ReadonlyMap` | Map shape is structurally redundant once writes, dispose, and Map-only methods are gone; audit shows nothing depends on it. |
| Storage strategy | 2 coherence | Live read from `table` on every access; no mirror | Mirror is the source of all disposal complexity and the empty-cache hazard from createSubscriber. |
| Reactivity granularity | 3 taste, risky | Single global subscriber; no per-key signals | Simpler lifecycle, but it invalidates keyed reads on any table change. Verify OpenSidian filesystem and chat metadata before accepting this globally. |
| Verb naming for plural | 3 taste | `all` getter | Reads naturally as "all recordings"; matches the `get all() { return map }` shape already in 4 wrappers. |
| Verb naming for keyed lookup | 3 taste | `byId(id)` method | JS-canonical idiom for keyed lookup off a Map shape; avoids `Row` noun collision with `@tanstack/table-core`. |
| Dropped: `count`/`size` | 2 coherence | Use `view.all.length` | One semantic site (`folders.svelte.ts:69`), 4 cosmetic; -1 verb beats keeping a method to skip a `.length`. |
| Dropped: `has(id)` | 2 coherence | Use `view.byId(id) !== undefined` or truthy check | 3 sites, all reducible to a `byId` truthy check. -1 verb. |
| Dropped: iteration protocol, `.keys()`, `.values()`, `.entries()` | 2 coherence | Use `view.all` (array) | Map shape is gone; arrays cover every observed iteration use. |
| Dropped: `Disposable` and `Symbol.dispose` | 2 coherence | createSubscriber owns lifecycle | No consumer needs to know about teardown. |
| Internal API access | 2 coherence | None; only `svelte/reactivity` public exports | User stated requirement. |

## Architecture

### Before

```
┌────────────────────────┐
│  consumer ($derived)   │
│  [...map.values()]     │
└───────────┬────────────┘
            │ tracks
            ▼
┌────────────────────────┐         ┌─────────────────────┐
│  SvelteMap mirror      │◀────────│ table.observe(cb)   │
│  per-key signals       │  writes │ on changedIds:      │
│  #version, #size       │ from cb │   table.get(id)     │
└────────────────────────┘         │   map.set(id, row)  │
            ▲                       └─────────────────────┘
            │ explicit dispose                  ▲
            │                                   │
┌────────────────────────┐                      │
│ wrapper                │──── unobserve() ─────┘
│ [Symbol.dispose]()     │
│ import.meta.hot.dispose│
│ onDestroy              │
└────────────────────────┘
```

### After

```
┌────────────────────────┐
│  consumer ($derived)   │
│  view.all / view.byId  │
└───────────┬────────────┘
            │ tracks via createSubscriber
            ▼
┌────────────────────────┐
│  createSubscriber      │
│  ref-count, microtask  │
│  teardown              │
└───────────┬────────────┘
            │ start() on first reader
            │ stop()  on last reader
            ▼
┌────────────────────────┐         ┌─────────────────────┐
│  table.observe(update) │────────▶│ Yjs Y.Map           │
│  update() bumps source │ live    │ canonical store     │
└────────────────────────┘ reads   └─────────────────────┘
            ▲                                   ▲
            │ table.getAllValid()               │
            │ table.get(id)                     │
            └───────────────────────────────────┘
                  on every method call
```

## Implementation Plan

Build, prove, remove. Phases 1 to 4 are sequential; within Phase 2 the per-app migrations can proceed in parallel.

### Phase 0: Reconfirm lifecycle and granularity

- [ ] **0.1** For every Phase 2 file, list each `[Symbol.dispose]()` or HMR cleanup and mark it as `fromTable observer cleanup` or `other resource cleanup`.
- [ ] **0.2** Keep all `other resource cleanup` paths. Known examples: Fuji workspace disposal, OpenSidian `fs.index` and `fs` disposal, chat message observers, chat handles, and workspace handles.
- [ ] **0.3** In OpenSidian filesystem state, rewrite comments that claim ancestor-only or key-level tracking if this migration accepts global invalidation.
- [ ] **0.4** Measure or smoke-test OpenSidian filesystem interactions with a large sample tree before merging the global-subscriber version.

### Phase 1: Build the new primitive

- [ ] **1.1** Rewrite `packages/svelte-utils/src/from-table.svelte.ts` to the new shape. Drop `ReactiveTableMap` type export; the inferred return type is sufficient.
- [ ] **1.2** Update `packages/svelte-utils/src/index.ts` to remove the `ReactiveTableMap` re-export.
- [ ] **1.3** Update `.agents/skills/svelte/SKILL.md` and `.agents/skills/workspace-api/SKILL.md` references that mention `fromTable` returning a SvelteMap or requiring dispose.
- [ ] **1.4** Add a focused test in `packages/svelte-utils/src/from-table.svelte.test.ts` verifying:
  - First read inside `$effect.root` attaches the observer
  - Last reader teardown detaches the observer (microtask)
  - Outside-effect reads return current Yjs state without subscribing
  - Writes to Yjs propagate to a `$derived` consumer

### Phase 2: Migrate call sites (parallelizable per file)

Each file changes per the translation table below. No file change depends on another file's change.

- [ ] **2.1** `apps/honeycrisp/src/routes/(signed-in)/state/folders.svelte.ts`
- [ ] **2.2** `apps/honeycrisp/src/routes/(signed-in)/state/notes.svelte.ts`
- [ ] **2.3** `apps/zhongwen/src/routes/(signed-in)/chat/chat-state.svelte.ts`
- [ ] **2.4** `apps/fuji/src/lib/session.svelte.ts`
- [ ] **2.5** removed: Fuji no longer has `SignedInSessionProvider.svelte`
- [ ] **2.6** `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`
- [ ] **2.7** `apps/opensidian/src/lib/chat/chat-state.svelte.ts`
- [ ] **2.8** `apps/whispering/src/lib/state/transformation-steps.svelte.ts`
- [ ] **2.9** `apps/whispering/src/lib/state/transformation-runs.svelte.ts`
- [ ] **2.10** `apps/whispering/src/lib/state/transformations.svelte.ts`
- [ ] **2.11** `apps/whispering/src/lib/state/recordings.svelte.ts`
- [ ] **2.12** `apps/opensidian/src/lib/state/fs-state.svelte.ts`
- [ ] **2.13** `apps/tab-manager/src/lib/state/tool-trust.svelte.ts`
- [ ] **2.14** `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts`
- [ ] **2.15** `apps/tab-manager/src/lib/state/bookmark-state.svelte.ts`
- [ ] **2.16** `apps/skills/src/lib/state/skills-state.svelte.ts`

### Phase 3: Verify

- [ ] **3.1** `bun run typecheck` across the monorepo passes with zero new errors.
- [ ] **3.2** `bun run test` passes.
- [ ] **3.3** Manual smoke: launch whispering, fuji, honeycrisp, tab-manager. Exercise per-app create/update/delete flows for at least one tabular view. Confirm no regressions in TanStack Table sorting or row updates.
- [ ] **3.4** HMR check: edit one of the migrated wrapper files (e.g. `recordings.svelte.ts`), confirm hot replace does not leak observers (open devtools, check Yjs document for accumulated handlers if any.)
- [ ] **3.5** Sign-out smoke: in fuji, sign out and back in. Confirm the rebuilt session payload does not retain stale entries data.

### Phase 4: Remove

- [ ] **4.1** Delete the `ReactiveTableMap` type export reference (already done in 1.2; this phase confirms nothing imports it).
- [ ] **4.2** Search-and-fail: `grep -rn "ReactiveTableMap" packages/ apps/` returns zero hits.
- [ ] **4.3** Search-and-fail: no cleanup remains whose only purpose is disposing a `fromTable` view. Cleanup for other resources may remain.
- [ ] **4.4** Update `docs/articles/sveltemap-over-state-for-keyed-collections.md` and `docs/articles/derived-vs-getter-caching-matters.md` if the new primitive contradicts examples.

### Call site translation table

| Old | New |
|---|---|
| `[...map.values()]` | `view.all` |
| `Array.from(map.values())` | `view.all` |
| `map.values()` (used as iterable) | `view.all` |
| `map.get(id)` | `view.byId(id)` |
| `map.has(id)` | `view.byId(id) !== undefined` (or truthy check `if (view.byId(id))`) |
| `map.size` | `view.all.length` |
| `for (const [id, row] of map)` | `for (const row of view.all)` (id is on `row.id`) |
| `[...map.keys()]` | `view.all.map(r => r.id)` |
| `map[Symbol.dispose]()` | delete only when the map was the only owned resource |
| `import.meta.hot.dispose(() => x[Symbol.dispose]())` | keep if `x` still owns non-fromTable resources |
| `onDestroy(() => x[Symbol.dispose]())` | keep if `x` still owns non-fromTable resources |
| `[Symbol.dispose]() { map[Symbol.dispose](); }` (in wrapper) | remove the map line, not necessarily the whole method |

### Worked example: `recordings.svelte.ts`

Before:

```ts
function createRecordings() {
  const map = fromTable(whispering.tables.recordings);
  const sorted = $derived(
    [...map.values()].sort(/* by recordedAt desc */),
  );
  return {
    [Symbol.dispose]() { map[Symbol.dispose](); },
    get all() { return map; },
    get(id: string) { return map.get(id); },
    get sorted(): Recording[] { return sorted; },
    set(r) { whispering.tables.recordings.set({ ...r, _v: 2 } as Recording); },
    update(id, partial) { return whispering.tables.recordings.update(id, partial); },
    delete(id) { whispering.tables.recordings.delete(id); },
    async bulkDelete(ids) { await whispering.tables.recordings.bulkDelete(ids); },
    get count() { return map.size; },
  };
}
export const recordings = createRecordings();
if (import.meta.hot) {
  import.meta.hot.dispose(() => recordings[Symbol.dispose]());
}
```

After:

```ts
function createRecordings() {
  const view = fromTable(whispering.tables.recordings);
  const sorted = $derived(
    view.all.toSorted(/* by recordedAt desc */),
  );
  return {
    get all() { return view.all; },
    get sorted(): Recording[] { return sorted; },
    byId: view.byId,
    set(r) { whispering.tables.recordings.set({ ...r, _v: 2 } as Recording); },
    update(id, partial) { return whispering.tables.recordings.update(id, partial); },
    delete(id) { whispering.tables.recordings.delete(id); },
    async bulkDelete(ids) { await whispering.tables.recordings.bulkDelete(ids); },
  };
}
export const recordings = createRecordings();
```

External consumers of `recordings.get(id)` change to `recordings.byId(id)`. Consumers of `recordings.count` change to `recordings.all.length`. Both are mechanical.

## Edge Cases

### Outside-effect reads after a teardown microtask

1. Component A mounts, reads `recordings.all` in a `$derived`, observer attaches.
2. Component A unmounts. Microtask scheduled to run cleanup.
3. Before microtask runs, an event handler reads `recordings.byId(id)`.
4. `subscribe()` is a no-op because no effect is tracking; the read returns live Yjs state via `table.get(id)`.

Outcome: correct. Live Yjs is the source of truth; there is no mirror to be empty.

### Outside-effect reads with no subscribers anywhere

1. No component is currently rendering anything from a `recordings.*` accessor.
2. Code calls `recordings.all.length` from a click handler.
3. `subscribe()` is a no-op. `table.getAllValid()` runs and returns current data.

Outcome: correct. Same data the SvelteMap design would have shown if it had a live observer.

### HMR replace of a wrapper module

1. Vite hot-replaces `recordings.svelte.ts`.
2. The old `view` goes out of scope. Any `$effect` in the previous wrapper version was already torn down by Svelte's HMR machinery.
3. createSubscriber's reference count reaches 0 on microtask. Cleanup fires. Old `unobserve()` runs.
4. New module evaluates. New `view`. Fresh `createSubscriber`. Fresh observer attaches on first new reader.

Outcome: correct without `import.meta.hot.dispose`. This is the disposal-plumbing deletion's primary justification.

### TanStack Table consumers

1. Wrapper exposes `get sorted(): Recording[]` backed by `$derived(view.all.toSorted(...))`.
2. TanStack Table reads `recordings.sorted`, gets a stable array reference until the underlying view changes.
3. Yjs write fires observer, view's tracked source bumps, `$derived` reruns, new array reference, TanStack reacts.

Outcome: identical behavior to current. Unaffected.

### `for (const [id, row] of map)` sites

1. `apps/whispering/src/lib/state/transformation-steps.svelte.ts:93` uses `for (const [id, step] of map)`.
2. New code: `for (const step of view.all) { const id = step.id; ... }`.

Outcome: equivalent; one extra line. `BaseRow.id` is guaranteed.

### Multiple consumers of the same view

createSubscriber refcounts. Two `$derived` reading `recordings.all` produce one `table.observe` registration shared between them. When both effects tear down, the microtask drops the count to zero and one `unobserve()` fires.

## Open Questions

1. **Should `view.all` return a stable reference between writes for TanStack Table users to dedupe `useReactiveTable`-style hooks?**
   - Current SvelteMap-backed wrappers wrap the values spread in `$derived` to memoize. The new design does the same; consumers continue to wrap `view.all` in `$derived(view.all)` or `$derived(view.all.toSorted(...))`.
   - Options: (a) `view.all` returns a fresh array on every call (simple, current proposal), (b) `view.all` memoizes internally between observer fires (more code, no observable difference because `$derived` already memoizes).
   - **Recommendation**: (a). Pushing memoization into the primitive duplicates what `$derived` does already.

2. **Drop `byId` in favor of plain index access via Proxy?**
   - `recordings[id]` reads tighter than `recordings.byId(id)`.
   - Cost: per-read Proxy trap, no JSDoc on indexer, no autocomplete, type-system gymnastics for a `Record<string, TRow | undefined>` shape.
   - **Recommendation**: keep `byId(id)`. Proxy magic isn't worth the IDE tax.

3. **Per-key reactivity now, or only when profiling demands?**
   - Per-key SvelteMap-as-signal pattern (use SvelteMap purely as version source, bump per id in observer, read live from Yjs in accessors) preserves granular reactivity without internal API.
   - Cost: ~30 extra lines in the primitive, separate code path to maintain.
   - **Recommendation**: defer. Ship coarse first. Add only when a flame graph shows `parseRow` time as a fraction of frame budget on a real workload. Document the upgrade path inline as a comment.

4. ~~**Should `fromKv` (sibling primitive in `packages/svelte-utils/src/from-kv.svelte.ts`) get the same treatment?**~~ **Resolved**: yes, in this branch. Cherry-pick `59cf03e2c` ("refactor(svelte): use subscriber for KV bindings") which already applies the same `createSubscriber` + live-read pattern to `fromKv`, drops the `$state` mirror, and removes the `destroy()` method. Touches only the primitive and one call site (`apps/zhongwen/src/routes/(signed-in)/+page.svelte`).

## Decisions Log

- Keep `byId` as a method rather than a Proxy index: IDE tooling and JSDoc clarity outweigh the four-character call-site savings.
  Revisit when: a different primitive in `svelte-utils` adopts Proxy-index access and proves the ergonomics in production.
- Keep coarse single-source reactivity instead of per-key SvelteMap-as-signal: scale doesn't justify the second code path yet.
  Revisit when: any production view ships with table size > 2000 rows or a flame graph attributes > 2ms per Yjs write to `parseRow` calls.
- Keep the `view.all` shape as `TRow[]` (not `Iterable<TRow>` or `ReadonlyArray<TRow>`): callers do `.sort`, `.filter`, `.map`, `.toSorted` directly; `Iterable` would force `Array.from` at every site.
  Revisit when: a caller wants to mutate `view.all` and expects the change to round-trip (today no caller does this; the array is a snapshot).

## Success Criteria

- [ ] `packages/svelte-utils/src/from-table.svelte.ts` is < 30 lines and uses only `svelte/reactivity` public exports.
- [ ] Zero `Symbol.dispose` references remain in app code paths that consume `fromTable`.
- [ ] Zero `import.meta.hot.dispose(...)` related to `fromTable` consumers.
- [ ] Zero `onDestroy(...)` calls related to `fromTable` consumers.
- [ ] `bun run typecheck` and `bun run test` pass.
- [ ] Manual smoke across whispering, fuji, honeycrisp, tab-manager passes for create/update/delete on at least one tabular view per app.
- [ ] HMR replace of a migrated wrapper file does not produce a stale-observer warning or duplicate row updates.

## References

### Primary

- `packages/svelte-utils/src/from-table.svelte.ts`: primitive being rewritten
- `packages/svelte-utils/src/index.ts`: public export list
- `packages/svelte-utils/src/from-table.svelte.test.ts`: new test file
- `packages/workspace/src/document/attach-table.ts:386-460`: `Table` API contract; `get`, `getAllValid`, `observe`, `count`, `has`

### Svelte sources consulted

- `node_modules/.bun/svelte@5.55.1/.../reactivity/create-subscriber.js`: public lifecycle primitive
- `node_modules/.bun/svelte@5.55.1/.../reactivity/map.js`: current dependency, removed
- `node_modules/.bun/svelte@5.55.1/.../reactivity/reactive-value.js`: private, not used
- `node_modules/.bun/svelte@5.55.1/.../reactivity/index-client.js`: confirmed public exports

### Call sites (full list at Phase 2)

17 `fromTable` bindings across 16 app files. See per-file checklist above.

### Related specs

- `specs/20260318T234754-rename-svelte-package-and-add-fromKv.md`: sibling primitive `fromKv` may need the same treatment (Open Question 4)
- `specs/20260506T020000-expose-attachments-not-aliases.md`: recent precedent for trimming primitive surface area
