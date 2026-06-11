# Restore whenDisposed Barriers on Async Attachments

**Date**: 2026-05-04
**Status**: Implemented
**Author**: AI-assisted (Claude)
**Branch**: feat/lazy-disposers-bundle-owns-wipe (or successor)
**Supersedes**: `specs/20260504T220000-lazy-disposers-bundle-owns-wipe.md` (the attach-level Symbol.asyncDispose direction)
**Restores (with refinements)**: the `whenDisposed` barrier shape from `specs/20260504T020000-workspace-identity-reset-deterministic-teardown.md`

## One-Sentence Test

Async attach* primitives expose `whenDisposed: Promise<unknown>` barriers; bundles compose them into `[Symbol.asyncDispose]` (daemons) or `wipe()` (browser bundles), where the bundle-level method is the actual trigger and the attach-level surface is honest about being a barrier, not a function call disguising one.

If the design exposes `[Symbol.asyncDispose]` on individual attachments, requires a `lazy()` memoization to dedup against cascade-fired disposal, or makes `await attachment[Symbol.asyncDispose]()` the call-site shape for "wait for cleanup," the design is not honest yet.

## One-Second Summary

`Symbol.asyncDispose` at the attachment level looked like a function call but was actually a memoized barrier disguised as a function call. Replace with `whenDisposed` (a Promise field) so attach-level barriers are honest. Keep `Symbol.asyncDispose` where it's the actual trigger: at the bundle level for daemons.

## Overview

This spec is a refinement of `specs/20260504T220000-lazy-disposers-bundle-owns-wipe.md`. After implementation and a second-read review, the attach-level `[Symbol.asyncDispose]` pattern was found to have a semantic mismatch.

At the bundle's `wipe()` call site:

```ts
async wipe() {
  doc[Symbol.dispose]();             // ← THIS triggers cleanup (ydoc.destroy → cascade)
  await Promise.all([
    idb[Symbol.asyncDispose](),      // ← looks like a trigger; actually returns memoized
    sync[Symbol.asyncDispose](),     //   promise that the line above already kicked off
  ]);
}
```

The verb-shaped call `idb[Symbol.asyncDispose]()` reads like a trigger. It isn't. The cleanup was triggered by `doc[Symbol.dispose]()` two lines up; the "call" just retrieves the in-flight Promise that `lazy()` memoized when the cascade fired.

The original (`whenDisposed`) shape from the implemented identity-reset spec was honest: a Promise field on the attachment that resolves when the cascade-triggered cleanup settles. Property access for "wait for state X." Function calls for "do X." The `Symbol.asyncDispose` direction merged those into one syntax that did neither cleanly.

This spec restores `whenDisposed` at the attach level. Bundle-level `Symbol.asyncDispose` stays where it earns its keep (daemons, where the call IS the trigger). The bundle's named methods (`Symbol.dispose` for HMR fire-and-forget, `wipe()` for full teardown) carry the explicit verbs.

## The round-trip

```
20260504T020000   whenDisposed pattern (implemented identity-reset spec)
                  └─ attachIndexedDb returned { whenLoaded, clearLocal, whenDisposed }
                  └─ caller composed dispose-then-clear order in client.ts

20260504T220000   Symbol.asyncDispose pattern (current branch)
                  └─ attachIndexedDb returned { whenLoaded, clearLocal, [Symbol.asyncDispose] }
                  └─ added lazy() to memoize so cascade and explicit calls dedup
                  └─ moved lazy() to shared/
                  └─ moved dispose-then-clear order INTO bundle.wipe()

20260504T230000   whenDisposed restored, bundle.wipe() kept (this spec)
                  └─ attachIndexedDb back to { whenLoaded, clearLocal, whenDisposed }
                  └─ no lazy needed at attach level (Promise.withResolvers + cascade)
                  └─ lazy() moves back to y-keyvalue/ (only remaining caller)
                  └─ bundle.wipe() and Symbol.dispose layout unchanged
                  └─ all the audit-driven cleanups from 220000 stay
```

## Lessons from the round-trip

The `Symbol.asyncDispose` direction wasn't unmotivated. It was chosen for:

1. Standard JS semantics (`await using` compatibility).
2. Symmetry across async attachments (every async one has the same surface).
3. Type-driven sync vs async distinction.

What we learned implementing it:

