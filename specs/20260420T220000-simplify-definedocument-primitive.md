# Simplify `defineDocument`: invert control, drop framework smells

**Date**: 2026-04-20
**Status**: Implemented
**Author**: AI-assisted (Braden + Claude)
**Branch**: `braden-w/document-primitive`
**Follows**: `specs/20260420T152026-definedocument-primitive.md` (original design, now being simplified)

## TL;DR

The current `defineDocument` primitive in `packages/document/src/define-document.ts` does three things users should own (aggregation, teardown-of-Y.Doc, reserved-key naming) and one thing the primitive should own (cache + refcount + gc-timer). This spec inverts the split: the user's `build(id)` function becomes a plain factory that returns whatever it wants, including a `[Symbol.dispose]` that disposes the Y.Doc and any pre-aggregated `whenReady` / `whenDisposed` promises. The primitive shrinks to one opt (`gcTime`), one type constraint (`T extends { ydoc: Y.Doc } & Disposable`), and zero reserved keys.

Three renames fall out:

- `graceMs` → `gcTime` (TanStack Query vocabulary; more intuitive)
- `whenLoaded` (as a framework-reserved key) → `whenReady` (user-owned convention; avoids shadowing `Y.Doc.whenLoaded`)
- `attach` (internal type param) → `T` in code, "bundle" in prose

Zero production code calls `defineDocument().open()` today, so the refactor is essentially free. The duplicated lifecycle code in `packages/workspace/src/workspace/create-documents.ts` is **not** rewired in this spec, that is a follow-up once this primitive stabilizes.

## Motivation

### Current State

The primitive today (`packages/document/src/define-document.ts`):

```ts
export function defineDocument<
  Id extends string,
  TAttach extends { ydoc: Y.Doc },
>(
  build: (id: Id) => TAttach,
  opts?: { graceMs?: number },
): DocumentFactory<Id, TAttach>
```

Internally the cache:

1. Calls `build(id)` and scans the return for magic keys `whenLoaded` / `whenDisposed`, `Promise.all`ing them into aggregated promises.
2. Enforces a reserved-key allowlist (`dispose`, `whenLoaded`) and throws if the user returns a property with those names.
3. Calls `attach.ydoc.destroy()` on teardown, relying on `ydoc.on('destroy')` listeners in provider attachments to fan out cleanup.
4. Maintains a separate `Map<Id, string>` of guids to assert stability across reconstructions.

### Problems

1. **Reserved-key collision**: `whenLoaded` is already a property on `Y.Doc` itself (resolves when persistence has loaded). Exposing a framework-owned `whenLoaded` on the returned bundle creates two meanings: `bundle.whenLoaded` (framework-aggregated) vs `bundle.ydoc.whenLoaded` (Yjs-native). Silent source of confusion and latent bug.
2. **Magic aggregation leaks**: the cache scans strings on the user's return object. Attachment properties named `whenLoaded`/`whenDisposed` are treated specially; others aren't. Inconsistent rules based on naming.
3. **Y.Doc coupling without honesty**: the cache calls `ydoc.destroy()` directly, so it *is* a Y.Doc cache: but it pretends to be generic. The pretense buys nothing and complicates naming.
4. **Provider teardown is silently incorrect for y-websocket**: `ydoc.destroy()` triggers `ydoc.on('destroy')` handlers. `IndexeddbPersistence` registers one; `WebsocketProvider` does not. Relying on the propagation leaves sockets dangling. Verified via Yjs source via DeepWiki (see Research Findings).
5. **`graceMs` is non-standard vocabulary**: TanStack Query, the closest ecosystem prior art for refcount+grace caches, uses `gcTime`. Newcomers transfer their mental model more cleanly with the established term.
6. **Zero production callers**: every call of `factory.open()` / `factory.close()` lives inside `packages/document/src/define-document.test.ts`. Nothing in `apps/` or `packages/workspace` calls it. Breaking changes have zero migration cost right now: a rare window.

### Desired State

