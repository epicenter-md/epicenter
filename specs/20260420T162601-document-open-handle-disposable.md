# Document factory redesign: `.open()` returning a disposable handle

## Status

Proposed. Builds on `defineDocument` primitive (commits `67f3cd81c`, `d7ef3b4e7`, `fce3dd52f`). No call sites have migrated to `defineDocument` yet: clean-break window is open.

## Problem

The current primitive has a latent leak class: `.get(id)` constructs a cached handle but does not retain it. Retention requires a separate `handle.retain()` call. A caller who forgets `retain()` gets a doc that sits in the cache until `close`/`closeAll`: the grace-period timer only fires on 1→0 transitions, never on 0→0.

Two secondary issues:

- `handle.retain()` exposes the retain mechanism on the wrong object. The handle is what you use; the factory is what owns lifecycle. Putting `retain` on the handle invites stale-handle misuse (retain after close is a silent no-op).
- No idiomatic path for "I need this doc for the duration of this scope." Callers hand-write `const release = h.retain(); try { ... } finally { release(); }`. TS 5.2 `using` eliminates this pattern: we should adopt it.

## Design

### Shape

```ts
// Factory API
type DocumentFactory<Id, TAttach> = {
  /** Retain + construct in one step. Returns a disposable handle. */
  open(id: Id): DocumentHandle<TAttach>;

  /** Retain + wait for `whenLoaded`. Returns a disposable handle. */
  read(id: Id): Promise<DocumentHandle<TAttach>>;

  /** Non-retaining cache lookup. Returns undefined if not open. Does NOT construct. */
  peek(id: Id): DocumentHandle<TAttach> | undefined;

  /** Force immediate disposal. Awaits attachment teardown. */
  close(id: Id): Promise<void>;
  closeAll(): Promise<void>;
};

// Handle API
type DocumentHandle<TAttach> = TAttach & {
  whenLoaded: Promise<void>;

  /** Release this retain. Idempotent. Starts grace-period timer on last release. */
  release(): void;

  /** Disposable protocol: `using h = docs.open(id)` calls this on scope exit. */
  [Symbol.dispose](): void;
  /** Async-disposable protocol: `await using h = await docs.read(id)` calls this. */
  [Symbol.asyncDispose](): Promise<void>;
};
```

### Critical design decisions

**No destructuring.** The handle IS the retain. One object, used directly. `h.content.write(...)` rather than `result.handle.content.write(...)`. Manual release: `h.release()`.

**Scope exit = release, not close.** `using` invokes `[Symbol.dispose]` which calls `release()`: not `close()`. Reason: `using` is about ownership handoff. If another caller still retains the doc, grace timer gets cancelled by their retain. Forcing destroy on every scope exit would defeat the ref-count. Callers who want hard teardown call `await factory.close(id)` explicitly.

**Each `open()` call returns a distinct disposable wrapper over the same underlying handle.** Two `open('a')` calls return two handles that share the `ydoc` and attachments but have independent `release()` state. This keeps retain counting honest: N opens requires N releases. Internally, the cached attach object is the same; each `open()` mints a fresh disposable view.

Wait. This conflicts with today's "same handle instance for same id" invariant (tested in `get returns the same handle instance for the same id`). Resolution: drop that invariant. It wasn't load-bearing: callers don't rely on reference equality. The observable contract becomes "same `ydoc`, same attachments" (which falls out of the cache), not "same handle object." This is actually MORE correct: reference equality on the handle was accidentally true under `.get()` but shouldn't have been contractual under a retain model.

**`peek` does not construct.** Non-retaining cache lookup. Returns `undefined` if no entry exists. This is the escape hatch for observers that want to read state without keeping it alive.

**`read` is async-disposable.** `await using h = await docs.read(id)` works. `[Symbol.asyncDispose]` on the handle calls `release()` synchronously and resolves; we don't await attachment teardown on scope exit (same reasoning as `using`).

### API examples

```ts
// Manual retention
const h = docs.open('abc');
h.content.write('hi');
h.release();

// Scope-bound retention (preferred for most call sites)
{
  using h = docs.open('abc');
  h.content.write('hi');
}  // release fires here

// Async: wait for whenLoaded before using
{
  await using h = await docs.read('abc');
  const text = h.content.read();
  // release fires on scope exit
}

// Non-retaining inspection: caller does NOT need to release
const maybe = docs.peek('abc');
if (maybe) console.log(maybe.content.read());
// maybe is a stale snapshot if no one else retains it:
// intentional: peek is for "is it alive right now?"

// Svelte integration
$effect(() => {
  using h = docs.open(id);
  // reads inside this effect re-run when deps change; release fires on cleanup
  return () => h.release();  // or rely on `using` if scope allows
});
```

## Implementation waves

### Wave 1: additive: introduce `open`/`peek`/`Disposable` (non-breaking)

**Files to change:**

- `packages/document/src/define-document.types.ts`
  - Add `[Symbol.dispose]` and `[Symbol.asyncDispose]` to `DocumentHandle`.
  - Rename `retain()` → `release()` in the type (the handle now represents one retain, not a factory of retains).
  - Add `open(id)` and `peek(id)` to `DocumentFactory`.
  - Keep `get(id)` but mark `@deprecated: use open() + release(), or peek() for non-retaining reads`.

