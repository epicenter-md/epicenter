# Lazy Disposers, Bundle Owns Wipe

**Date**: 2026-05-04
**Status**: Implemented
**Superseded by**: `specs/20260504T230000-attach-whendisposed-honest-barriers.md` for the attach-level `[Symbol.asyncDispose]` direction. The cleanup work outside that barrier shape still stands.
**Author**: AI-assisted (Claude)
**Branch**: codex/sync-create-auth (or successor)
**Builds on**: `specs/20260504T020000-workspace-identity-reset-deterministic-teardown.md`: the implemented teardown moved ORDER into the call site (`resetLocalClient`); this spec moves the order INSIDE the bundle and replaces `whenDisposed` with `Symbol.asyncDispose` backed by `lazy()`.

## One-Second Summary

Each `attach*` primitive that does genuine async teardown exposes `[Symbol.asyncDispose]` via `lazy()`, so the disposer is idempotent and dedups against the cascade. The bundle's `wipe()` (renamed from `clearLocalData`) owns the full teardown sequence: dispose live providers, delete persisted state. `whenDisposed` deletes from the codebase.

## One-Sentence Test

Disposal is type-driven (`Symbol.dispose` for sync, `Symbol.asyncDispose` for genuine async, both backed by `lazy()`); the bundle's `wipe()` owns the dispose-then-clear sequence so consumers write one line; `whenDisposed` exists nowhere in source.

If the design retains `whenDisposed` on any attachment, leaves a `let destroyPromise = null` flag in any builder, expects a caller to compose `dispose() then clearLocalData()` in the right order, keeps the explanatory comment block in `resetLocalClient`, or keeps `isThenable(sync.whenDisposed)` as CLI duck-type validation, the design is not clean yet.

## Overview

The implemented identity-reset spec installed the correct teardown ORDER but kept it as a sequence of calls in `resetLocalClient`:

```ts
// today
async resetLocalClient() {
  try {
    fuji[Symbol.dispose]();          // caller knows: dispose first
    await fuji.clearLocalData();      // caller knows: then clear
  } catch (error) { ... }
  finally { window.location.reload(); }
}
```

This requires every `client.ts` to ship a comment block explaining the order (every browser app has it today: `apps/fuji/client.ts:29-37` and equivalents). The ordering knowledge leaks across the bundle/caller boundary.

This spec moves the sequence INSIDE the bundle. The caller becomes:

```ts
// proposed
async resetLocalClient() {
  try {
    await fuji.wipe();                // bundle owns the order; nothing else to know
  } catch (error) { ... }
  finally { window.location.reload(); }
}
```

To make `wipe()` safe (the in-bundle dispose and the cascade-triggered dispose must dedup), each async attachment exposes `[Symbol.asyncDispose]` backed by `lazy()`. The cascade and the explicit call share the same memoized Promise. No `let destroyPromise = null` flag anywhere; `lazy()` encapsulates the mutable state.

`whenDisposed` is replaced everywhere by `await attachment[Symbol.asyncDispose]()`. The CLI's `isThenable(sync.whenDisposed)` duck-type is dropped (the CLI never reads the value; it's a vestigial shape check from `specs/20260501T120000-daemon-peer-runtime-contract.md`).

## Why this is the right scope

This is a refinement of the implemented identity-reset spec, not a redesign. That spec's lever was "make teardown deterministic" and chose to install determinism at the call site. Two follow-on smells survived:

1. **Ordering knowledge in `client.ts`.** Every browser app ships the same comment block explaining the dispose-then-clear sequence. Identical shape, different cache-field name per app. That's repetition, not honest composition.
2. **`whenDisposed` is a public composition primitive.** It exists for daemons and tests, but its presence on every async attachment plus the CLI's vestigial duck-type makes it feel like a public surface. It isn't: no consumer actually waits on it for behavior, only for ordering.

Both smells point at the same root: "barrier promises as public properties." Replacing them with `Symbol.asyncDispose` on the attachment + `wipe()` on the bundle:
- Names the operation, not the event.
- Lets TypeScript route sync vs async via `using` / `await using`.
- Encapsulates idempotency in one tested helper (`lazy()`).
- Lets the CLI's umbrella validator shrink to what `up.ts` actually invokes.

## Grounding

**Yjs / y-indexeddb** (verified earlier in this branch):
- `Y.Doc.destroy()` is sync; `emit('destroy')` uses `forEach` and discards listener Promise returns.
- `IndexeddbPersistence.destroy()` has NO top-level `_destroyed` guard. Two calls produce two independent `_db.then(db => db.close())` Promises. `IDBDatabase.close()` is spec-idempotent, so this is "fine in practice" but the second Promise resolves after the first; any `whenDisposed` synthesized by awaiting one returns before the other settles.
- `IndexeddbPersistence` constructor binds `doc.on('destroy', this.destroy)`. To make our wrapper the single dispose path, we must `ydoc.off('destroy', idb.destroy)` after construction.

**lazy()**: `packages/workspace/src/document/y-keyvalue/lazy.ts` already implements the memoization pattern. It wraps `let value; let initialized` and returns a function that computes once then caches. Used by `y-keyvalue-lww.ts` and the markdown materializer. For dispose dedup the type is `lazy(() => Promise<void>)`: first call kicks off the async work and caches the Promise, every subsequent call returns the same Promise. Ordinary `lazy()`, no async variant needed (a Promise is a value).

**CLI** (sub-agent verified): `packages/cli/src/load-config.ts:147` does `isThenable(sync.whenDisposed)` as part of `hasDaemonRuntimeShape`. The CLI never reads `sync.whenDisposed` after the check. The actual barrier the CLI uses is `runtime[Symbol.asyncDispose]()` at line 217. The duck-type is dead validation, a tombstone from the daemon-peer-runtime contract spec.

**Existing daemon shape**: `apps/*/daemon.ts` already ships `Symbol.asyncDispose`:

```ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync.whenDisposed;        // → after this spec: await sync[Symbol.asyncDispose]()
}
```

Same pattern, different barrier source. Mechanical migration.

## Motivation

### Current state (implemented identity-reset spec)

```ts
// apps/fuji/src/lib/fuji/client.ts
async resetLocalClient() {
  try {
    // The workspace bundle owns teardown order. Its disposer closes child
    // document caches and destroys the root Y.Doc, which tells attachments
    // like sync, broadcast channel, and y-indexeddb to stop before local
    // IndexedDB data is deleted.
    fuji[Symbol.dispose]();
    // This is safe after disposal. y-indexeddb deletes by database name,
    // and any row data needed to compute child document names remains
    // readable from memory after Y.Doc.destroy(); disposal has already
    // stopped observers and providers.
    await fuji.clearLocalData();
  } catch (error) {
    toast.error('Could not clear local data', { description: extractErrorMessage(error) });
  } finally {
    window.location.reload();
  }
},
```

```ts
// packages/workspace/src/document/attach-indexed-db.ts
ydoc.once('destroy', async () => {
  try { await idb.destroy(); }      // duplicate of upstream auto-bound destroy
  finally { resolveDisposed(); }    // resolves whenDisposed
});
return { whenLoaded, clearLocal, whenDisposed };
```

```ts
// apps/*/daemon.ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync.whenDisposed;           // composes via barrier promise
}
```