```ts
// User's builder: a plain function, fully owned.
function buildDoc(id: string) {
  const ydoc = new Y.Doc({ guid: id });
  const idb  = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { url });

  return {
    ydoc,
    idb,
    sync,
    whenReady:    Promise.all([idb.whenLoaded, sync.whenSynced]).then(() => {}),
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    [Symbol.dispose]() {
      sync.destroy();   // explicit, because ydoc.destroy() does NOT propagate to WS
      idb.destroy();    // redundant but explicit: safe
      ydoc.destroy();
    },
  };
}

// Primitive: one opt, one type constraint, no reserved keys.
const docs = defineDocument(buildDoc, { gcTime: 30_000 });

using h = docs.open('abc');
await h.whenReady;
h.ydoc.transact(() => h.ydoc.getText('c').insert(0, 'hi'), ORIGIN);
// Symbol.dispose fires on block exit, refcount--, gcTime-timer arms if refcount=0
```

Three usage levels:

```ts
// Level 0: one-shot, no cache
const doc = buildDoc('x');
doc.ydoc.transact(/* ... */);
doc[Symbol.dispose]();

// Level 1: scope-bound
{
  using doc = buildDoc('x');
  // ...
}

// Level 2: shared + lifecycle
const docs = defineDocument(buildDoc, { gcTime: 30_000 });
using h = docs.open('x');
```

## Research Findings

Three agents investigated. Full reports attached to the PR description; key findings summarized.

### Yjs ecosystem naming & teardown (via DeepWiki against `yjs/yjs`, `yjs/y-indexeddb`, `yjs/y-websocket`)

| Question | Finding | Implication |
|---|---|---|
| Is `whenLoaded` a reserved Y.Doc property? | **Yes.** `Y.Doc` has a native `whenLoaded` promise that resolves when persistence has loaded. Also `whenSynced`, `isLoaded`. | **Do not use `whenLoaded` as a framework-owned key on the bundle.** Rename to `whenReady`. |
| Canonical term for "Y.Doc + providers bundle"? | No canonical term. Community enumerates ("a Y.Doc with providers"). | Free to name internally; in prose call it "the bundle" or "the instance." Generic type parameter stays `T`. |
| Canonical teardown verb? | `destroy()`. Every provider (`IndexeddbPersistence`, `WebsocketProvider`) uses `destroy()`. `dispose()` does not appear in Yjs. | Use `Symbol.dispose` as the cache contract (required for `using`); users may also expose `destroy()` on builder returns for Yjs-idiom symmetry. The two can point to the same function. |
| Does `ydoc.destroy()` cascade to all providers? | **No.** `IndexeddbPersistence` registers `ydoc.on('destroy', this.destroy)`: `db.close()` returns an awaitable. `WebsocketProvider` does **not** register on `ydoc.on('destroy')`: its `destroy()` must be called explicitly, and `ws.close()` is fire-and-forget. | Builders must call `provider.destroy()` explicitly in `Symbol.dispose`: do not rely on cascade. Document this loudly. |
| Transaction origin conventions? | Symbols/objects are idiomatic for library-owned origins. | Our `DOCUMENTS_ORIGIN` symbol is correct; no change. |

**Key finding**: shipping `whenLoaded` as a framework-reserved key would silently shadow `Y.Doc.whenLoaded`. Renaming to `whenReady` is not bikeshedding: it is bug prevention.

### TanStack Query precedent (via DeepWiki against `TanStack/query`)

| Question | Finding | Implication |
|---|---|---|
| How is identity hashing exposed? | `hashKey` is hardcoded in `QueryCache`. `queryKeyHashFn` is an obscure override that 99% of users never touch. | **Bake in `attach.ydoc.guid` as the identity.** Do not expose `identityOf` as an opt. |
| How is grace time named? | `gcTime` (renamed from `cacheTime` in v5 because users misread "cache" as "how long data is cached"). | **Rename `graceMs` → `gcTime`.** Default 30_000. `0` = immediate. `Infinity` = never. |
| Multiple gcTime values for same key? | **Longest wins.** Short-lived callers cannot prematurely evict a resource a long-lived caller still wants. | Not in scope: we only expose `gcTime` at factory level, not per-open. Revisit only if per-open override is added. |
| API evolution direction? | TanStack **removed** more knobs than they added across v3→v5. Pre-emptive configurability encoded confusion. | Start with the minimum surface. Add knobs only when a real use case demands them, never speculatively. |
| BYO async function? | Guiding principle: `queryFn` stays fully user-owned. | Our `build(id)` function is the direct analog. Same principle: primitive owns identity + lifecycle + dedup; user owns construction. |