- `packages/document/src/define-document.ts`
  - Internally: the cached `DocEntry` stays. Each `open()` mints a fresh disposable wrapper object around the cached attach, carrying its own `released: boolean` flag and independent release closure. The wrapper proxies to the cached attach for property reads (via `Object.create(cachedAttach)` or a Proxy).
  - Increment `bindCount` on `open()`. Decrement on `release()` (idempotent per wrapper).
  - `[Symbol.dispose]` = `release()`. `[Symbol.asyncDispose]` = `release()` (sync under the hood, returns resolved promise).
  - `peek(id)` = `openDocuments.get(id)?.handle`: returns the cached attach without incrementing count. Note: this returns the bare attach (no `release`, no `Symbol.dispose`); its type is `TAttach & { whenLoaded }` without the disposable fields.
  - Keep `get()` + `handle.retain()` for one release cycle. Both emit a dev-mode `console.warn` on first call per factory.

**Type split:** `DocumentHandle` becomes two types:
```ts
type DocumentSnapshot<TAttach> = TAttach & { whenLoaded: Promise<void> };
type DocumentHandle<TAttach> = DocumentSnapshot<TAttach> & Disposable & AsyncDisposable & {
  release(): void;
};
```
`peek` returns `DocumentSnapshot`. `open`/`read` return `DocumentHandle`.

**Tests (new):**

- `open() retains: ref-count increments`
- `open() + release(): grace timer fires, ydoc destroyed`
- `two open() calls on same id return distinct wrappers but share ydoc/attachments`
- `two open() calls require two releases before grace timer starts`
- `using h = docs.open(id): releases on scope exit`
- `await using h = await docs.read(id): releases on scope exit`
- `peek(id) on unopened id returns undefined`
- `peek(id) on open id returns snapshot without retaining`
- `peek(id) snapshot has no release() or Symbol.dispose`
- `release() is idempotent per wrapper`
- `release() on one wrapper does not affect others`
- Existing `get` + `retain` tests stay, now under a `describe('deprecated API')` block.

**TS target check:** need `"target": "es2022"` + `"lib"` includes `"esnext.disposable"` for `Symbol.dispose` / `Symbol.asyncDispose`. Verify in `packages/document/tsconfig.json` and root `tsconfig.base.json`. If missing, add `"esnext.disposable"` to `lib`.

**Runtime `Symbol.dispose` polyfill:** Node 22+/Bun have it. Verify Bun version; if < 1.1.14 add `Symbol.dispose ??= Symbol.for('nodejs.dispose')` in the entry.

### Wave 2: migrate the one consumer

Currently no consumer. `packages/workspace/src/workspace/create-documents.ts` has its own `DocumentHandle` type and wraps the primitive internally: verify whether it calls `factory.get` + `handle.retain` anywhere. If so, migrate each call to `open()` + `using` or explicit `release()`.

Grep patterns to audit:
```
rg '\.retain\(\)' packages/
rg 'defineDocument' --type ts
rg '\.get\(' packages/document packages/workspace  # false-positive heavy: eyeball
```

For each hit: pair every retain with a release, convert to `open()` or `using`.

### Wave 3: delete the deprecated API

- Remove `factory.get(id)` and `handle.retain()`.
- Remove the `DocumentHandle` → `retain` field; `DocumentHandle` becomes just `DocumentSnapshot` plus disposable.
- Update `RESERVED_KEYS` in `define-document.ts`: drop `retain`, keep `whenLoaded`. Add `release` and `[Symbol.dispose]` / `[Symbol.asyncDispose]` as reserved? Users can't literally return symbol keys from an object literal, but defensive check on string form isn't worthwhile. Just `release` and `whenLoaded`.
- Delete `bindCount` → `retainCount` rename (internal; no external contract).
- Bump `@epicenter/document` to `0.x+1` or `1.0` depending on publishing state.

## Open questions

1. **Handle identity under `open`.** Wave 1 ships with "two `open()` calls = two distinct wrapper objects, same underlying attachments." Is this acceptable, or do consumers (particularly Svelte's `$state` / reactivity machinery) rely on reference equality? If yes, alternative: one wrapper, stack of release closures internal to it. Mildly uglier, preserves identity.

2. **Proxy vs. Object.create for the wrapper.** `Object.create(cachedAttach)` is faster but inherits prototype properties too: might surface framework-added `ydoc.on` / etc. if the cached attach is the Y.Doc's descendant. Proxy has overhead but clean trapping. Benchmark Wave 1 with Object.create first; fall back to Proxy if something misbehaves.

3. **Should `peek` auto-`whenLoaded`-check?** No. `peek` is sync and returns `DocumentSnapshot`. Callers that want readiness should `await factory.read(id)` and retain.

4. **Drop the `get` deprecation window entirely?** Since no call sites exist, Wave 3 could merge into Wave 1 as one breaking commit. Keep waves separate if there's any risk of accidental in-flight consumers on other branches. Otherwise collapse.

## Non-goals

- Framework-owning `Y.Doc` construction (ydoc-ownership inversion). Rejected: breaks the composition model where users stack `attach*(ydoc, …)` calls.
- Changing `close` / `closeAll` semantics. They stay async; still called manually for hard teardown.
- Changing `onLocalUpdate` / `DOCUMENTS_ORIGIN`. Unrelated.
- Higher-level sugar (`defineWorkspaceDocument`, `defineSimpleDocument`). Separate spec.

## Success criteria

- `using h = docs.open(id)` and `await using h = await docs.read(id)` work and release on scope exit.
- `h.release()` manual path works identically.
- `peek(id)` does not construct.
- All pre-existing lifecycle tests pass (grace timer, multi-retain, close-during-grace, etc.), rewritten to use `open`/`release`.
- Zero call sites use `factory.get` or `handle.retain` after Wave 3.