**1. `await using` doesn't actually fit at the attachment level.** Nobody writes `await using idb = attachIndexedDb(...)`. Attachments are always composed inside bundle factories. The `await using` ergonomics show up at the bundle/daemon scope, not at the attach scope. So the standard-shape benefit was a feature nobody used.

**2. The function-call syntax obscures the cascade dependency.** When `wipe()` reads `await idb[Symbol.asyncDispose]()`, a fresh reader sees what looks like a trigger. The actual trigger was `doc[Symbol.dispose]()` two lines up; `lazy()` retrieves the in-flight Promise. Verb syntax wraps barrier semantics. Cognitive tax on every reader.

**3. The `lazy()` memoization is machinery for hiding the cascade.** Not just any caching: it specifically exists so that `attachment[Symbol.asyncDispose]()` returns the same Promise as the one the cascade fired. That dedup is a workaround for the verb syntax pretending to be a trigger. With `whenDisposed` (property access), there's nothing to dedup; both readers of the property get the same Promise field that `Promise.withResolvers` resolved when the cascade-fired handler completed.

**4. Symmetry is honest only if it reflects symmetric behavior.** All async attachments running their cleanup the same way is honest symmetry. All async attachments exposing the same FUNCTION surface when the call has different semantic meaning at different layers is fake symmetry.

## Why whenDisposed is honest

```
trigger:  ydoc.destroy()                  (single source of truth)
barrier:  attachment.whenDisposed         (Promise field; clearly a barrier)

call site:
  doc[Symbol.dispose]();                  // trigger; verb syntax
  await Promise.all([                      // barrier; property access
    idb.whenDisposed,
    sync.whenDisposed,
  ]);
```

Function calls do things. Property access reads state. Mixing those is the smell. Separating them is honest.

Symmetric with the rest of the attach* surface:

```
whenLoaded     barrier: ready to read/write
whenConnected  barrier: remote transport up
whenDisposed   barrier: cleanup settled
```

All "wait for state X" promises. Same shape.

## The design rule (sync vs async at each layer)

```
at the attach* level:
  - sync teardown only (broadcastChannel, encryption, awareness, table/kv):
      no public surface; cascade owns it
  - async teardown (idb, sync, yjsLog):
      expose `whenDisposed: Promise<unknown>` so internal composers can await

at the bundle level:
  - browser bundles (have async attachments + storage to wipe):
      [Symbol.dispose]() for sync HMR / fire-and-forget cleanup
      wipe() for ordered dispose + clear (returns Promise)
      NO [Symbol.asyncDispose]: would be a hybrid (sync + async with same semantic)

  - daemon bundles (have async attachments, no storage to wipe):
      [Symbol.asyncDispose]() for `await using runtime = startDaemon()`
      NO [Symbol.dispose]: daemons always want clean shutdown

at the consumer level:
  - browser:
      HMR:    bundle[Symbol.dispose]()
      logout: await bundle.wipe(); window.location.reload()
  - daemon:
      await using runtime = startDaemon(...)   // scope-bound cleanup
```

This is the user's articulation: each `openX()` factory decides between `Symbol.dispose` and `Symbol.asyncDispose` based on whether any of its composed attachments has async work. If they're all sync, expose `Symbol.dispose`. If any is async, you need a barrier: at the bundle level, that becomes `Symbol.asyncDispose` for daemons or named methods (`wipe()`) for browser bundles where the dispose+clear distinction matters.

## Architecture

Each layer's surface, post-spec:

```
sync attach* primitives (broadcastChannel, encryption, awareness, table/kv):
  return value:  whatever the primitive needs (no dispose surface)
  cleanup:       ydoc.once('destroy', () => syncCleanup())
  honest:        cascade is the trigger AND the only path

async attach* primitives (indexedDb, sync, yjsLog):
  return value:  { whenLoaded, ..., whenDisposed }
  cleanup:       ydoc.once('destroy', async () => {
                   try { await asyncWork() } finally { resolveDisposed() }
                 })
  honest:        cascade is the trigger; whenDisposed is the barrier

browser bundle (e.g. honeycrisp/browser.ts):
  return value:  { ..., [Symbol.dispose], wipe() }
  Symbol.dispose: sync; cache disposal + ydoc.destroy()
  wipe():         async; sync prefix + await whenDisposed barriers + delete storage

daemon bundle (e.g. honeycrisp/daemon.ts):
  return value:  { ..., [Symbol.asyncDispose] }
  Symbol.asyncDispose: async; ydoc.destroy() then await sync.whenDisposed
                                (and yjsLog.whenDisposed if present)
```

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Async attachment dispose surface | `whenDisposed: Promise<unknown>` field | Honest about being a barrier; symmetric with `whenLoaded`/`whenConnected`; no `lazy()` machinery; no verb-syntax-wrapping-barrier confusion |
| `lazy()` for attach-level dedup | Removed | Was only needed to make `attachment[Symbol.asyncDispose]()` return the cascade-fired in-flight Promise. With `whenDisposed`, the cascade resolves the barrier directly via `Promise.withResolvers`; nothing to dedup. |
| `lazy()` location | Move back to `packages/workspace/src/document/y-keyvalue/lazy.ts` | Only remaining caller is `y-keyvalue-lww.ts`. Co-locating with the single caller is honest; `shared/` implied a cross-cutting use we no longer have. |
| `ydoc.off('destroy', idb.destroy)` | Keep | y-indexeddb's auto-binding still creates the double-handler problem; our `ydoc.once` handler is still the sole dispose path. The strip is a y-indexeddb workaround independent of the barrier shape. |
| Bundle `Symbol.dispose` + `wipe()` (browser) | Keep | Two named verbs for two operations: stop-only vs stop-and-wipe. Not a hybrid. |
| Bundle `Symbol.asyncDispose` (daemon-only) | Keep | The bundle's `Symbol.asyncDispose` IS the genuine trigger (no separate ydoc.destroy call). Browser bundles have `wipe()` instead. |
| CLI duck-type slim (`hasDaemonRuntimeShape`) | Keep | Independent of barrier shape. CLI never read `whenDisposed`; don't re-add the check. |
| Drop dead `Workspace` / `BrowserWorkspace` types | Keep | Independent of barrier shape. |
| `AwarenessAttachment` trim | Keep | Independent. |
| `BroadcastChannelAttachment` collapse to `void` | Keep | Independent. |
| `EncryptionAttachment.whenDisposed` drop | Keep (encryption is sync-only; barrier was useless) | Independent. |
| `EncryptionAttachment.register` private | Keep | Independent. |
| CLI rejection logging in `disposeStartedDaemonRoutes` | Keep | Independent. |
| Backwards compatibility | None (clean revert) | The branch hasn't shipped; no external consumers to migrate. |

## API design

### `attachIndexedDb`

Before (this branch):

```ts
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import { lazy } from '../shared/lazy.js';

export type IndexedDbAttachment = {
  whenLoaded: Promise<unknown>;
  clearLocal: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  ydoc.off('destroy', idb.destroy);
  const dispose = lazy(async () => {
    await idb.destroy();
  });
  ydoc.once('destroy', () => { void dispose(); });
  return {
    whenLoaded: idb.whenSynced,
    clearLocal: () => clearDocument(ydoc.guid),
    [Symbol.asyncDispose]: dispose,
  };
}
```

After:

```ts
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

export type IndexedDbAttachment = {
  whenLoaded: Promise<unknown>;
  clearLocal: () => Promise<void>;
  /**
   * Resolves after `ydoc.destroy()` fires the cascade and the IDB connection
   * has actually closed. Pair with `Promise.all` in bundle.wipe() or daemon
   * Symbol.asyncDispose to fence cleanup before deleting persisted data or
   * exiting the process.
   */
  whenDisposed: Promise<unknown>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  // Strip y-indexeddb's auto-binding: its constructor binds
  // doc.on('destroy', this.destroy) and its destroy() has no idempotency
  // guard, so two invocations produce two independent _db.then(db.close())
  // promises. Route disposal through our single handler so whenDisposed
  // resolves AFTER the actual close completes.
  ydoc.off('destroy', idb.destroy);

  const { promise: whenDisposed, resolve: resolveDisposed } =
    Promise.withResolvers<void>();
  ydoc.once('destroy', async () => {
    try { await idb.destroy(); } finally { resolveDisposed(); }
  });

  return {
    whenLoaded: idb.whenSynced,
    clearLocal: () => clearDocument(ydoc.guid),
    whenDisposed,
  };
}
```

Net: drops the `lazy` import; replaces verb-shaped `[Symbol.asyncDispose]` with property barrier `whenDisposed`. Same number of lines; honest semantics.

### `attachSync`

