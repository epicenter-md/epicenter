# `defineDocument`: Invert readiness, drop barriers, trim the API

**Date**: 2026-04-22
**Status**: Complete
**Author**: AI-assisted
**Branch**: braden-w/document-primitive

## Overview

Remove `whenReady` **and `whenDisposed`** from the `DocumentBundle` contract, remove `factory.load(id)` from `DocumentFactory`, and stop using `defineDocument` for workspace singletons. The cache becomes a pure ref-counted identity map over a user-defined builder; **both** readiness and disposal-barriers become attachment-level conventions that consumers await on their own terms. The framework owns identity, refcount, and gcTime, nothing more.

Dispose is always synchronous. `[Symbol.dispose]()` calls `ydoc.destroy()`. Attachments self-wire via `ydoc.on('destroy')` and run their async cleanup in the background. Fire-and-forget. Callers that need a barrier reach for the specific attachment field (`h.idb.whenDisposed`) at the call site: rare in production, occasionally needed in tests.

## Motivation

### Current State

`defineDocument` fuses two concerns. A ref-counted cache and an opinionated loader, and bakes "readiness" into the bundle type.

```ts
// packages/workspace/src/document/define-document.ts
export type DocumentBundle = {
  ydoc: Y.Doc;
  [Symbol.dispose](): void;
  whenReady: Promise<void>;          // required
  whenDisposed?: Promise<void>;
};

export type DocumentFactory<Id extends string, T> = {
  open(id: Id): DocumentHandle<T>;
  load(id: Id): Promise<DocumentHandle<T>>;   // awaits bundle.whenReady
  close(id: Id): Promise<void>;
  closeAll(): Promise<void>;
};

// factory.load() body:
async load(id) {
  const handle = factory.open(id);
  try { await handle.whenReady; return handle; }
  catch (err) { handle.dispose(); throw err; }
},
```

And every builder is obliged to declare readiness, even when it's trivially ready:

```ts
// packages/workspace/src/document/materializer/sqlite/sqlite.test.ts
return {
  ydoc,
  tables,
  sqlite: materializer,
  whenReady: Promise.resolve(),          // null-opinion boilerplate
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

This creates problems:

1. **`Promise.resolve()` spam.** 13 of 13 bundles in `define-document.test.ts`, both fixtures in `sqlite.test.ts`, and every sync/in-memory builder in tests carry `whenReady: Promise.resolve()`. The field carries no information: it exists to satisfy the type so `factory.load()` has something to await.
2. **`whenReady` is an opinion, not a fact.** There is no single "ready" for a Y.Doc: there's `idb.whenLoaded`, `sync.whenConnected`, `sync.whenFirstSync`, `materializer.whenHydrated`. The builder picks one composition and every consumer is locked into that choice. A list view that could render on IDB alone waits for sync because the builder said so.
3. **The cache was pretending to manage readiness.** `factory.load()` is a one-line helper over `open + await handle.whenReady`. Its only real job was making the type-level guarantee "you got a ready handle back": but that guarantee is the builder's opinion re-exported, not a framework property.
4. **Singletons misuse the cache.** 8 of 13 production `defineDocument` call sites are workspace roots opened exactly once at module init (`fuji.open('epicenter.fuji')`, `whispering.open('whispering')`, …). Ref-counting is moot; the cache is ceremony around a builder call.

### Desired State

```ts
// 1. Bundle shape: both whenReady AND whenDisposed gone. Bundle is
//    whatever the builder returns, plus a sync [Symbol.dispose].
export type DocumentBundle = {
  ydoc: Y.Doc;
  [Symbol.dispose](): void;
};

// 2. Factory surface: no load(). close/closeAll return void (honest:
//    they trigger the cascade; they do NOT wait for it to settle).
export type DocumentFactory<Id extends string, T> = {
  open(id: Id): DocumentHandle<T>;
  close(id: Id): void;
  closeAll(): void;
};

// 3. Consumer decides the gate at the call site: for BOTH readiness
//    and (rarely) teardown.
using h = docs.open(entryId);
await h.whenReady;            // if the builder chose to expose one
// or:
await h.idb.whenLoaded;       // pick a specific readiness barrier
// or:
/* nothing: handle is already usable for this caller's purposes */

// Later, if a test or logout flow needs a teardown barrier:
docs.close(entryId);
await h.idb.whenDisposed;     // opt into the attachment-level barrier