```ts
// packages/cli/src/load-config.ts:147 (hasDaemonRuntimeShape)
isThenable(sync.whenDisposed) &&     // never read by CLI
```

### Smells

1. **Ordering knowledge in callers.** Every `client.ts` repeats `dispose(); await clearLocalData();` plus an explanatory comment.
2. **`whenDisposed` everywhere.** Public per-attachment property used only for ordering; daemons compose it, tests use it, CLI duck-types it for shape but never reads the value.
3. **`let destroyPromise: Promise<void> | null = null` would appear** the moment we tried to dedup the bundle dispose against the cascade: the explicit `let-then-check` smell.
4. **y-indexeddb double-binding.** Both upstream and our wrapper register `doc.on('destroy')`. `Y.Doc.destroy()` fires both, producing two independent `db.close()` Promises.
5. **CLI vestigial duck-type.** `isThenable(sync.whenDisposed)` validates a property nothing in `up.ts` invokes.

### Desired state

```ts
// apps/fuji/src/lib/fuji/client.ts
async resetLocalClient() {
  try {
    await fuji.wipe();                // one line; bundle owns order
  } catch (error) {
    toast.error('Could not wipe local data', { description: extractErrorMessage(error) });
  } finally {
    window.location.reload();
  }
},
```

```ts
// packages/workspace/src/document/attach-indexed-db.ts
export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  ydoc.off('destroy', idb.destroy);   // single dispose path; remove upstream auto-binding

  const dispose = lazy(() => idb.destroy().then(() => {}));
  ydoc.once('destroy', () => { void dispose(); });   // safety net for external destroy

  return {
    whenLoaded: idb.whenSynced.then(() => {}),
    clearLocal: () => idb.clearData(),
    [Symbol.asyncDispose]: dispose,
  };
}
```

```ts
// apps/*/daemon.ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync[Symbol.asyncDispose]();   // dedups against cascade-triggered dispose
}
```

```ts
// packages/cli/src/load-config.ts (hasDaemonRuntimeShape)
// drop: isThenable(sync.whenDisposed): CLI never reads it
// shrink umbrella to fields up.ts actually invokes
```

## Architecture

```
attach* primitive teardown shape:
  attachIndexedDb         [Symbol.asyncDispose]   (lazy(); ydoc.off upstream binding)
  attachSync              [Symbol.asyncDispose]   (lazy())
  attachYjsLog            [Symbol.asyncDispose]   (lazy())
  attachBroadcastChannel  cascade only            (sync; channel.close() in destroy handler)
  attachEncryption        cascade only            (sync; store.dispose() in destroy handler)
  attachAwareness         cascade only            (sync; y-protocols handles it upstream)
  attachRichText          nothing                 (no teardown)
  attachTable / Tables    cascade only            (sync; ykv.dispose() in destroy handler)
  attachKv                cascade only            (sync; ykv.dispose() in destroy handler)

bundles:
  browser bundle  [Symbol.dispose] (sync drop) + wipe() (async dispose + delete)
  daemon bundle   [Symbol.asyncDispose] (composes attach Symbol.asyncDispose via dedup)

removed everywhere:
  whenDisposed                          per-attachment property
  let destroyPromise = null             every builder
  isThenable(sync.whenDisposed)         CLI duck-type validation
  ordering comment block                every client.ts resetLocalClient

added:
  ydoc.off('destroy', idb.destroy)      single dispose path in attachIndexedDb
  lazy() use in async attach* primitives
```

### The `lazy()` pattern for dispose dedup

`packages/workspace/src/document/y-keyvalue/lazy.ts` (existing):

```ts
export function lazy<T>(init: () => T): () => T {
  let value: T | undefined;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = init();
      initialized = true;
    }
    return value as T;
  };
}
```

For dispose: `T = Promise<void>`. First call kicks off `idb.destroy().then(...)` and caches the Promise. Every subsequent call (whether from the cascade-triggered handler or from `await idb[Symbol.asyncDispose]()`) returns the same Promise. The mutable state is encapsulated inside `lazy()`; no builder writes `let destroyPromise = null`.

### Move `lazy()` to a broader location

Currently nested in `packages/workspace/src/document/y-keyvalue/lazy.ts`. Used by `y-keyvalue-lww.ts`, the markdown materializer, and (after this spec) every async `attach*` primitive. Move to `packages/workspace/src/shared/lazy.ts` (or `packages/workspace/src/utils/lazy.ts`) so the import isn't lying about ownership.

### Bundle teardown sequence (browser)

```ts
async wipe() {
  // 1. Drop child caches synchronously (each entry's [Symbol.dispose]
  //    calls ydoc.destroy(), which fires the cascade for that child).
  noteBodyDocs[Symbol.dispose]();

  // 2. Destroy the parent ydoc synchronously. Cascade fires:
  //    - sync attachments tear down sync (broadcast.close, encryption.store.dispose, etc.)
  //    - async attachments kick off their lazy() dispose Promise
  doc[Symbol.dispose]();

  // 3. Await the in-flight async dispose Promises. Each await dedups
  //    against the cascade-triggered call via lazy().
  await Promise.all([
    idb[Symbol.asyncDispose](),
    sync[Symbol.asyncDispose](),
  ]);

  // 4. Delete persisted state. IDB's deleteDatabase native blocking
  //    is now redundant (we've explicitly awaited the close above)
  //    but still serves as defense-in-depth.
  await Promise.all([
    ...doc.tables.notes.getAllValid().map((note) =>
      clearDocument(noteBodyDocGuid({ workspaceId: doc.ydoc.guid, noteId: note.id })),
    ),
    idb.clearLocal(),
  ]);
}
```

Compared to today's implemented sequence (which relied on `deleteDatabase`'s native blocking to serialize against the IDB close), this is more explicit. The native blocking remains as belt-and-suspenders.

### Daemon shape (unchanged shape, replaced barrier)

```ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync[Symbol.asyncDispose]();   // was: await sync.whenDisposed
}
```