Same pattern. Unwrap the `lazy(async () => { ... })` into a plain `async () => { try { ... } finally { resolveDisposed() } }` registered on `ydoc.once('destroy', ...)`.

```ts
const { promise: whenDisposed, resolve: resolveDisposed } =
  Promise.withResolvers<void>();
ydoc.once('destroy', async () => {
  try {
    masterController.abort();
    unsubscribeAuthChange();
    // ... existing synchronous teardown ...
    await loopPromise;
    await waitForWsClose(ws, 1000, log);
  } finally {
    resolveDisposed();
  }
});

return {
  whenConnected,
  status: ...,
  onStatusChange: ...,
  reconnect,
  whenDisposed,           // ← was [Symbol.asyncDispose]
  attachRpc,
};
```

Update `SyncAttachment` type accordingly.

### `attachYjsLog`

Same pattern. Same `Promise.withResolvers` wrapping. The existing try/catch wrapper around `compactUpdateLog()` and `db.close()` continues to log per-step failures (per the audit's note about typed error follow-up; out of scope for this spec).

### Browser bundle (e.g. `apps/honeycrisp/src/lib/honeycrisp/browser.ts`)

```ts
return {
  ...doc, idb, sync, awareness, noteBodyDocs, remote, rpc,
  whenLoaded: idb.whenLoaded,

  [Symbol.dispose]() {
    noteBodyDocs[Symbol.dispose]();
    doc[Symbol.dispose]();
  },

  async wipe() {
    noteBodyDocs[Symbol.dispose]();
    doc[Symbol.dispose]();
    await Promise.all([
      idb.whenDisposed,             // ← honest barrier
      sync.whenDisposed,
    ]);
    await Promise.all([
      ...doc.tables.notes.getAllValid().map((note) =>
        clearDocument(noteBodyDocGuid({ ... })),
      ),
      idb.clearLocal(),
    ]);
  },
};
```

### Daemon bundle (e.g. `apps/honeycrisp/src/lib/honeycrisp/daemon.ts`)

```ts
return {
  ...doc, yjsLog, awareness, sync, remote,
  async [Symbol.asyncDispose]() {
    doc[Symbol.dispose]();         // genuine trigger
    await sync.whenDisposed;        // honest barrier
    // (and yjsLog.whenDisposed if relevant for the bundle)
  },
};
```

### `lazy()` location

Move from `packages/workspace/src/shared/lazy.ts` back to `packages/workspace/src/document/y-keyvalue/lazy.ts`. After the revert, the only remaining caller is `y-keyvalue-lww.ts` (sync use, the original use case). Co-located with its single caller.

The JSDoc note added in this branch about "for async disposal, prefer `lazy(async () => { ... })`" should be removed too. There are no async callers anymore.

## Implementation plan

This is a clean revert. Single atomic commit; no backwards-compatibility window because the previous spec's shape never shipped externally.

The commit's internal ordering so each step type-checks within the same commit:

1. Move `packages/workspace/src/shared/lazy.ts` → `packages/workspace/src/document/y-keyvalue/lazy.ts`. Update import in `y-keyvalue-lww.ts`.
2. `attach-indexed-db.ts`: drop `lazy` import; replace `lazy()` + `[Symbol.asyncDispose]` with `Promise.withResolvers` + `whenDisposed` field. Update `IndexedDbAttachment` type.
3. `attach-sync.ts`: same pattern. Update `SyncAttachment` type. JSDoc on `whenDisposed`.
4. `attach-yjs-log.ts`: same pattern. Update `YjsLogAttachment` type.
5. Each browser bundle's `wipe()` (5 apps): change `await idb[Symbol.asyncDispose]()` to `await idb.whenDisposed`. Same for `sync`.
6. Each daemon's `Symbol.asyncDispose` (4 apps + script): change `await sync[Symbol.asyncDispose]()` to `await sync.whenDisposed`. Same for `yjsLog` where it appears.
7. Tests: change `await att[Symbol.asyncDispose]()` to `await att.whenDisposed` (~17 sites across 3 test files).
8. Examples and playground configs: same migration.
9. Update spec straggler greps in the previous spec; add a "Superseded" header pointing to this spec.
10. Update any docs articles or skill references that talked about the lazy + Symbol.asyncDispose pattern.

Verification at the end of the commit:

```sh
bun test packages/workspace
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck
```

Manual smoke (browser): sign in, open a note/entry, sign out, confirm clean reload with no `onblocked` warnings.

## What we KEEP from the previous spec

Independent of the barrier-shape choice. These were correct calls and stay:

- y-indexeddb double-binding fix (`ydoc.off('destroy', idb.destroy)` after construction).
- Bundle `wipe()` owns the dispose+clear sequence; consumer no longer composes it in `client.ts`.
- The big comment block in `client.ts` explaining ordering: gone.
- Bundle `Symbol.dispose` vs `wipe()` distinction (different verbs for different ops).
- Daemon `Symbol.asyncDispose` pattern (the bundle is the genuine trigger).
- CLI `hasDaemonRuntimeShape` slimmed to the four fields `up.ts` actually invokes.
- `hasSyncStatusShape`, `hasSyncErrorShape`, `hasSyncFailedReasonShape` deleted.
- `BrowserWorkspace` and `Workspace` types deleted.
- `AwarenessAttachment` trimmed (no more `setLocalField` / `getLocalField` / `getLocal` / `getAll`).
- `BroadcastChannelAttachment` collapsed to `void` return.
- `EncryptionAttachment.whenDisposed` removed (it's a sync attachment; barrier didn't earn its keep).
- `EncryptionAttachment.register` removed from public type (kept in closure).
- CLI rejection logging in `disposeStartedDaemonRoutes`.
- The `whenSynced.then(() => {})` ceremony fix in `attach-indexed-db.ts`.

## What we REVERT

Specifically the attach-level barrier-shape choice and its supporting machinery:

- `attach-indexed-db.ts`: `[Symbol.asyncDispose]` → `whenDisposed`; drop `lazy` import.
- `attach-sync.ts`: same.
- `attach-yjs-log.ts`: same.
- `lazy()` location: `shared/lazy.ts` → `document/y-keyvalue/lazy.ts`.
- Bundle `wipe()` and daemon `Symbol.asyncDispose`: function-call awaits → property-access awaits.
- All test sites that reach into attach-level dispose: function-call awaits → property-access awaits.

## Rejected alternatives

### Re-keep `[Symbol.asyncDispose]` at the attach level

This is what the previous spec did. The semantic mismatch (verb syntax wrapping barrier semantics) was the discovery that motivated this spec. Re-staying with it would re-litigate the same trade-off after deciding it.

### Drop attach-level barriers entirely; bundle owns coordination internally

Bundle factory would have to register its own `ydoc.once('destroy', ...)` per child, track barrier promises manually. Couples the bundle to attachment internals. Loses the test/daemon use case for an attach-level barrier. The `whenDisposed` field gives composers a clean handle without leaking implementation.

### Hybrid: expose both `whenDisposed` AND `[Symbol.asyncDispose]`

Same operation, two shapes, with TypeScript silently picking one based on `using` vs `await using`. Cohesive-clean-breaks rejects this exact pattern. Don't smuggle backward compatibility into the surface.

### Keep `lazy()` in `shared/`

Currently three import sites in this branch (after revert: one: `y-keyvalue-lww.ts`). `shared/` as a location implies cross-cutting use; one caller doesn't justify the implication. Co-locating with the single caller matches what the code actually is: y-keyvalue's internal helper.

### Lean into y-indexeddb's auto-binding (drop `attachIndexedDb`'s barrier entirely)

Discussed and rejected during the second-read. IDB's `deleteDatabase` does block natively on open connections, so the explicit barrier is technically redundant for correctness. But the explicit await communicates intent in the bundle's `wipe()` method, gives tests a clean barrier for close-then-reopen, and keeps the attach-level surface symmetric across `idb` / `sync` / `yjsLog`. The barrier earns its keep through readability and uniformity, not through correctness alone.

## Edge cases

### External `ydoc.destroy()` callers (tests, future integrations)

Cascade still fires. The async work runs via `try { await asyncWork() } finally { resolveDisposed() }`. Whether anyone awaits `whenDisposed` or not, the work happens. The barrier is opt-in for callers that need ordering.

### Tests that close-then-reopen

```ts
ydoc.destroy();
await idb.whenDisposed;          // fence
const fresh = new IndexeddbPersistence(name, ydoc2);
```

Identical semantics to the previous shape; only the syntax changes (property access instead of function call).

### Async work rejection inside the destroy handler

`try { await asyncWork() } finally { resolveDisposed() }`: `resolveDisposed()` always fires, even on throw. The barrier resolves even if the async work failed. Errors during cleanup are not propagated to barrier-awaiters; they're cleanup-flow errors, not critical-path. (Same as the implemented identity-reset's behavior; this is intentional.)