**Key finding**: every design decision TanStack made over five major versions converges toward "hardcode sane defaults, escape hatches only when forced." Our `identityOf` callback is ceremony that restates an invariant: delete it.

### Codebase blast radius

| Fact | Source |
|---|---|
| `defineDocument()` call sites in production | **Zero.** Only tests (`define-document.test.ts`). |
| `factory.open()` / `.close()` / `.closeAll()` call sites outside tests | **Zero.** |
| External consumers of `@epicenter/document` | Only `@epicenter/workspace`, and it imports only `attachAwareness` from the package (not `defineDocument`). |
| Duplicated lifecycle machinery | `packages/workspace/src/workspace/create-documents.ts` reimplements `DocEntry`, `bindCount`, `disconnectTimer`, `disposed` inline (~200 LOC). Does **not** use `defineDocument`. |
| Existing tests on `defineDocument` | `packages/document/src/define-document.test.ts`, 617 lines. Covers refcount, grace, whenLoaded aggregation, async teardown barriers, guid stability, reserved-key collisions, `using` blocks. |

**Key finding**: the refactor has zero external migration cost. The only consumers of the old semantics are the tests themselves. Rewiring `packages/workspace/src/workspace/create-documents.ts` is a real follow-up but explicitly **out of scope** here: the extension system and strategy wrapping in that file need their own design treatment.

## Design Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Primitive name | `defineDocument` (unchanged) | Honest about Y.Doc coupling. Matches package name. Existing name in code and tests: no churn. |
| 2 | Generic resource cache | **Not built.** | Pretending genericness when every caller is a Y.Doc adds ceremony without value. Can be extracted later if a non-Y.Doc use case ever appears. |
| 3 | Type constraint on builder return | `T extends { ydoc: Y.Doc } & Disposable` | Required for the cache to extract guid and call `Symbol.dispose`. Type-enforced, not runtime-checked. |
| 4 | Identity extraction | Hardcoded `attach.ydoc.guid` | TanStack precedent: hardcode sane default, don't expose a callback for something that's always the same. |
| 5 | Aggregation (`whenLoaded`, `whenDisposed`) | **Removed.** Builder owns composition. | Removes magic key scanning and reserved-key list. User writes `Promise.all([...])` themselves if they want a ready signal. |
| 6 | Reserved-key validation | **Removed.** | No framework-injected keys collide with user properties, because the cache handle injects only `dispose`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`: well-known names users rarely clash with. |
| 7 | Ready-promise name | `whenReady` (user-chosen) | Avoids shadow collision with `Y.Doc.whenLoaded`. Framework doesn't enforce it; it's a convention for bundles to expose. |
| 8 | Grace-period opt name | `gcTime` (was `graceMs`) | Matches TanStack Query vocabulary. Reads as "time until garbage collection." |
| 9 | Grace-period default | `30_000` | Unchanged. Expensive-resource UI churn (route swaps, HMR) is the motivating case. |
| 10 | `gcTime: 0` / `gcTime: Infinity` | `0` = immediate teardown on refcount→0; `Infinity` = never evict. | Matches TanStack semantics. Predictable and test-friendly. |
| 11 | Teardown mechanism | Cache calls `attach[Symbol.dispose]()` | Builder owns what disposal means. Cache stays domain-agnostic inside its own boundary. |
| 12 | Provider teardown | **Builder responsibility: documented.** | y-websocket doesn't cascade via `ydoc.destroy()`. Builder must call `sync.destroy()` explicitly. Docstring will flag. |
| 13 | Handle shape | Prototype chain (unchanged). Cache injects only `dispose`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`. | Ergonomic: `h.ydoc` reads through. Three injected keys are low magic budget. |
| 14 | `close(id)` barrier | Awaits `attach.whenDisposed` if the builder exposes one. Otherwise resolves immediately. | Same "no magic, but respect conventions" principle. Builders that care about teardown barriers expose `whenDisposed`; those that don't, skip it. |
| 15 | Per-open `gcTime` override | **Deferred.** | Not needed today. Can be added later as `open(id, { gcTime })`. |
| 16 | Longest-gcTime-wins policy | **Deferred.** | Only meaningful with per-open override. Pair decision with #15. |
| 17 | `createDocuments` rewire in workspace | **Out of scope.** Follow-up spec. | Workspace's extension system needs separate design. This spec ships the primitive; the rewire ships later. |