`await using runtime = await startDaemon(...)` continues to work. The CLI's `runtime[Symbol.asyncDispose]()` at `load-config.ts:217` is unaffected at the call site.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Replace `whenDisposed` with `[Symbol.asyncDispose]` | Yes, only for primitives that do genuine async work | Type-driven, named for the operation. Sync primitives don't gain a method (cascade alone). |
| Idempotency mechanism | `lazy()` from existing `lazy.ts` | One tested helper encapsulates `let-then-check`. No mutable state in any builder. |
| `lazy()` location | Move from `y-keyvalue/` to `shared/` | Used by 4+ unrelated callers; the y-keyvalue path lies about ownership. |
| Fix y-indexeddb double-binding | `ydoc.off('destroy', idb.destroy)` after construction | Single dispose path; the wrapper owns it. Eliminates the two-Promise race. |
| Bundle method that does dispose+clear | Rename `clearLocalData` to `wipe` | Honest about both actions; short. Current name understates the dispose half. |
| Caller composes ordering | No, bundle owns it | Eliminates the comment block in every client.ts. The bundle knows its own children; the caller doesn't need to. |
| HMR teardown | Sync `Symbol.dispose` on bundle, fire-and-forget | HMR doesn't await; bundle drops references and lets the page's next reload handle anything left. |
| Daemon Symbol.asyncDispose | Keep, internally compose `Symbol.asyncDispose` per child | Same shape, replaced barrier source. |
| CLI `hasDaemonRuntimeShape` | Drop `isThenable(sync.whenDisposed)`; shrink umbrella to fields `up.ts` actually invokes | Honest invariant: "satisfies the calls the CLI makes," not "matches a contract type that drifted." |
| Browser bundle has `Symbol.asyncDispose`? | No | Would be a hybrid (sync + async dispose on the same surface; consumer could pick the wrong one and silently lose flush). `wipe()` is the explicit async path. |
| `lazy()` initializer form | Always `lazy(async () => { ... })` for disposers | Async wrapper converts sync throws into rejected Promises that lazy memoizes. The non-async form (`lazy(() => p.then(...))`) leaves `initialized = false` on sync throw and re-runs the body on every retry. |
| `clearLocal` implementation | `() => clearDocument(ydoc.guid)` directly, NOT `() => idb.clearData()` | `idb.clearData()` internally calls `idb.destroy()` again, bypassing lazy(). Direct `deleteDB` keeps `[Symbol.asyncDispose]` as the sole gateway to dispose work. Caller must dispose before clearLocal (the bundle's wipe() does this). |
| `whenDisposed` migration | Transitional alias during Phase A; deleted in same commit as final consumer migration (Phase C.4 / D.5) | Without the alias, the daemon entry points, tests, examples, and CLI duck-type all break in commits between Phase A and Phase D. With the alias (single `lazy()` reference exposed under both names), every commit type-checks. |
| Backwards compatibility | None at the END state | Mid-migration uses a single transitional alias for `whenDisposed`, dropped before this spec lands. The deliverable is a clean break. |

## API design

### `lazy()` location

Move `packages/workspace/src/document/y-keyvalue/lazy.ts` → `packages/workspace/src/shared/lazy.ts`. Update imports in `y-keyvalue-lww.ts`, `materializer/markdown/materializer.ts`, benchmarks. Add new imports from async `attach*` primitives.

### `attachIndexedDb`

Before:

```ts
export type IndexedDbAttachment = {
  whenLoaded: Promise<unknown>;
  clearLocal: () => Promise<void>;
  whenDisposed: Promise<unknown>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  const { promise: whenDisposed, resolve: resolveDisposed } = Promise.withResolvers<void>();
  ydoc.once('destroy', async () => {
    try { await idb.destroy(); } finally { resolveDisposed(); }
  });
  return { whenLoaded: idb.whenSynced, clearLocal: () => idb.clearData(), whenDisposed };
}
```

After (END state: Phase A.2 keeps `whenDisposed` transitionally; see Implementation plan):

```ts
import { clearDocument } from 'y-indexeddb';
import { lazy } from '../shared/lazy';

export type IndexedDbAttachment = {
  whenLoaded: Promise<unknown>;
  clearLocal: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  // Single dispose path: prevent IndexeddbPersistence's auto-bound destroy
  // from running alongside ours (which would produce two independent
  // db.close() promises that resolve at different times). The constructor
  // rebinds `this.destroy = this.destroy.bind(this)` and then calls
  // `doc.on('destroy', this.destroy)`, so the `idb.destroy` reference here
  // matches the registered listener.
  ydoc.off('destroy', idb.destroy);

  // async-wrapped: any synchronous throw inside the body becomes a rejected
  // Promise, which lazy() then memoizes correctly. Without the `async`
  // wrapper, a sync throw would leave `initialized = false` and re-run the
  // body on every subsequent call.
  const dispose = lazy(async () => {
    await idb.destroy();
  });
  ydoc.once('destroy', () => { void dispose(); });   // safety net for external destroy

  return {
    whenLoaded: idb.whenSynced.then(() => {}),
    // Direct deleteDB rather than idb.clearData(): clearData would call
    // idb.destroy() a second time (bypassing lazy()) and produce a fresh
    // db.close() Promise. Callers MUST `await [Symbol.asyncDispose]()`
    // before invoking clearLocal so the connection is already closed; the
    // bundle's wipe() does this.
    clearLocal: () => clearDocument(ydoc.guid),
    [Symbol.asyncDispose]: dispose,
  };
}
```

### `attachSync`

Same shape: expose `[Symbol.asyncDispose]` backed by `lazy()`. The existing destroy handler that does the synchronous prefix (`unsubscribeAuthChange()`, `ydoc.off(...)`, `clearPendingRequests()`, `manageWindowListeners('remove')`, `status.clear()`) and then `await loopPromise; await waitForWsClose(...)` becomes the body of the lazy initializer. **Replace** the existing `ydoc.once('destroy', ...)` handler: do NOT add a second one.

```ts
const dispose = lazy(async () => {
  masterController.abort();
  unsubscribeAuthChange();
  // ... existing synchronous teardown ...
  await loopPromise;
  await waitForWsClose(ws, 1000, log);
});
ydoc.once('destroy', () => { void dispose(); });
return { ..., [Symbol.asyncDispose]: dispose };
```

The `async` wrapper converts any sync throw inside the body into a rejected Promise that lazy() memoizes correctly.

### `attachYjsLog`

Same migration. Wrap the destroy body in `lazy(async () => { ... })`. Expose `[Symbol.asyncDispose]`. Replace (don't stack) the existing destroy handler.

### Browser bundle (e.g. `apps/honeycrisp/src/lib/honeycrisp/browser.ts`)

Before:

```ts
return {
  ...doc, idb, noteBodyDocs, awareness, sync, remote, rpc,
  async clearLocalData() {
    await Promise.all([
      ...doc.tables.notes.getAllValid().map((note) =>
        clearDocument(noteBodyDocGuid({ workspaceId: doc.ydoc.guid, noteId: note.id })),
      ),
      idb.clearLocal(),
    ]);
  },
  whenLoaded: idb.whenLoaded,
  [Symbol.dispose]() {
    noteBodyDocs[Symbol.dispose]();
    doc[Symbol.dispose]();
  },
};
```

After:

```ts
return {
  ...doc, idb, noteBodyDocs, awareness, sync, remote, rpc,
  whenLoaded: idb.whenLoaded,

  [Symbol.dispose]() {
    noteBodyDocs[Symbol.dispose]();
    doc[Symbol.dispose]();
  },

  async wipe() {
    noteBodyDocs[Symbol.dispose]();
    doc[Symbol.dispose]();
    await Promise.all([
      idb[Symbol.asyncDispose](),
      sync[Symbol.asyncDispose](),
    ]);
    await Promise.all([
      ...doc.tables.notes.getAllValid().map((note) =>
        clearDocument(noteBodyDocGuid({ workspaceId: doc.ydoc.guid, noteId: note.id })),
      ),
      idb.clearLocal(),
    ]);
  },
};
```

`BrowserWorkspace` in `packages/workspace/src/shared/workspace.ts`:

```ts
export type BrowserWorkspace = Workspace & {
  wipe(): Promise<void>;
};
```

### Browser `client.ts` (e.g. `apps/fuji/src/lib/fuji/client.ts`)

Before (with the comment block):

```ts
async resetLocalClient() {
  try {
    // The workspace bundle owns teardown order. Its disposer closes child
    // document caches and destroys the root Y.Doc, which tells attachments
    // like sync, broadcast channel, and y-indexeddb to stop before local
    // IndexedDB data is deleted.
    fuji[Symbol.dispose]();
    // This is safe after disposal. y-indexeddb deletes by database name,
    // and any row data needed to compute child document names remains
    // readable from memory after Y.Doc.destroy(); disposal has already
    // stopped observers and providers.
    await fuji.clearLocalData();
  } catch (error) {
    toast.error('Could not clear local data', { description: extractErrorMessage(error) });
  } finally {
    window.location.reload();
  }
},
```

After:

```ts
async resetLocalClient() {
  try {
    await fuji.wipe();
  } catch (error) {
    toast.error('Could not wipe local data', { description: extractErrorMessage(error) });
  } finally {
    window.location.reload();
  }
},
```

### Daemon (e.g. `apps/fuji/src/lib/fuji/daemon.ts`)

Before:

```ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync.whenDisposed;
},
```

After:

```ts
async [Symbol.asyncDispose]() {
  doc[Symbol.dispose]();
  await sync[Symbol.asyncDispose]();
},
```

### CLI `hasDaemonRuntimeShape`

Sub-agent audit of `packages/cli/src/commands/up.ts` (and helpers) found that the CLI never reads `actions`, `remote`, `sync.whenDisposed`, or `sync.status`. The umbrella has been validating fields the CLI never invokes. The honest invariant is "shape the parts I'm about to call directly."

Before:

```ts
function hasDaemonRuntimeShape(value: unknown): value is DaemonRuntime {
  if (!isObjectRecord(value)) return false;
  const { actions, awareness, sync, remote } = value;
  if (!isObjectRecord(awareness) || !isObjectRecord(sync) || !isObjectRecord(remote)) return false;
  return (
    isObjectRecord(actions) &&
    isThenable(sync.whenDisposed) &&
    hasSyncStatusShape(sync.status) &&
    typeof sync.onStatusChange === 'function' &&
    typeof awareness.peers === 'function' &&
    typeof awareness.observe === 'function' &&
    typeof remote.invoke === 'function' &&
    typeof value[Symbol.asyncDispose] === 'function'
  );
}
```

After:

```ts
function hasDaemonRuntimeShape(value: unknown): value is DaemonRuntime {
  if (!isObjectRecord(value)) return false;
  const { awareness, sync } = value;
  if (!isObjectRecord(awareness) || !isObjectRecord(sync)) return false;
  return (
    typeof awareness.peers === 'function' &&
    typeof awareness.observe === 'function' &&
    typeof sync.onStatusChange === 'function' &&
    typeof value[Symbol.asyncDispose] === 'function'
  );
}
```

Drops:
- `actions` check: unused by `up.ts`; only `load-config.test.ts:87` reads it
- `sync.whenDisposed` check: never read by CLI
- `sync.status` check: CLI reads the callback argument's `.phase`/`.retries` from `onStatusChange`, never reads `sync.status` directly
- `remote.invoke` check: the IPC server in `@epicenter/workspace/node` reads it; that's the workspace's contract, not the CLI's

Cascading deletions:
- `isThenable` import: unused, delete.
- `hasSyncStatusShape`, `hasSyncErrorShape`, `hasSyncFailedReasonShape` helpers (`load-config.ts:157-189`): only callers were each other and the umbrella; orphaned. Delete entirely.
- `InvalidRouteRuntime` error message at `load-config.ts:112-117`: currently lists "actions, sync teardown/status, awareness peers/observe, remote.invoke, and `[Symbol.asyncDispose]`." Trim to "awareness peers/observe, sync.onStatusChange, and `[Symbol.asyncDispose]`."

Optional follow-up (out of scope for this spec): if `@epicenter/workspace`'s `startDaemonServer` doesn't validate `remote.invoke` itself, push that check there. The CLI's responsibility is the parts it directly invokes.

## Rejected alternatives

### Drop the cascade entirely; require explicit dispose

Each attach primitive could skip `ydoc.once('destroy', ...)` registration and require the bundle to call `attachment[Symbol.asyncDispose]()` explicitly. The cascade safety net would disappear.

Rejected because external `ydoc.destroy()` callers (tests, internal Yjs code, future integrations) leak attachments. The cascade is cheap (one listener per attachment, Y.Doc.destroy fires it once), and `lazy()` makes the cascade-vs-explicit overlap free.

### Add `Symbol.asyncDispose` on the bundle (parallel to `Symbol.dispose`)

The bundle would expose both, with `Symbol.dispose` doing sync drop and `Symbol.asyncDispose` doing dispose+clear.

Rejected because `using foo = openHoneycrisp(...)` would silently call only `Symbol.dispose` and skip the storage clear, with no diagnostic. Hybrid API where the same operation has two contracts producing different outcomes is exactly what `cohesive-clean-breaks` rejects. `wipe()` is the named async path; `Symbol.dispose` is the named sync path; different verbs for different operations.

### Keep `clearLocalData` as the name

Name is honest about HALF of the operation. After this spec the method also tears down providers; `clearLocalData` understates that. `wipe` captures both halves and is shorter.

Considered alternatives:
- `clearLocal()`: same understatement, fewer chars
- `purge()`: synonym; more dramatic, less specific
- `destroy()`: conflicts with `ydoc.destroy()` mentally
- `forgetMe()`: soft; auth-flavored
- `decommission()`: formal; verbose

`wipe` wins on brevity + honesty + finality.

### Defer the lazy() move to a separate refactor

Could move `lazy.ts` out of `y-keyvalue/` in a follow-up.

Rejected because every async `attach*` primitive in this spec adds an import. Moving on the same pass costs nothing extra and avoids two churns at the same import sites.

## Implementation plan

Phase ordering: A is foundational (lazy + per-attachment shape). B is bundle surface. C is consumer migration. D is CLI cleanup. E is doc sweep.

Each phase is one or more commits. Within a phase, commits are ordered so each compiles.

### Phase A: lazy() and per-attachment Symbol.asyncDispose (with transitional `whenDisposed` alias)

Phase A introduces `[Symbol.asyncDispose]` on each async attachment, backed by a single `lazy()` reference. To keep every commit type-checking, the existing `whenDisposed` property stays exposed as an alias that points at the SAME lazy reference. Consumers (daemons, tests, CLI duck-type) migrate in Phase C/D. The alias is dropped in the SAME commit that lands the last consumer migration (see Phase F).

- [x] **A.1** Move `packages/workspace/src/document/y-keyvalue/lazy.ts` → `packages/workspace/src/shared/lazy.ts`. Update existing imports:
  - `y-keyvalue/y-keyvalue-lww.ts`
  - `materializer/markdown/materializer.ts`
  - `__benchmarks__/storage-overhead.bench.ts`

- [x] **A.2** Migrate `attach-indexed-db.ts`:
  - Add `import { clearDocument } from 'y-indexeddb'` and `import { lazy } from '../shared/lazy'`.
  - Add `ydoc.off('destroy', idb.destroy)` after construction.
  - Replace the existing `Promise.withResolvers` + `ydoc.once('destroy', async () => { ... })` block with the transitional form below.
  - Change `clearLocal: () => idb.clearData()` to `clearLocal: () => clearDocument(ydoc.guid)`.

  Transitional return shape (Phase A; collapses to the END state in Phase F):

  ```ts
  const { promise: whenDisposed, resolve: resolveDisposed } = Promise.withResolvers<void>();
  const dispose = lazy(async () => {
    try { await idb.destroy(); } finally { resolveDisposed(); }
  });
  ydoc.once('destroy', () => { void dispose(); });

  return {
    whenLoaded: idb.whenSynced.then(() => {}),
    clearLocal: () => clearDocument(ydoc.guid),
    whenDisposed,                       // deprecated alias; dropped in Phase F.1
    [Symbol.asyncDispose]: dispose,
  };
  ```

  Both `whenDisposed` and `[Symbol.asyncDispose]: dispose` resolve at the same point. Update `IndexedDbAttachment` to include both `whenDisposed` (marked `@deprecated`) and `[Symbol.asyncDispose]` for the migration window.

- [x] **A.3** Migrate `attach-sync.ts`: same transitional pattern. Wrap the existing destroy handler body in `lazy(async () => { ... })`. Add `[Symbol.asyncDispose]`. Keep `whenDisposed` resolving via the same lazy reference. **REPLACE** the existing `ydoc.once('destroy', ...)` handler: do NOT stack a second one (would double-fire the synchronous prefix).

- [x] **A.4** Migrate `attach-yjs-log.ts`: same transitional pattern. Same replace-don't-stack rule.

After Phase A, every async attachment exposes BOTH `whenDisposed` (deprecated alias) and `[Symbol.asyncDispose]` (new). Consumers can migrate independently. Workspace package type-checks; daemons type-check; tests type-check; CLI duck-type still passes.

### Phase B: bundle surface

- [x] **B.1** Add `wipe()` to every browser bundle. Keep `clearLocalData()` temporarily so callers compile during migration.
  - `apps/fuji/src/lib/fuji/browser.ts`
  - `apps/honeycrisp/src/lib/honeycrisp/browser.ts`
  - `apps/opensidian/src/lib/opensidian/browser.ts`
  - `apps/zhongwen/src/lib/zhongwen/browser.ts`
  - `apps/tab-manager/src/lib/tab-manager/extension.ts`

- [x] **B.2** Update `BrowserWorkspace` type in `packages/workspace/src/shared/workspace.ts` to include `wipe(): Promise<void>` (alongside `clearLocalData` for the migration).

### Phase C: consumer migration

- [x] **C.1** Migrate every browser app's `client.ts` `resetLocalClient` to call `await <bundle>.wipe()`. Delete the comment block.
  - `apps/fuji/src/lib/fuji/client.ts`
  - `apps/honeycrisp/src/lib/honeycrisp/client.ts`
  - `apps/opensidian/src/lib/opensidian/client.ts`
  - `apps/zhongwen/src/lib/zhongwen/client.ts`
  - `apps/tab-manager/src/lib/tab-manager/client.ts`

- [x] **C.2** Migrate every daemon's `Symbol.asyncDispose`: replace `await sync.whenDisposed` with `await sync[Symbol.asyncDispose]()`.
  - `apps/fuji/src/lib/fuji/daemon.ts`
  - `apps/honeycrisp/src/lib/honeycrisp/daemon.ts`
  - `apps/opensidian/src/lib/opensidian/daemon.ts`
  - `apps/zhongwen/src/lib/zhongwen/daemon.ts`
  - `apps/fuji/src/lib/fuji/script.ts` (uses `snapshotAttachment.yjsLog.whenDisposed`)
  - `examples/notes-cross-peer/notes.ts`
  - `playground/opensidian-e2e/epicenter.config.ts`
  - `playground/tab-manager-e2e/epicenter.config.ts`

- [x] **C.3** Migrate tests:
  - `packages/workspace/src/document/attach-sync.test.ts` (~6 sites)
  - `packages/workspace/src/document/attach-yjs-log.test.ts` (~5 sites)
  - `packages/workspace/src/document/attach-yjs-log-reader.test.ts` (~6 sites)
  - `packages/workspace/src/document/attach-encryption.test.ts` (~1 site)

  Replace `await att.whenDisposed` with `await att[Symbol.asyncDispose]()`.

- [x] **C.4** Drop `clearLocalData()` from every bundle and the `BrowserWorkspace` type. (Now safe; all consumers migrated.)

(Phase F drops the `whenDisposed` alias from each attachment. See below.)

### Phase D: CLI cleanup

The audit (sub-agent, recorded above under "CLI `hasDaemonRuntimeShape`") established exactly what `up.ts` reads. Phase D applies those findings; no per-task verification needed.

- [x] **D.1** Slim `hasDaemonRuntimeShape` in `packages/cli/src/load-config.ts:135-155` to validate ONLY the fields `up.ts` invokes:

  ```ts
  function hasDaemonRuntimeShape(value: unknown): value is DaemonRuntime {
    if (!isObjectRecord(value)) return false;
    const { awareness, sync } = value;
    if (!isObjectRecord(awareness) || !isObjectRecord(sync)) return false;
    return (
      typeof awareness.peers === 'function' &&
      typeof awareness.observe === 'function' &&
      typeof sync.onStatusChange === 'function' &&
      typeof value[Symbol.asyncDispose] === 'function'
    );
  }
  ```

  Drops: `actions`, `sync.whenDisposed`, `sync.status` (and the `hasSyncStatusShape` call), `remote.invoke`.

- [x] **D.2** Delete orphaned helpers from `packages/cli/src/load-config.ts:157-189`:
  - `hasSyncStatusShape`
  - `hasSyncErrorShape`
  - `hasSyncFailedReasonShape`

  Confirmed orphaned by audit (only callers were each other and the umbrella).

- [x] **D.3** Drop the `isThenable` import from `packages/cli/src/load-config.ts`. Verify with grep that no other reference to `isThenable` remains in `packages/cli/src/`.

- [x] **D.4** Update `InvalidRouteRuntime` error message at `packages/cli/src/load-config.ts:112-117`:

  Before:
  ```ts
  message:
    `Invalid daemon route "${route}" in ${configPath}: ` +
    `expected a daemon runtime with actions, sync teardown/status, ` +
    `awareness peers/observe, remote.invoke, and [Symbol.asyncDispose].`,
  ```

  After:
  ```ts
  message:
    `Invalid daemon route "${route}" in ${configPath}: ` +
    `expected a daemon runtime with awareness peers/observe, ` +
    `sync.onStatusChange, and [Symbol.asyncDispose].`,
  ```

- [x] **D.5** Verify `DaemonRuntime` at `packages/workspace/src/daemon/types.ts:29-45` does not directly declare `whenDisposed` (it doesn't today; `whenDisposed` lives on `SyncAttachment` and is reached via `runtime.sync.whenDisposed`). Confirm no separate type-level cleanup is needed here. Phase F removes `whenDisposed` from `SyncAttachment`, which propagates to `runtime.sync` automatically.

  Audit verified `DaemonRuntime` fields (`actions`, `awareness`, `sync`, `remote`, `[Symbol.asyncDispose]`) are all load-bearing in `packages/workspace/src/daemon/app.ts` and `run-handler.ts`. Do NOT drop fields from `DaemonRuntime` itself; the CLI duck-type shrink in D.1 is correct precisely BECAUSE the CLI doesn't invoke them, but the workspace's IPC server does.

### Phase F: drop the `whenDisposed` alias

After Phase D lands, no source file (apps, packages, examples, playground, tests, CLI) reads `whenDisposed` on `IndexedDbAttachment`, `SyncAttachment`, or `YjsLogAttachment`. The alias is now safe to delete.

- [x] **F.1** Remove `whenDisposed` from `IndexedDbAttachment` type and return value in `packages/workspace/src/document/attach-indexed-db.ts`. Drop the `Promise.withResolvers`/`resolveDisposed` plumbing: the lazy disposer is now the only path. Body simplifies to:

  ```ts
  const dispose = lazy(async () => {
    await idb.destroy();
  });
  ydoc.once('destroy', () => { void dispose(); });
  ```

  Update JSDoc on the file: any reference to `whenDisposed` (the deprecated comment, the type doc) becomes a reference to `[Symbol.asyncDispose]`.

- [x] **F.2** Same drop in `packages/workspace/src/document/attach-sync.ts`. Also update internal JSDoc references (around line 119-124 and 854 mention `whenDisposed`; rephrase to `[Symbol.asyncDispose]`). The `SyncSupervisorError.CloseTimeout` comment ("resolves whenDisposed anyway rather than hanging forever") becomes "resolves `[Symbol.asyncDispose]` anyway."

- [x] **F.3** Same drop in `packages/workspace/src/document/attach-yjs-log.ts`. Same JSDoc rephrasing.

- [x] **F.4** Verify with grep: `rg -n "whenDisposed" apps packages docs examples playground -S` should match only historical specs and articles.

### Phase G: additional dead-surface trims (audit findings)

Independent of the `whenDisposed`/`wipe` work but folded in to keep the migration cohesive. Each is a small, isolated cleanup.

- [x] **G.1** Trim `AwarenessAttachment` (`packages/workspace/src/document/attach-awareness.ts:54-77`). Drop these methods (zero production readers; only `attach-awareness.test.ts` uses them):
  - `setLocalField`
  - `getLocalField`
  - `getLocal`
  - `getAll`

  Migration cost: ~9 test sites in `packages/workspace/src/document/attach-awareness.test.ts`. The tests are testing capabilities no production caller exercises; either delete those tests or rewrite them to exercise `setLocal`/`peers`/`observe` (the surviving methods).

- [x] **G.2** Collapse `BroadcastChannelAttachment` return type to `void`. Every call site (`apps/*/browser.ts`) does `attachBroadcastChannel(ydoc)` and discards the return value. The type is dead surface.
  - `packages/workspace/src/document/attach-broadcast-channel.ts`: change function signature to return `void`. Drop the named `BroadcastChannelAttachment` type.
  - `packages/workspace/src/index.ts:191`: drop the `BroadcastChannelAttachment` export.

- [x] **G.3** Drop `whenDisposed` from `EncryptionAttachment` (`packages/workspace/src/document/attach-encryption.ts:184`). The attachment's teardown is fully synchronous (`for (const store of stores) store.dispose()` in the destroy handler at line 209-212). There is no async work to await. Only `attach-encryption.test.ts:111` reads it.
  - Drop the `whenDisposed` field from the type.
  - Drop the `Promise.withResolvers` setup and the `resolveDisposed()` call.
  - Drop the test line at `attach-encryption.test.ts:111`.

- [x] **G.4** Remove `register` from the public `EncryptionAttachment` type at `packages/workspace/src/document/attach-encryption.ts:139`. The JSDoc already says `@internal Called by the coordinator's own ... methods and by test setup, not by application code.` Move it off the type but keep the implementation in the closure (still called by `attachTable`/`attachTables`/`attachKv`).
  - Migration: 3 test sites at `attach-encryption.test.ts:37,38,100` need to construct via `encryption.attachTable(...)` instead of `encryption.register(...)` directly.

- [x] **G.5** Verify by grep that the dropped surfaces have no remaining production readers:

  ```sh
  rg -n "setLocalField|getLocalField|\.getLocal\(|\.getAll\(" apps packages -S | rg -v test
  rg -n "BroadcastChannelAttachment" apps packages -S
  rg -n "encryption\.whenDisposed|encryption\.register\(" apps packages -S | rg -v test
  ```

  Result: `BroadcastChannelAttachment` and `encryption.whenDisposed` / `encryption.register(` are empty. `setLocalField` / `getLocalField` are empty. The broad `.getLocal(` / `.getAll(` pattern still matches unrelated table, KV, browser, benchmark, and historical spec uses; no remaining matches are AwarenessAttachment production readers.

### Out of scope (filed as follow-up)

- **`runtime.remote` could move to a `startDaemonServer({ remoteByRoute })` argument.** Only `packages/workspace/src/daemon/run-handler.ts:132` reads `runtime.remote.invoke`. CLI never touches it. Pulling `remote` out of the `DaemonRuntime` shape lets route authors stop constructing `RemoteClient` (4 daemon files: fuji, honeycrisp, opensidian, zhongwen). Migration cost: 4 daemon files + `startDaemonServer` signature + `app.ts`/`run-handler.ts` plumbing. Worth a separate spec.
- **`YjsLogAttachment.clearLocal` is read only by tests.** Possible vestigial feature; warrants its own audit.

### Phase E: docs and stragglers

- [x] **E.1** Update `docs/articles/20260422T160000-sync-dispose-cascade.md`: the article rejected per-attachment async dispose for safety-net reasons. Add a follow-up section (or new article) documenting that `lazy()` makes the cascade-vs-explicit overlap free, so per-attachment `Symbol.asyncDispose` is now coherent with the cascade safety net.

- [x] **E.2** Update `docs/architecture.md` line 146-156 (the `whenDisposed` documented contract).

- [x] **E.3** Update `packages/workspace/README.md` if it mentions `whenDisposed`.

- [x] **E.4** Update `.agents/skills/attach-primitive/SKILL.md` and `.agents/skills/workspace-api/references/primitive-api.md` to document the new pattern (`Symbol.asyncDispose` for genuine async work, cascade only for sync).

- [x] **E.5** Run straggler greps:

  ```sh
  rg -n "whenDisposed" apps packages docs examples playground -S
  rg -n "isThenable" packages -S
  rg -n "let destroyPromise" packages -S
  rg -n "clearLocalData" apps packages docs -S
  ```

  Expected after implementation:
  - First: matches only historical specs and articles.
  - Second: empty (or one match if `isThenable` is used elsewhere).
  - Third: empty.
  - Fourth: matches only historical specs.

## Edge cases

### HMR

`import.meta.hot.dispose(() => { auth[Symbol.dispose](); honeycrisp[Symbol.dispose](); })` continues to work. Sync dispose is correct for HMR; flush guarantees aren't needed because the new module instance opens a fresh ydoc with the same guid (y-indexeddb serializes via IDB's queue).

### External `ydoc.destroy()` (tests, future integrations)

Cascade still fires (we still register `ydoc.once('destroy', () => { void dispose(); })`). The lazy disposer kicks off in the background. If someone explicitly awaits `attachment[Symbol.asyncDispose]()` later, they get the same Promise.

### `lazy()` and Promise rejection

If `idb.destroy()` rejects, the cached Promise is the rejected Promise. Subsequent `await attachment[Symbol.asyncDispose]()` calls re-throw the same error. That's correct behavior. The disposal failed, and every observer needs to know. A consumer that wants retry on failure should not call dispose again expecting fresh work; they should treat the attachment as toast.

### y-indexeddb `whenSynced` after dispose

`IndexeddbPersistence.whenSynced` is created in the constructor and resolves on the synced event. After dispose, `_destroyed = true` prevents `synced` from firing for new state, but the existing Promise resolution is unaffected. `whenLoaded: idb.whenSynced.then(() => {})` retains its value at the moment the doc was alive.

### Subdoc cache

`createDisposableCache`'s entries each have `[Symbol.dispose]() { ydoc.destroy(); }`. The cache itself has sync `[Symbol.dispose]()` that iterates entries. This stays sync: calling `cache[Symbol.dispose]()` at the start of `wipe()` fires every child's destroy synchronously, which kicks off each child's lazy dispose Promises. The bundle then awaits the parent's sync/idb disposes; child doc disposes settle in the background and `clearDocument` per child uses IDB's native blocking as belt-and-suspenders.

**Verify during execution**: `createDisposableCache[Symbol.dispose]()` must be idempotent. `wipe()` calls it; if the consumer subsequently (or previously) calls `bundle[Symbol.dispose]()`, the cache's dispose runs again. Read `packages/workspace/src/cache/disposable-cache.ts` (line ~299-303). If the iteration over entries is on an already-empty internal collection, second call is a safe no-op. If not, add an early-return guard.

### Silent rejection from a child's lazy disposer

`wipe()`'s `noteBodyDocs[Symbol.dispose]()` triggers each child's cascade, which calls `void dispose()`. The `void` discards the Promise. If a child's lazy disposer rejects (e.g., `idb.destroy()` of a child throws), the rejection sits in an unhandled-Promise state for that child. The cascade itself doesn't propagate to `wipe()`. `clearDocument(childGuid)` still runs and IDB's native `deleteDB` blocking handles whatever connection state survives. The behavior is "safe but silent."

JSDoc on each child cache's `[Symbol.dispose]` should note: "child disposer rejections do not propagate; bundle.wipe() relies on IDB's deleteDatabase native blocking as belt-and-suspenders for storage deletion."

### `clearLocalData` vs `wipe` during migration

Phase B keeps both; Phase C migrates callers; Phase C.4 drops `clearLocalData`. Tests, consumer code, and the type all update in lockstep within Phase C, so there's no commit window where a caller of `clearLocalData` is broken.

### CLI duck-type validation false positives

After Phase D, the CLI accepts any object whose shape matches the new umbrella. A misshapen daemon runtime that happens to have `Symbol.asyncDispose` but is otherwise broken gets caught at first invocation rather than at config-load. This is a slight ergonomics regression for one error path. The trade-off is removing a vestigial check that lied about what the CLI actually validates.

## Success criteria

- [x] `lazy()` lives at `packages/workspace/src/shared/lazy.ts`. No imports reference the old `y-keyvalue/lazy.ts` path.
- [x] No source file (apps, packages, examples, playground, tests) reads `attachment.whenDisposed`.
- [x] No source file declares `whenDisposed` on an attachment type.
- [x] No builder contains `let destroyPromise: Promise<void> | null = null` or equivalent.
- [x] `attachIndexedDb`, `attachSync`, `attachYjsLog` expose `[Symbol.asyncDispose]` instead of `whenDisposed`.
- [x] `ydoc.off('destroy', idb.destroy)` appears in `attachIndexedDb`.
- [x] Every browser bundle has `wipe()`. None has `clearLocalData()`.
- [x] Every browser `client.ts` `resetLocalClient` body is `try { await <bundle>.wipe() } catch ... finally { window.location.reload() }`. No comment block explaining ordering.
- [x] Every daemon's `Symbol.asyncDispose` reads `await sync[Symbol.asyncDispose]()`.
- [x] `hasDaemonRuntimeShape` in `packages/cli/src/load-config.ts` checks only `awareness.peers`, `awareness.observe`, `sync.onStatusChange`, `[Symbol.asyncDispose]`. Helpers `hasSyncStatusShape`, `hasSyncErrorShape`, `hasSyncFailedReasonShape` deleted. `isThenable` import dropped. `InvalidRouteRuntime.message` updated to match.
- [x] `DaemonRuntime` type at `packages/workspace/src/daemon/types.ts` UNCHANGED: fields stay because `daemon/app.ts` and `daemon/run-handler.ts` read them. Only the CLI's validator shrinks.
- [x] `AwarenessAttachment` no longer exposes `setLocalField`, `getLocalField`, `getLocal`, `getAll`.
- [x] `attachBroadcastChannel` returns `void`; `BroadcastChannelAttachment` type no longer exported.
- [x] `EncryptionAttachment` no longer exposes `whenDisposed` or `register` (register stays in the closure, off the public type).
- [x] `bun test packages/workspace` passes.
- [x] `bun test packages/auth-workspace` passes.
- [x] `bun run --filter @epicenter/workspace typecheck` passes.
- [x] `bun run --filter @epicenter/auth-workspace typecheck` passes.
- [ ] Per-app typechecks pass.
- [ ] Manual sign-out smoke on Fuji and Honeycrisp: open at least one entry/note (populating the cache), then sign out, verify clean reload, no `onblocked` warnings, no console errors.

## Files to inspect

```
packages/workspace/src/shared/lazy.ts                         add (move from y-keyvalue/lazy.ts)
packages/workspace/src/document/y-keyvalue/lazy.ts            delete (after move)
packages/workspace/src/document/attach-indexed-db.ts          edit (Phase A.2; Phase F.1)
packages/workspace/src/document/attach-sync.ts                edit (Phase A.3; Phase F.2)
packages/workspace/src/document/attach-yjs-log.ts             edit (Phase A.4; Phase F.3)
packages/workspace/src/document/attach-awareness.ts           edit (Phase G.1)
packages/workspace/src/document/attach-awareness.test.ts      edit (Phase G.1; ~9 sites)
packages/workspace/src/document/attach-broadcast-channel.ts   edit (Phase G.2; collapse to void)
packages/workspace/src/document/attach-encryption.ts          edit (Phase G.3, G.4)
packages/workspace/src/document/attach-encryption.test.ts     edit (Phase G.3 line 111; Phase G.4 lines 37,38,100)
packages/workspace/src/cache/disposable-cache.ts              verify (idempotent dispose)
packages/workspace/src/daemon/types.ts                        verify (Phase D.5; no edit expected)
packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts  edit (lazy import path)
packages/workspace/src/document/materializer/markdown/materializer.ts  edit (lazy import path)
packages/workspace/src/__benchmarks__/storage-overhead.bench.ts edit (lazy import path)
packages/workspace/src/shared/workspace.ts                    edit (BrowserWorkspace.wipe)
packages/workspace/src/daemon/types.ts                        edit (drop whenDisposed if present)
packages/cli/src/load-config.ts                               edit (Phase D.2)

apps/fuji/src/lib/fuji/browser.ts                             edit (Phase B.1)
apps/fuji/src/lib/fuji/client.ts                              edit (Phase C.1)
apps/fuji/src/lib/fuji/daemon.ts                              edit (Phase C.2)
apps/fuji/src/lib/fuji/script.ts                              edit (Phase C.2)
apps/honeycrisp/src/lib/honeycrisp/browser.ts                 edit (Phase B.1)
apps/honeycrisp/src/lib/honeycrisp/client.ts                  edit (Phase C.1)
apps/honeycrisp/src/lib/honeycrisp/daemon.ts                  edit (Phase C.2)
apps/opensidian/src/lib/opensidian/browser.ts                 edit (Phase B.1)
apps/opensidian/src/lib/opensidian/client.ts                  edit (Phase C.1)
apps/opensidian/src/lib/opensidian/daemon.ts                  edit (Phase C.2)
apps/zhongwen/src/lib/zhongwen/browser.ts                     edit (Phase B.1)
apps/zhongwen/src/lib/zhongwen/client.ts                      edit (Phase C.1)
apps/zhongwen/src/lib/zhongwen/daemon.ts                      edit (Phase C.2)
apps/tab-manager/src/lib/tab-manager/extension.ts             edit (Phase B.1)
apps/tab-manager/src/lib/tab-manager/client.ts                edit (Phase C.1)

packages/workspace/src/document/attach-sync.test.ts           edit (Phase C.3)
packages/workspace/src/document/attach-yjs-log.test.ts        edit (Phase C.3)
packages/workspace/src/document/attach-yjs-log-reader.test.ts edit (Phase C.3)
packages/workspace/src/document/attach-encryption.test.ts     edit (Phase C.3)
examples/notes-cross-peer/notes.ts                            edit (Phase C.2)
playground/opensidian-e2e/epicenter.config.ts                 edit (Phase C.2)
playground/tab-manager-e2e/epicenter.config.ts                edit (Phase C.2)

docs/articles/20260422T160000-sync-dispose-cascade.md         edit (Phase E.1)
docs/architecture.md                                          edit (Phase E.2; line 146-156)
packages/workspace/README.md                                  edit (Phase E.3 if needed)
.agents/skills/attach-primitive/SKILL.md                      edit (Phase E.4)
.agents/skills/workspace-api/references/primitive-api.md      edit (Phase E.4)
```

## Verification commands

```sh
# Foundational
bun run --filter @epicenter/workspace typecheck
bun test packages/workspace/src/shared/lazy.ts                     # if test exists
bun test packages/workspace/src/document/attach-indexed-db.test.ts # if test exists
bun test packages/workspace/src/document/attach-sync.test.ts
bun test packages/workspace/src/document/attach-yjs-log.test.ts

# Auth-workspace + bundle integration
bun test packages/auth-workspace
bun run --filter @epicenter/auth-workspace typecheck

# Per-app typechecks
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck

# Manual smoke (Fuji and Honeycrisp at minimum, since they have subdoc caches)
# 1. Sign in.
# 2. Open at least one entry/note (populates the subdoc cache).
# 3. Sign out from the account popover.
# 4. Verify:
#    - page reloads cleanly within ~1-2s
#    - DevTools Console: no errors, no `onblocked` warnings from IndexedDB
#    - DevTools Application > IndexedDB: previous user's databases are gone
#    - fresh state shows (signed-out UI)
```

## Review

**Completed**: 2026-05-04
**Branch**: `feat/lazy-disposers-bundle-owns-wipe`

### Summary

The implementation moved `lazy()` to the shared package surface, put async attachment teardown behind `[Symbol.asyncDispose]()` backed by the same lazy cleanup path as the Y.Doc cascade, and moved identity reset ordering into browser bundle `wipe()` methods. Browser callers now use `await bundle.wipe()`; daemon callers await `sync[Symbol.asyncDispose]()`; the transitional `whenDisposed` alias is gone from live source.

The cleanup also trimmed the CLI daemon-runtime validator to fields it invokes, removed the dead awareness helper methods, collapsed broadcast-channel attachment return type to `void`, and removed `whenDisposed` plus public `register` from encryption.

### Commits

- `3b40969e5` `refactor(workspace): add lazy async disposers`
- `cba899c70` `refactor(workspace): add bundle wipe surface`
- `a0d056f67` `refactor(workspace): migrate bundles to wipe`
- `731256796` `refactor(cli): slim daemon runtime validation`
- `ebe3c7d51` `refactor(workspace): remove whenDisposed aliases`
- `09ad8197a` `refactor(workspace): trim awareness attachment surface`
- `8d8f9eba3` `refactor(workspace): collapse broadcast channel attachment`
- `9e016073b` `refactor(workspace): drop encryption disposal barrier`
- `a9914b6f0` `refactor(workspace): hide encryption register`
- `4f32f3f5c` `docs(workspace): refresh disposal guidance for wipe`

### Verification

Passed:

```sh
bun test packages/workspace
bun test packages/workspace/src/document/attach-sync.test.ts
bun test packages/workspace/src/document/attach-yjs-log.test.ts
bun test packages/workspace/src/document/attach-yjs-log-reader.test.ts
bun test packages/workspace/src/document/attach-encryption.test.ts
bun test packages/auth-workspace
bun test packages/auth-workspace/src/index.test.ts
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/auth-workspace typecheck
```

The workspace suite result was 664 pass, 2 todo, 0 fail.

No matching test file exists for:

```sh
bun test packages/workspace/src/shared/lazy.ts
bun test packages/workspace/src/document/attach-indexed-db.test.ts
```

Straggler greps:

```sh
rg -n "whenDisposed" apps packages docs examples playground -S
rg -n "clearLocalData" apps packages docs -S
```

Both now match only historical specs and articles. Targeted source greps over `apps`, `packages/*/src`, `examples`, and `playground` are empty for `whenDisposed` and `clearLocalData`.

Empty:

```sh
rg -n "isThenable" packages -S
rg -n "let destroyPromise" packages -S
rg -n "hasSyncStatusShape|hasSyncErrorShape|hasSyncFailedReasonShape" packages -S
rg -n "idb\.clearData" packages -S
rg -n "BroadcastChannelAttachment" apps packages -S
rg -n "encryption\.whenDisposed|encryption\.register\(" apps packages -S | rg -v test
```

Awareness-surface grep:

```sh
rg -n "setLocalField|getLocalField|\.getLocal\(|\.getAll\(" apps packages -S | rg -v test
```

This pattern still reports unrelated `.getAll(` uses: table/KV APIs, browser window APIs, markdown materializers, benchmarks, README snippets, and historical specs. There are no remaining `setLocalField` / `getLocalField` matches and no AwarenessAttachment production readers.

Blocked:

```sh
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck
bun run --filter @epicenter/whispering typecheck
```

The app checks fail on existing shared Svelte/UI and app diagnostics outside this spec, including `packages/svelte-utils/src/from-table.svelte.ts`, `packages/ui/src/sonner/toast-on-error.ts`, `packages/ui` `#/utils.js` resolution, `Record` generic issues in UI components, and unrelated app-specific component errors.

Manual smoke was not run because no authenticated browser session or throwaway credentials were available in this execution context.