// 4. Singletons drop the cache entirely.
//    Before: export const workspace = fuji.open('epicenter.fuji');
//    After:  export const workspace = buildFuji('epicenter.fuji');
```

### Why sync dispose is OK

`Y.Doc.destroy()` emits `'destroy'` synchronously. Every attachment in this codebase
(`attach-indexed-db`, `attach-sync`, `attach-encryption`, `attach-kv`, `attach-sqlite`)
already wires `ydoc.on('destroy', ...)` internally and kicks off its async cleanup
from inside that handler. That cleanup runs in the background after `[Symbol.dispose]`
returns. Idempotency is free: `Y.Doc` sets `isDestroyed` on first destroy and noops on
subsequent calls; `IndexeddbPersistence.destroy()` is idempotent; custom attachments
use a `disposed` flag.

In a browser SPA, the realistic cost of "teardown still in flight when we navigate":
- Full page reload: zero. JS runtime is wiped.
- SPA route change without reload: one IDB close + one WS onclose finish in the
  background. Tens of KB of retained refs until GC. Not catastrophic.
- Rapid close+reopen of the same id (tests mostly): genuine race on IDB. Mitigate
  by awaiting `h.idb.whenDisposed` at the specific call site. Explicit, not magic.

This matches yjs's own lifecycle philosophy: the core emits a `'destroy'` event;
caller owns coordinating provider teardown. Our attachment wrappers satisfy the
"caller calls `provider.destroy()`" requirement by doing so from inside the destroy
handler. That's idiomatic, not a hack.

## Research Findings

### All production `defineDocument` call sites (13)

Grouped by how the factory is actually used.

| Site | Shape | Builder | Call pattern |
|---|---|---|---|
| `apps/fuji/src/lib/client.ts:31` | singleton | IDB + sync + tables | `.open('epicenter.fuji')` once |
| `apps/honeycrisp/src/lib/client.ts:30` | singleton | IDB + sync + tables | `.open('epicenter.honeycrisp')` once |
| `apps/opensidian/src/lib/client.ts:45` | singleton | IDB + sync + tables + fs | `.open('epicenter.opensidian')` once |
| `apps/zhongwen/src/lib/client.ts:21` | singleton | tables only | `.open('epicenter.zhongwen')` once |
| `apps/whispering/src/lib/client.ts:20` | singleton | IDB + sync + tables | `.open('whispering')` once |
| `apps/tab-manager/src/lib/client.ts:38` | singleton | IDB + sync + tables | `.open('epicenter.tab-manager')` once |
| `apps/breddit/.../reddit/workspace.ts:337` | singleton | in-memory tables | `.open('reddit')` once |
| `packages/skills/src/index.ts:50` | singleton | IDB + broadcast + encryption | `.open('epicenter.skills')` once |
| `apps/fuji/src/lib/entry-content-docs.ts:22` | **id-keyed** | IDB + sync | `.open(entryId)` per-row |
| `apps/honeycrisp/src/lib/note-body-docs.ts:22` | **id-keyed** | IDB + sync | `.open(noteId)` per-row |
| `packages/filesystem/src/file-content-docs.ts:44` | **id-keyed** | caller-owned | `.open(fileId)` per-file |
| `packages/skills/src/skill-instructions-docs.ts:28` | **id-keyed** | caller-owned | `.open(skillId)` per-skill |
| `packages/skills/src/reference-content-docs.ts:28` | **id-keyed** | caller-owned | `.open(refId)` per-ref |

**Key finding**: singletons dominate (8/13). For those sites, `defineDocument` provides no value a direct builder call wouldn't: the cache never sees a second open.

### `.load()` vs `.open()` in non-test code

`.load()` use is imperative-only and concentrated in Node/CLI contexts (`packages/skills/src/node.ts`, `packages/filesystem/*`, CLI entrypoints) and one browser path (skill editors, `await using` for scope binding). All `.load()` call sites can trivially become `const h = docs.open(id); await h.whenReady;`: two lines, same semantics.

### `when*` barrier inventory

Attachment layer already exposes granular barriers. The `whenReady` aggregate flattens them and throws information away.

| Barrier | Source | Meaning |
|---|---|---|
| `idb.whenLoaded` | `attachIndexedDb` | local updates replayed into ydoc |
| `sync.whenConnected` | `attachSync` | WebSocket up + first remote exchange |
| `sync.whenDisposed` | `attachSync` | teardown settled |
| `idb.whenDisposed` | `attachIndexedDb` | teardown settled |
| `bundle.whenReady` | builder convention | some composition of the above |
| `bundle.whenDisposed` | builder convention | aggregate teardown |

**Implication**: consumers can compose their own gates from attachment-layer barriers. A mandatory `whenReady` only helps if every consumer wants the same composition, which is not true across UI/sync/imperative paths.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove `whenReady` from `DocumentBundle` | Yes | Framework doesn't consume it anymore; builders that want it can still expose it under that name by convention |
| Remove `factory.load(id)` | Yes | Becomes `const h = docs.open(id); await h.whenReady;`: trivial at call sites, removes duplicated type surface |
| Remove `whenDisposed` from `DocumentBundle` | **Yes** | Framework stops orchestrating a teardown barrier. Cascade via `ydoc.on('destroy')` inside attachments is already wired; async cleanup runs in the background. Callers that need a barrier reach for the specific attachment field (`h.idb.whenDisposed`). Symmetric with the `whenReady` removal: neither readiness nor disposal should be framework contracts |
| `close(id)` / `closeAll()` return `void`, not `Promise<void>` | Yes | Honest typing. They trigger the cascade; they don't wait for it to settle. Zero `await docs.close(id)` ceremony at call sites |
| Stop using `defineDocument` for workspace singletons | Yes | Export the builder directly as `buildFuji`/`buildWhispering`/etc.; call it once at module scope. Ref-count serves no purpose with one caller |
| Split `defineDocument` into two primitives (builder + cache) | No | Overkill: just stop using the cache where it adds no value. One primitive, narrower scope |
| Rename `defineDocument` | Deferred | Name is fine once its scope is "ref-counted id-keyed document cache"; reconsider if the pattern grows beyond documents |
| Keep `DocumentHandle<T>` brand + `isDocumentHandle` | Yes | Unrelated to readiness; used elsewhere for handle detection |
| Keep attachment-level `whenDisposed` fields on `attach-*` helpers | Yes | This is where the async barrier actually lives and is useful. Consumers opt in at the specific call site. Framework doesn't peek at them |

## Architecture

### Before: one primitive, two jobs

```
defineDocument(build, opts)
├── builder contract: { ydoc, whenReady, whenDisposed?, [Symbol.dispose] }
└── factory: { open, load, close, closeAll }
                      │
                      ▼
        ┌─────────────┴─────────────┐
        │                           │
  SINGLETON USE              ID-KEYED USE
  (8 call sites)             (5 call sites)
  one open(fixedId)          many open(runtimeId)
  ref-count irrelevant       ref-count is the point
  cache = ceremony           cache = necessary
```

### After: smaller primitive, honest usage

```
// id-keyed: defineDocument is the cache
defineDocument(build, opts?)
├── builder contract: { ydoc, whenDisposed?, [Symbol.dispose] }  ← whenReady gone
└── factory: { open, close, closeAll }                            ← load gone
                      │
                      ▼
            ID-KEYED USE
            (5 call sites)
            many open(runtimeId)
            consumers await whatever gate fits
              using h = docs.open(id);
              await h.whenReady;  // if builder exposes it
              // or: await h.idb.whenLoaded;
              // or: nothing

// singleton: no cache at all
export function buildFuji(id: string): FujiBundle { ... }
export const workspace = buildFuji('epicenter.fuji');
```

### Consumer flow after the change

```
IMPERATIVE
──────────
  using h = docs.open(id);
  await h.whenReady;           // consumer-chosen gate
  h.content.write(...);
  // dispose on scope exit

REACTIVE
────────
  $effect(() => {
    const h = docs.open(id);
    return () => h.dispose();
  });
  // subscribe to reactive state immediately;
  // await h.whenReady inside a nested effect if UI needs it

SINGLETON (workspace root)
─────────────────────────
  export const workspace = buildFuji('epicenter.fuji');
  await workspace.whenReady;   // at app init, once
```

## Implementation Plan

### Phase 1: Contract + factory surface

- [x] **1.1** Edit `packages/workspace/src/document/define-document.ts`: remove **both** `whenReady` and `whenDisposed` from `DocumentBundle`. The bundle becomes `{ ydoc: Y.Doc; [Symbol.dispose](): void }`. Update the module-level doc comment to reframe the primitive as "ref-counted id-keyed cache; readiness *and* disposal-barriers are attachment-level conventions, not framework concerns."
- [x] **1.2** Remove `load(id)` from `DocumentFactory` type and its implementation. Update `DOCUMENT_HANDLE` brand / `isDocumentHandle` unchanged.
- [x] **1.3** Change `close(id)` and `closeAll()` return types from `Promise<void>` to `void`. Drop the `await entry.bundle.whenDisposed` lines inside the implementations: `disposeEntry` triggers the sync `[Symbol.dispose]` and returns; async cleanup runs in the background via attachment-level `on('destroy')` handlers.
- [x] **1.4** Update the `T extends DocumentBundle` generic bound so it no longer requires `whenReady` or `whenDisposed`.
- [x] **1.5** Update the "Three usage levels" doc block: drop the `await using h = await docs.load('abc')` example, replace with `using h = docs.open(id); await h.whenReady;` pattern. Add a short "opt into teardown barrier via `h.idb.whenDisposed` if needed" note for the rare case.
- [x] **1.6** Update the "Provider teardown" doc section to state: `[Symbol.dispose]` is sync; attachments self-wire via `ydoc.on('destroy')` and run their async cleanup in the background; if a consumer needs a barrier, it's on the attachment field.
- [x] **1.7** Scan the file for any remaining references to `whenReady` or `whenDisposed` (comments, hazard notes, examples) and reconcile.

### Phase 2: Id-keyed call sites keep `whenReady` as builder convention, drop `whenDisposed`

These 5 sites compose a real readiness gate and should keep exposing `whenReady` on the bundle, just as a convention, not a contract. They should **stop** composing `whenDisposed` on the bundle (attachment-level `whenDisposed` remains on `h.idb`, `h.sync`, etc. for callers that need it).

- [x] **2.1** `apps/fuji/src/lib/entry-content-docs.ts`: keep composing `whenReady`; remove `whenDisposed` field from the bundle; ensure `[Symbol.dispose]` is `ydoc.destroy()`; update call sites (`.load(entryId)` → `.open(entryId); await h.whenReady`).
- [x] **2.2** `apps/honeycrisp/src/lib/note-body-docs.ts`: same treatment.
- [x] **2.3** `packages/filesystem/src/file-content-docs.ts`: same. Check CLI/Node callers using `.load()`. CLI callers that previously relied on `await closeAll()` to flush must now either `await h.idb.whenDisposed` explicitly or accept fire-and-forget.
- [x] **2.4** `packages/skills/src/skill-instructions-docs.ts`: same.
- [x] **2.5** `packages/skills/src/reference-content-docs.ts`: same.
- [x] **2.6** Grep for `.load(` calls on document factories across `apps/`, `packages/`; rewrite each to `.open() + await whenReady`. Prefer `await using` where scope binding was the reason for `.load()`.
- [x] **2.7** Grep for `await .*close(` and `await .*closeAll(` calls: strip the `await` since both now return `void`. For CLI/test call sites that genuinely need a flush barrier, rewrite to explicit `await h.idb.whenDisposed` (or the relevant attachment field) before the close call.

### Phase 3: Singletons exit the cache

Replace `defineDocument(build).open(fixedId)` with a direct builder call + module-scope instance. This is the step that deletes the most ceremony. Each builder also drops its `whenDisposed` field (aligns with Phase 1 contract change).

- [x] **3.1** `apps/fuji/src/lib/client.ts`: export `buildFuji(id)`; replace `fuji.open('epicenter.fuji')` with `buildFuji('epicenter.fuji')`. Drop `whenDisposed` from the bundle. Verify no consumer depends on cache semantics.
- [x] **3.2** `apps/honeycrisp/src/lib/client.ts`: same pattern.
- [x] **3.3** `apps/opensidian/src/lib/client.ts`: same.
- [x] **3.4** `apps/zhongwen/src/lib/client.ts`: same.
- [x] **3.5** `apps/whispering/src/lib/client.ts`: same.
- [x] **3.6** `apps/tab-manager/src/lib/client.ts`: same.
- [x] **3.7** `apps/breddit/src/lib/workspace/ingest/reddit/workspace.ts`: same.
- [x] **3.8** `packages/skills/src/index.ts`: same; nested factories (`instructionsDocs`, `referenceDocs`) stay id-keyed but drop `whenDisposed` from their bundles too.

### Phase 4: Tests

- [x] **4.1** `packages/workspace/src/document/define-document.test.ts`: delete every `whenReady: Promise.resolve()` and `whenDisposed: ...` from fixtures. Update tests that specifically exercise `.load()`: either port them to `.open() + await`, or delete if the behavior is trivial. Tests that asserted `close()` returned a settled promise must rewrite to await the attachment-level barrier they actually care about (or drop the assertion if they don't).
- [x] **4.2** `packages/workspace/src/document/materializer/sqlite/sqlite.test.ts`: remove `whenReady: Promise.resolve()` and any `whenDisposed` from the two fixtures at the user-quoted location.
- [x] **4.3** Any other test fixture carrying the null-opinion promises: remove.
- [x] **4.4** Add one test that `defineDocument` compiles + runs with a minimal bundle `{ ydoc, [Symbol.dispose] }`: no `whenReady`, no `whenDisposed`, no anything extra (regression pin for the type changes).
- [x] **4.5** Add a test asserting `close(id)` returns `undefined` (not a promise) and that the cascade runs: construct a bundle whose attachment resolves a sentinel on `ydoc.on('destroy')`, `close()`, and assert the sentinel resolved without awaiting `close()`.

### Phase 5: Skills + docs

- [x] **5.1** Update `packages/workspace/.claude/skills/workspace-api` (if it documents `whenReady` or `load`) to match new shape.
- [x] **5.2** Update the `sync-construction-async-property-ui-render-gate-pattern` skill reference if it mentions `whenReady` as a framework contract: it's now a convention.
- [x] **5.3** Update any `AGENTS.md` / `CLAUDE.md` sections in `packages/workspace/` and root that describe bundle shape.

## Edge Cases

### Id-keyed factory consumer forgets to await readiness

1. `const h = docs.open(id)` returns handle with empty ydoc.
2. Consumer reads immediately, gets empty state.
3. Consumer shows empty UI or returns empty data.

**Resolution**: this is exactly the hazard `factory.load()` previously papered over. The fix is cultural: builders that compose async gates should name them `whenReady` by convention; reviewers catch missing awaits. Optionally add a lint / ESLint rule that flags `docs.open(...)` without a subsequent `whenReady` await in imperative contexts. See Open Questions.

### Concurrent `close(id)` during in-flight `await h.whenReady`

1. Caller A: `const h = docs.open(id); await h.whenReady;`
2. Caller B: `docs.close(id)` fires during the await.
3. When A resumes, `h.ydoc` is destroyed; subsequent ops throw.

**Resolution**: same hazard exists today with `.load()`. Documented as "caller-initiated teardown during in-flight load is a logic error higher up." No code change; ensure the hazard is still named in the module doc.

### Singleton builder called twice by accident

1. After Phase 3, `buildFuji('epicenter.fuji')` is just a function; calling it twice creates two independent Y.Docs.
2. Without cache, guid-stability check is gone.

**Resolution**: singletons are `export const workspace = buildFuji(...)` at module scope. ES module singleton semantics prevent double-construction in practice. Document this explicitly in the builder file: "call once at module scope." If a misuse actually occurs, the symptom (two Y.Docs, divergent state) is loud.

### Id-keyed bundle has no async readiness at all

1. Some in-memory or SQLite-only bundle is instantly ready.
2. Before: builder wrote `whenReady: Promise.resolve()`.
3. After: builder writes nothing. Consumers don't await.

**Resolution**: that's the win. No ceremony for the null case.

### Close-then-reopen race on async attachment teardown

1. `docs.close(id)` fires: `ydoc.destroy()` runs; IDB attachment's `on('destroy')` handler kicks off `await idb.destroy()` in the background.
2. Test code immediately calls `docs.open(id)` again.
3. New `Y.Doc` constructs; new `IndexeddbPersistence` opens the same DB while the old one's `close()` is still in flight.
4. Potential race on IndexedDB connection handles.

**Resolution**: documented footgun. Tests and CLI flows that close-then-reopen the same id must `await h.idb.whenDisposed` (attachment-level barrier) before reopening. Production code rarely hits this pattern. Not the framework's job to paper over; the barrier is available to opt into at the specific call site.

### Fire-and-forget teardown at app shutdown

1. Logout handler calls `docs.closeAll()`.
2. Returns immediately. Async teardown runs in background.
3. Handler navigates to login page.

**Resolution**: this is the intended behavior and it's fine. Page navigation either reloads (GC wipes everything) or continues in SPA (background teardown completes). Callers that need a flush barrier before navigating (e.g., Node CLI exits) must `await h.idb.whenDisposed` for each doc they care about before calling `closeAll()`: or before exiting the process.

## Open Questions

1. **Keep `whenReady` as a documented builder convention, or leave it fully unnamed?**
   - Options: (a) document "if your bundle has an async readiness gate, expose it as `whenReady`" so consumers know the idiom, (b) stay silent and let each builder choose names like `whenHydrated`, `whenLoaded`, etc.
   - **Recommendation**: (a). The convention is load-bearing for code review ("did you forget to await?") and for grep-ability across the codebase. But keep it clearly marked as convention-not-contract so builders can deviate when the name doesn't fit.

2. **Should reactive code get a helper for the "open + await in effect" pattern?**
   - The Svelte pattern `$effect(() => { const h = docs.open(id); return () => h.dispose(); })` plus a nested effect for readiness is three lines of ceremony.
   - A helper `useDocument(docs, id)` returning a reactive handle + loaded boolean could collapse it.
   - **Recommendation**: defer. Ship the primitive refactor first; revisit helpers after real consumers shake out.

3. **ESLint rule for "open() without await whenReady" in imperative contexts?**
   - Would recover some of the footgun protection `load()` provided.
   - Likely noisy (false positives in reactive contexts).
   - **Recommendation**: don't build a custom rule. Rely on code review + the fact that empty-ydoc symptoms are loud in tests.

4. **Should id-keyed factories with sync-only builders lose the cache too?**
   - If a specific id-keyed doc is always opened once per id and disposed immediately, ref-counting doesn't earn its keep there either.
   - **Recommendation**: don't prematurely optimize. Keep the cache for anything that takes a runtime id; it's cheap. The singleton exit is clear-cut because those sites literally open once and never close.

5. **`factory.close(id)` / `closeAll()` retention when all remaining uses are id-keyed?**
   - Still needed (explicit teardown on logout, workspace unmount). Keep as-is.

## Success Criteria

- [x] `DocumentBundle` no longer requires `whenReady` **or** `whenDisposed`. Shape reduces to `{ ydoc: Y.Doc; [Symbol.dispose](): void }`.
- [x] `DocumentFactory` no longer exposes `load()`.
- [x] `DocumentFactory.close(id)` and `closeAll()` have return type `void` (not `Promise<void>`).
- [x] Zero occurrences of `whenReady: Promise.resolve()` remain across the repo. (Exception: three regression-pin test fixtures in `define-document.test.ts` under `describe('whenReady as builder convention', ...)` intentionally keep this shape to assert the primitive accepts pre-resolved builder conventions.)
- [x] Zero occurrences of `whenDisposed:` on bundle-return-shape objects. Attachment-level `whenDisposed` (on `attach-*` return values) remains: those live one layer down.
- [x] Zero `await docs.close(` / `await docs.closeAll(` patterns outside of legacy ports; call sites that needed a flush barrier use explicit `await h.idb.whenDisposed` (or equivalent attachment field).
- [x] All 8 singleton call sites use a direct builder call, not `defineDocument(...).open(fixedId)`.
- [x] All 5 id-keyed call sites compile and work with `.open(id) + await h.whenReady`.
- [x] Every existing test in `define-document.test.ts` either ports cleanly or is deleted with rationale.
- [x] `bun test` passes in `packages/workspace`.
- [x] Typecheck passes across the repo (monorepo-wide `bun run typecheck` if available).
- [x] Module-level doc comment in `define-document.ts` reflects the narrower scope: ref-counted cache only; readiness AND disposal-barrier are both attachment-level conventions.

## References

- `packages/workspace/src/document/define-document.ts`: primary edit target.
- `packages/workspace/src/document/define-document.test.ts`: test fixtures to strip.
- `packages/workspace/src/document/materializer/sqlite/sqlite.test.ts`: two more fixtures to strip.
- `packages/workspace/src/document/materializer/markdown/materializer.ts:132`: example builder with real readiness composition.
- `packages/workspace/src/document/materializer/sqlite/sqlite.ts:49`: same.
- Recent commit `5a6b3536a refactor(workspace): make DocumentBundle.whenReady required`: the immediate predecessor. This spec inverts that direction. Commit message there explains the original motivation; the argument now is that the framework should not have an opinion on readiness at all.
- `.claude/skills/sync-construction-async-property-ui-render-gate-pattern`: the general pattern that made `whenReady` look necessary; relevant for framing the change.
- Call sites enumerated in Research Findings: all 13 production `defineDocument` usages plus `.load()` call sites need touches.

## Execution Log

- Phase 1: `8588985a7`: `DocumentBundle` reduced; `close/closeAll` sync
- Phase 2: `85742078f`: id-keyed bundles drop `whenDisposed`; `.load()` callers rewritten
- Phase 3: `978957d9d`: 8 singletons exit `defineDocument`
- Phase 4: `6ba6c34d1`: test fixtures ported; regression pins added
- Phase 5: `30309b69d`: skills/docs/stragglers reconciled