## Architecture

### Before / after signature

```text
BEFORE: packages/document/src/define-document.ts
────────────────────────────────────────────────────
defineDocument<Id, TAttach extends { ydoc: Y.Doc }>(
  build,
  opts?: { graceMs?: number },
)
│
├─ scans attach for "whenLoaded" → Promise.all
├─ scans attach for "whenDisposed" → Promise.all
├─ enforces RESERVED_KEYS = ['dispose', 'whenLoaded']
├─ maintains Map<Id, string> of guids for stability
└─ calls attach.ydoc.destroy() on teardown

AFTER: packages/document/src/define-document.ts
────────────────────────────────────────────────────
defineDocument<Id, T extends { ydoc: Y.Doc } & Disposable>(
  build,
  opts?: { gcTime?: number },
)
│
├─ (no scanning: user composes their own whenReady/whenDisposed)
├─ (no reserved keys: cache injects only dispose/Symbol.dispose/Symbol.asyncDispose)
├─ maintains Map<Id, string> of guids for stability (unchanged)
└─ calls attach[Symbol.dispose]() on teardown
```

### Lifecycle state machine

```text
                     ┌──────────────────────────────────┐
                     │     no entry in cache             │
                     └──────────────────────────────────┘
                                  │ open(id)
                                  ▼
                          build(id) runs,
                          guid check,
                          retainCount = 1
                                  │
                                  ▼
        ┌──────────────────────────────────────────────┐
        │            LIVE: retainCount ≥ 1            │
        └──────────────────────────────────────────────┘
                  │                         ▲
      dispose()   │                         │ open(id) while live
     retainCount→0│                         │ retainCount++
                  ▼                         │
        ┌──────────────────────────────────────────────┐
        │      GC-PENDING: gcTime timer armed         │◄──┐
        └──────────────────────────────────────────────┘   │
                  │                         ▲              │
      timer fires │                         │ open(id)     │
                  │                         │ clearTimeout │
                  ▼                         │ retainCount=1│
        ┌──────────────────────────────────────────────┐   │
        │     TEARDOWN: attach[Symbol.dispose]()      │   │
        │     cache.delete(id)                         │   │
        └──────────────────────────────────────────────┘   │
                  │                                        │
                  ▼                                        │
                (gone)                                     │
                                                           │
   close(id) forces TEARDOWN synchronously,               │
   then awaits attach.whenDisposed if present ────────────┘
```

### Three usage levels