If a future caller needs explicit failure propagation: switch to `try { await asyncWork(); resolveDisposed(); } catch (e) { rejectDisposed(e); }`. Out of scope for this spec.

### HMR

Unchanged. `import.meta.hot.dispose(() => { auth[Symbol.dispose](); bundle[Symbol.dispose](); })` is sync fire-and-forget. The cascade fires; in-flight async work goes to background; new module instance opens fresh resources. IDB serializes via platform-level open/close ordering.

### Daemon shutdown via `await using`

```ts
await using runtime = await startDaemon(...);
// ... at scope exit ...
// runtime[Symbol.asyncDispose]() called automatically:
//   doc[Symbol.dispose]()           ← trigger
//   await sync.whenDisposed          ← barrier
```

This is the cleanest use of `Symbol.asyncDispose`: at the bundle level, where the call IS the trigger and the body explicitly awaits the barriers.

## Success criteria

- [x] No source file (apps, packages, examples, playground, tests) calls `attachment[Symbol.asyncDispose]()` for attach-level cleanup. Daemon-level `[Symbol.asyncDispose]()` calls remain (legitimate trigger).
- [x] `attachIndexedDb`, `attachSync`, `attachYjsLog` expose `whenDisposed: Promise<unknown>` on their return types.
- [x] `lazy()` lives at `packages/workspace/src/document/y-keyvalue/lazy.ts`. No imports from `../shared/lazy.js`.
- [x] `attach-indexed-db.ts`, `attach-sync.ts`, `attach-yjs-log.ts` have no `lazy` imports.
- [x] Bundle `wipe()` awaits `whenDisposed` properties (not function calls).
- [x] Daemon `[Symbol.asyncDispose]` body awaits `whenDisposed` properties.
- [x] CLI `hasDaemonRuntimeShape` does NOT re-add `whenDisposed` checks (audit established CLI never reads it).
- [x] All workspace tests pass.
- [ ] All app typechecks pass.
- [x] Previous spec marked as superseded with a pointer to this one.