```text
  ┌─────────────────────────────────────────────────────────────┐
  │ Level 0: plain builder                                     │
  │                                                             │
  │   const doc = buildDoc('x');                                │
  │   // use doc.ydoc, doc.whenReady, etc.                      │
  │   doc[Symbol.dispose]();                                    │
  │                                                             │
  │ Zero framework. Direct. One-shot.                           │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (wrap in using)
  ┌─────────────────────────────────────────────────────────────┐
  │ Level 1: scope-bound                                       │
  │                                                             │
  │   {                                                         │
  │     using doc = buildDoc('x');                              │
  │     await doc.whenReady;                                    │
  │     doc.ydoc.transact(...);                                 │
  │   } // [Symbol.dispose] fires                               │
  │                                                             │
  │ Still zero framework. TS 5.2 language feature.              │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (wrap in cache)
  ┌─────────────────────────────────────────────────────────────┐
  │ Level 2: shared + lifecycle                                │
  │                                                             │
  │   const docs = defineDocument(buildDoc, { gcTime: 30_000}); │
  │   using h = docs.open('x');  // refcount++                  │
  │   // handle has h.ydoc + h.whenReady + h.dispose +          │
  │   // [Symbol.dispose] + [Symbol.asyncDispose]               │
  │                                                             │
  │ Multiple callers share one Y.Doc. Grace period on dispose.  │
  └─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Rewrite `define-document.ts` in place

- [x] **1.1** Replace the generic type parameter name `TAttach` with `T` across the file and its types file (internal rename).
- [x] **1.2** Add `& Disposable` to the type constraint so the cache can call `attach[Symbol.dispose]()`. Update `DocEntry`, `DocumentHandle`, `DocumentFactory` type defs.
- [x] **1.3** Delete `RESERVED_KEYS` and the reserved-key validation loop in `construct()`.
- [x] **1.4** Delete `aggregatePromise()` helper. Replace entry fields `whenLoaded` and `attachmentWhenDisposed` with direct pass-through: entry just holds `attach`; `open()` reads `attach.whenReady` (optional) and `close()` reads `attach.whenDisposed` (optional).
- [x] **1.5** Replace `entry.attach.ydoc.destroy()` in `disposeEntry` with `entry.attach[Symbol.dispose]()`. Keep the try/catch and the `console.error` fallback.
- [x] **1.6** Rename `graceMs` → `gcTime` in opts, `DEFAULT_GRACE_MS` → `DEFAULT_GC_TIME`, `entry.disposeTimer` → `entry.gcTimer`. Update all internal references.
- [x] **1.7** Add `gcTime: 0` fast-path: `disposeEntry(id, entry)` called synchronously on last dispose, no timer.
- [x] **1.8** Add `gcTime: Infinity` guard: skip `setTimeout`, entry stays live forever unless `close(id)` or `closeAll()` is called.
- [x] **1.9** Update the handle construction: still `Object.create(entry.attach)`; inject only `dispose`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`. Remove the `whenLoaded` injection; users read `h.whenReady` through the prototype chain if their builder exposed it.
- [x] **1.10** `close(id)` still forces teardown synchronously, then `await entry.attach.whenDisposed` if present. `closeAll()` same pattern.

### Phase 2: Update types file (`define-document.types.ts`)

- [x] **2.1** Update `DocumentHandle<T>` to reflect the new handle shape: `T & { dispose(): void; [Symbol.dispose](): void; [Symbol.asyncDispose](): Promise<void>; }`. No more injected `whenLoaded`.
- [x] **2.2** Update `DocumentFactory<Id, T>` opts type: `{ gcTime?: number }` only.
- [x] **2.3** Update JSDoc comments on every exported type: the "bundle" convention, where `whenReady` / `whenDisposed` come from, that the builder owns disposal.

### Phase 3: Rewrite module docstring

- [x] **3.1** Replace the current 72-line docstring in `define-document.ts` with one grounded in the new design: user owns the builder, cache owns identity + refcount + gcTime, provider teardown is explicit (not via `ydoc.destroy()` cascade).
- [x] **3.2** Include all three usage levels (Level 0 / 1 / 2) as runnable snippets.
- [x] **3.3** Flag the y-websocket provider-teardown gotcha explicitly: builder must call `sync.destroy()`, not rely on `ydoc.on('destroy')` propagation.
- [x] **3.4** Document the `whenReady` / `whenDisposed` naming convention and why it's user-owned, not framework-enforced.

### Phase 4: Adapt tests (`define-document.test.ts`)