## Files to inspect

```
move:
  packages/workspace/src/shared/lazy.ts
  → packages/workspace/src/document/y-keyvalue/lazy.ts

edit (workspace package):
  packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts        (lazy import path)
  packages/workspace/src/document/attach-indexed-db.ts                (whenDisposed; drop lazy)
  packages/workspace/src/document/attach-sync.ts                      (whenDisposed; drop lazy)
  packages/workspace/src/document/attach-yjs-log.ts                   (whenDisposed; drop lazy)

edit (browser bundles):
  apps/fuji/src/lib/fuji/browser.ts                                   (wipe: whenDisposed)
  apps/honeycrisp/src/lib/honeycrisp/browser.ts                       (wipe: whenDisposed)
  apps/opensidian/src/lib/opensidian/browser.ts                       (wipe: whenDisposed)
  apps/zhongwen/src/lib/zhongwen/browser.ts                           (wipe: whenDisposed)
  apps/tab-manager/src/lib/tab-manager/extension.ts                   (wipe: whenDisposed)

edit (daemon bundles):
  apps/fuji/src/lib/fuji/daemon.ts                                    (whenDisposed)
  apps/fuji/src/lib/fuji/script.ts                                    (whenDisposed)
  apps/honeycrisp/src/lib/honeycrisp/daemon.ts                        (whenDisposed)
  apps/opensidian/src/lib/opensidian/daemon.ts                        (whenDisposed)
  apps/zhongwen/src/lib/zhongwen/daemon.ts                            (whenDisposed)

edit (tests):
  packages/workspace/src/document/attach-sync.test.ts                 (~6 sites)
  packages/workspace/src/document/attach-yjs-log.test.ts              (~5 sites)
  packages/workspace/src/document/attach-yjs-log-reader.test.ts       (~6 sites)

edit (examples + playground):
  examples/notes-cross-peer/notes.ts                                  (whenDisposed)
  playground/opensidian-e2e/epicenter.config.ts                       (whenDisposed)
  playground/tab-manager-e2e/epicenter.config.ts                      (whenDisposed)

edit (docs / specs / skills):
  specs/20260504T220000-lazy-disposers-bundle-owns-wipe.md            (mark superseded)
  docs/articles/lazy-initializer-pattern.md                            (refresh: only sync use)
  docs/articles/20260422T160000-sync-dispose-cascade.md                (refresh if it mentions lazy)
  .agents/skills/attach-primitive/SKILL.md                             (whenDisposed pattern)
  .agents/skills/workspace-api/references/primitive-api.md             (same)
  packages/workspace/README.md                                         (refresh if needed)
```