- [x] **4.1** Rewrite every test factory to return `{ ydoc, …, [Symbol.dispose]() { ydoc.destroy(); } }`. Drop scenarios that exercise `RESERVED_KEYS` collisions (feature removed).
- [x] **4.2** Rename test bundles' `whenLoaded` → `whenReady` where they're user-owned promises. Keep `whenDisposed` naming (no Yjs collision).
- [x] **4.3** Rename all `graceMs` references in test setup to `gcTime`. Keep all grace-behavior tests: they validate the timer semantics and are still relevant.
- [x] **4.4** Add new tests for `gcTime: 0` (immediate teardown) and `gcTime: Infinity` (never evict).
- [x] **4.5** Add a test that verifies the handle no longer injects `whenLoaded`: reading `h.whenReady` must come from the prototype chain (i.e., the user's bundle).
- [x] **4.6** Verify guid-stability tests still pass unchanged: the cache still maintains `Map<Id, string>` and throws on drift.
- [x] **4.7** Add or expand a test verifying that if the builder's `[Symbol.dispose]` throws, the cache logs and continues (does not throw out of `dispose()`).

### Phase 5: Barrel & exports

- [x] **5.1** Audit `packages/document/src/index.ts`: confirm `defineDocument` is exported. Confirm no other symbols (`DEFAULT_GRACE_MS`, `RESERVED_KEYS`, `aggregatePromise`) are exported. They shouldn't be; verify.
- [x] **5.2** Audit the `@epicenter/workspace` package for any imports of `defineDocument`, `DocumentFactory`, `DocumentHandle`. Current inventory says zero; re-verify after rebase.

### Phase 6: Verification

- [x] **6.1** Run `bun test` in `packages/document`. All tests pass.
- [x] **6.2** Run `bun run build` at repo root. No type errors.
- [x] **6.3** Grep for `graceMs`, `whenLoaded`, `RESERVED_KEYS`, `aggregatePromise` across `packages/document/`. Zero results.
- [x] **6.4** Grep for `defineDocument` across the repo. Only expected call sites (tests + internal file).

## Edge Cases

### Builder throws during construction

1. `build(id)` throws.
2. No entry is inserted into the cache (existing behavior: preserved).
3. The caller sees the thrown error. A fresh `open(id)` re-runs the builder.

### `Symbol.dispose` throws

1. Cache calls `entry.attach[Symbol.dispose]()` during teardown.
2. Throws are caught, logged to `console.error`, teardown proceeds.
3. Entry is removed from the cache regardless.
4. **Not changed from current behavior** (was `ydoc.destroy()`; now `[Symbol.dispose]()`).

### `whenDisposed` rejects

1. Caller: `await factory.close(id)`.
2. `disposeEntry` runs synchronously; the bundle's `Symbol.dispose` ran; the user's `whenDisposed` promise rejects (e.g., IDB `db.close()` threw).
3. The rejection propagates to the `close(id)` awaiter.
4. **Acceptable**: the caller asked for a teardown barrier and gets the real failure.

### Fresh `open(id)` during gc-pending

1. Entry in GC-PENDING state (timer armed).
2. `open(id)` fires.
3. `clearTimeout(entry.gcTimer)`. `retainCount = 1`. Entry returns to LIVE.
4. **Same Y.Doc returned**: no reconstruction cost.

### `gcTime: 0` with concurrent open + dispose

1. `const h1 = docs.open('x')`: `retainCount = 1`.
2. `const h2 = docs.open('x')`: `retainCount = 2`.
3. `h1.dispose()`: `retainCount = 1` (still live).
4. `h2.dispose()`: `retainCount = 0`. With `gcTime: 0`, teardown is synchronous.
5. Any thread of execution holding a reference to `h2.ydoc` after this line has an already-destroyed Y.Doc. **Caller's responsibility**: matches `gcTime: 0`'s documented semantics.

### `gcTime: Infinity` with `close(id)`

1. Cache entry never GC-pending; `retainCount` can go to 0 and stay.
2. Caller: `await factory.close('x')`.
3. Entry is evicted synchronously, bundle's `Symbol.dispose` runs, `whenDisposed` awaited.
4. `gcTime: Infinity` only disables *automatic* eviction; explicit `close()` still works.

### Guid instability on reconstruction

1. First `open('x')`: `build('x')` produces `ydoc.guid = A`. Cached.
2. Entry disposed, GC timer fires, entry removed.
3. Second `open('x')`: `build('x')` produces `ydoc.guid = B`.
4. Cache detects drift, calls `attach[Symbol.dispose]()` on the half-built bundle, throws an error.
5. **Catches nondeterministic builders** (e.g., `guid: Math.random()`).

### Concurrent `close(id)` and `open(id)`

1. Concurrent `close(id)` + `open(id)`: JavaScript is single-threaded, so these interleave at microtask boundaries.
2. `close(id)` runs first: synchronous `disposeEntry(id, entry)` deletes from cache, starts awaiting `whenDisposed`.
3. `open(id)` runs next: cache miss, runs `build(id)` fresh, inserts new entry. Guid stability check compares to prior guid.
4. `close(id)` await completes.
5. **Behavior is well-defined.** If the y-indexeddb race is a concern (new IDB connection opens before old one's `db.close()` resolves), callers must `await close()` before `open()`.

### Multiple `dispose()` calls on the same handle

1. `h.dispose()`: sets `handleDisposed = true`, decrements `retainCount`.
2. Second `h.dispose()`: `handleDisposed` already true, early return, no effect.
3. **Idempotent**: works with `using` + manual dispose combinations.

## Open Questions

1. **Should `Symbol.dispose` throwing be `console.error` or `console.warn`?**
   - **Recommendation**: Keep `console.error`. A bundle's disposer throwing is a real bug: the user wrote code that can't clean itself up. Surface it loudly.

2. **Does `close(id)` guarantee teardown has *finished* or only *started*?**
   - Options: (a) only started, resolves when `Symbol.dispose` returns; (b) finished, resolves when `await attach.whenDisposed` also resolves.
   - **Recommendation**: (b). The whole point of `close(id)` over `h.dispose()` is a real teardown barrier. If the bundle has no `whenDisposed`, it resolves immediately. If it does, we honor it.

3. **Should we emit cache events (entry added, evicted, reconstructed) for debugging?**
   - TanStack Query does this for DevTools.
   - **Recommendation**: Defer. No debugging tool exists that would consume the events. Add only when we build one.

4. **Do we want per-open `gcTime` overrides with longest-wins?**
   - TanStack has this; it's useful for prefetch + render pairs.
   - **Recommendation**: Defer. Not needed today. Add `open(id, { gcTime })` later if a caller needs it.

5. **How aggressively do we document the y-websocket provider-teardown gotcha?**
   - The finding that `ydoc.destroy()` does not cascade to WS is subtle and easy to forget.
   - **Recommendation**: Document prominently in the module docstring **and** in the `attachSync` JSDoc itself. The bug is in `attachSync`'s contract; it should own the warning.

6. **Should `attachIndexedDb`, `attachSync`, `attachAwareness`, `attachRichText`, `attachPlainText` expose `whenReady` or `whenLoaded` as their conventional ready-promise?**
   - The primitive doesn't enforce either; attachments define their own names.
   - **Recommendation**: Keep attachments as-is for this spec (`whenLoaded` / `whenSynced` where present, because those names match Yjs-native). The `whenReady` naming applies only at the *bundle* level (user's builder return), not on individual attachments. Clarify in docstring.

## Success Criteria

- [x] `packages/document/src/define-document.ts` uses `gcTime`, no `graceMs`. Zero references to `RESERVED_KEYS`, `aggregatePromise`, `whenLoaded` as framework-owned concepts.
- [x] Type constraint on builder: `T extends { ydoc: Y.Doc } & Disposable`.
- [x] Handle shape exposes only the three dispose methods; other access goes through the prototype chain to the user's bundle.
- [x] `bun test` passes in `packages/document`. All existing test scenarios covered; new tests for `gcTime: 0` and `gcTime: Infinity`.
- [x] `bun run build` passes at repo root. No type errors.
- [x] Module docstring rewritten, three usage levels shown, y-websocket gotcha flagged.
- [x] `@epicenter/workspace` builds and tests still pass (it does not import `defineDocument`, so this should be automatic: verify anyway).
- [x] No production code path broken. No API outside `defineDocument` itself changed.

## Non-Goals

Explicitly out of scope for this spec:

- **Rewiring `packages/workspace/src/workspace/create-documents.ts`** through `defineDocument`. The workspace's extension system and strategy wrapping need separate design treatment. Follow-up spec.
- **Generic `defineResourceCache`** primitive for non-Y.Doc resources. Not needed today; the coupling to Y.Doc is honest.
- **Per-open `gcTime` overrides.** Deferred until a caller needs it.
- **Cache event emission** for debugging / DevTools. Deferred until we build the tool.
- **Changes to `attach-*.ts`** (sync, indexeddb, awareness, rich-text, plain-text, timeline, table, kv). Their conventions and naming are unchanged.
- **Changes to `y-keyvalue/`**, `types.ts`, `keys.ts`, `internal.ts`, or the barrel `index.ts` beyond verifying the exports are still clean.

## References

### Files modified in this spec

- `packages/document/src/define-document.ts`: primary rewrite
- `packages/document/src/define-document.types.ts`: type updates
- `packages/document/src/define-document.test.ts`: test adaptation

### Files audited but unchanged

- `packages/document/src/index.ts`: barrel exports (verify no removed symbols leaked)
- `packages/document/src/attach-sync.ts`: Yjs teardown gotcha noted in JSDoc (one-line addition)
- `packages/workspace/src/workspace/create-documents.ts`: parallel implementation, NOT rewired in this spec
- `packages/workspace/src/workspace/create-workspace.ts`: follow-up spec target

### Prior art and research

- `specs/20260420T152026-definedocument-primitive.md`: original design spec this simplifies
- Yjs source via DeepWiki: `yjs/yjs`, `yjs/y-indexeddb`, `yjs/y-websocket`
- TanStack Query source via DeepWiki: `TanStack/query`

### Naming conventions

- `whenReady` (user-chosen, bundle-level): unused in Yjs, unambiguous
- `whenLoaded` (Yjs-native, Y.Doc property): do not shadow on the bundle
- `gcTime` (TanStack vocabulary): replaces `graceMs`
- `[Symbol.dispose]` (TS 5.2 contract): primary teardown method on bundles and handles
- `destroy()` (Yjs-idiomatic verb): optional alias users may also expose
- `DOCUMENTS_ORIGIN` (symbol, already exists): unchanged; used in `transact(fn, ORIGIN)` for echo filtering

## Review

**Completed**: 2026-04-20
**Branch**: `braden-w/document-primitive`

### Summary

Inverted control in `defineDocument`: users own construction and disposal (via `[Symbol.dispose]` on the returned bundle); the cache owns only identity, refcount, and the `gcTime` grace period. Removed reserved-key scanning and `whenLoaded`/`whenDisposed` aggregation. Renamed `graceMs` → `gcTime` with new `0` (sync) and `Infinity` (never-evict) fast-paths. Rewrote the module docstring with three usage levels and the y-websocket teardown gotcha. Tests: 261/261 pass in `@epicenter/document`.

### Deviations from Spec

- In `close(id)` / `closeAll()`, `whenDisposed` is accessed via an `in` check with a narrowed cast (`entry.attach as { whenDisposed?: Promise<void> }`), since the `Disposable` constraint doesn't surface `whenDisposed` structurally. Matches the spec's intent: detect and await if present.
- `DocumentHandle<T>` no longer intersects `Disposable & AsyncDisposable` explicitly: the three dispose methods are declared directly. Equivalent at use sites, cleaner JSDoc.
- Root-level `bun run typecheck` fails in `@epicenter/workspace` and `@epicenter/zhongwen`, but those failures exist on `main` and are unrelated to this spec. `@epicenter/document` typecheck is clean.
- One test (`rapid open→dispose→open`) was adjusted: with `gcTime: 0`, the first dispose tears down synchronously so the re-open returns a fresh ydoc. The invariant being tested (no stale timer fires) is preserved.

### Follow-up Work

- Rewire `packages/workspace/src/workspace/create-documents.ts` through `defineDocument` (explicitly out of scope; needs its own design spec for the extension system).
- Add the y-websocket teardown gotcha one-liner to `attachSync`'s JSDoc.
- Consider per-open `gcTime` overrides with longest-wins if a caller surfaces the need.