## Verification commands

```sh
bun test packages/workspace
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck
```

## Straggler greps

```sh
# Symbol.asyncDispose should appear ONLY on daemon bundle return values:
rg -n "\[Symbol\.asyncDispose\]" apps packages -S | rg -v daemon

# lazy() use should be confined to y-keyvalue:
rg -n "from.*lazy" packages/workspace/src -S
# Expected: only y-keyvalue-lww.ts importing from ./lazy.js

# whenDisposed should appear in attach-* return types and composer call sites:
rg -n "whenDisposed" packages/workspace/src apps -S | rg -v test

# No lingering imports from shared/lazy:
rg -n "shared/lazy" apps packages -S
# Expected: empty (after the move)
```

## Commit message

```
refactor(workspace): restore whenDisposed barriers on async attachments

Reverts the [Symbol.asyncDispose] direction from
specs/20260504T220000-lazy-disposers-bundle-owns-wipe.md. At the
attach-level, the function-call syntax obscured the cascade dependency:
`await idb[Symbol.asyncDispose]()` looked like a trigger but was a
memoized retrieval of a Promise the cascade-fired ydoc.destroy already
kicked off. Restores `whenDisposed: Promise<unknown>` so attach-level
barriers are honest property access, symmetric with whenLoaded /
whenConnected.

Bundle-level Symbol.asyncDispose stays where it earns its keep
(daemons, where the call IS the trigger). Browser bundles keep the
Symbol.dispose + wipe() distinction for HMR vs full reset.

Drops `lazy()` from the three async attach* primitives. Moves lazy()
back to packages/workspace/src/document/y-keyvalue/lazy.ts (its only
remaining caller is y-keyvalue-lww.ts).

All other cleanups from the superseded spec stay: y-indexeddb
double-binding fix, bundle.wipe() ordering, CLI duck-type slim,
dropped types/surfaces, etc.

See specs/20260504T230000-attach-whendisposed-honest-barriers.md.
```

## Review

**Completed**: 2026-05-04
**Branch**: `feat/lazy-disposers-bundle-owns-wipe`

### Summary

The implementation restored `whenDisposed` barriers on `attachIndexedDb`, `attachSync`, and `attachYjsLog`, then migrated browser bundle `wipe()` methods, daemon bundle `Symbol.asyncDispose` bodies, tests, examples, playground configs, docs, and skill references to property awaits. `lazy()` moved back under `document/y-keyvalue`, with `y-keyvalue-lww.ts` as its only live caller.

The previous spec is marked superseded. The earlier cleanups outside the attach-level barrier shape stayed in place: y-indexeddb double-binding fix, bundle-owned wipe ordering, daemon bundle async disposal, CLI duck-type slim, dropped types and surfaces, and the IndexedDB `whenSynced` ceremony fix.

### Commits

- `9f9a76bb5` `refactor(workspace): restore whenDisposed barriers on async attachments`

### Verification

Passed:

```sh
bun test packages/workspace
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/auth-workspace typecheck
```

Straggler greps were run. The targeted attachment disposer call grep is empty:

```sh
rg -n "(idb|sync|yjsLog|writer|reopen|att)\[Symbol\.asyncDispose\]\(\)" apps packages examples playground -S
```

`lazy()` imports are confined to `packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts`, and `rg -n "shared/lazy" apps packages -S` is empty. The broad `rg -n "\[Symbol\.asyncDispose\]" apps packages -S | rg -v daemon` still reports legitimate non-attachment uses in CLI daemon runtime disposal, logger sink disposal, tests, README examples, Fuji script bundle disposal, and historical package specs.

Blocked:

```sh
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck
```

The app checks fail on diagnostics outside this diff, including shared `packages/svelte-utils/src/from-table.svelte.ts`, `packages/ui/src/sonner/toast-on-error.ts`, `packages/ui` `#/utils.js` resolution, Svelte `children` prop diagnostics, and unrelated app component errors.
