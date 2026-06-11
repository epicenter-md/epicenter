# Pass Full Client to Extension Factories

**Date**: 2026-02-13
**Status**: Complete

> **Note (2026-02-14):** Fully implemented in two commits: `292841138 refactor(extensions): pass full client as extension factory context` and `311b8bb41 feat(extensions): complete transparent extension lifecycle (phases 3-4)`. Extension factories now receive the full client-so-far (including `whenReady`, `destroy`, `definitions`) as context.

## Overview

Pass the full client-so-far (including `whenReady`) as the extension factory context instead of a stripped-down `ExtensionContext`. This lets extensions sequence after prior extensions via `context.whenReady` and decouples `createSyncExtension` from needing a `persistence` config parameter.

No changes to how extensions are stored. No changes to `defineExtension`. No changes to `Extension<T>`. The only change is what the factory _receives_.

## Motivation

### Current State

Extension factories receive a stripped-down context missing `whenReady`:

```typescript
// create-workspace.ts, line 159-166:
const context = { id, ydoc, tables, kv, awareness, extensions };
// Missing: whenReady, destroy, definitions
```

This forces `createSyncExtension` to manually orchestrate persistence:

```typescript
// sync.ts: has to take persistence as a config parameter:
export type SyncExtensionConfig = {
	url: string | ((workspaceId: string) => string);
	token?: string;
	getToken?: (workspaceId: string) => Promise<string>;
	persistence: (context: { ydoc: Y.Doc }) => Lifecycle; // ← forced coupling
};
```

The sync extension mixes sync config (`url`, `token`, `getToken`) with persistence config (`persistence`) in one flat object. It manually awaits persistence, then connects the WebSocket: duplicating orchestration the framework already does.

### Desired State

```typescript
// Persistence and sync are separate extensions:
.withExtension('persistence', indexeddbPersistence)
.withExtension('sync', createSyncExtension({
  url: 'ws://localhost:3913/workspaces/{id}/sync',
}))
```

Inside `createSyncExtension`:

```typescript
export function createSyncExtension(config: SyncExtensionConfig): ExtensionFactory {
  return (context) => {
    const provider = createSyncProvider({
      doc: context.ydoc,
      url: resolvedUrl,
      connect: false,
      awareness: context.awareness.raw,
    });

    const whenReady = (async () => {
      await context.whenReady;   // wait for all prior extensions (persistence, etc.)
      provider.connect();         // then connect with accurate state vector
    })();

    return defineExtension({
      exports: { get provider() { return provider; }, reconnect(...) { ... } },
      whenReady,
      destroy: () => provider.destroy(),
    });
  };
}
```

No `persistence` parameter. The extension system handles sequencing.

## Design Decisions

| Decision                                             | Choice         | Rationale                                                                                                           |
| ---------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Keep `defineExtension`                               | Yes, unchanged | Still useful for defaults and signaling intent. Extension authors don't change their code.                          |
| Keep `Extension<T>` type                             | Yes, unchanged | Internal separation of exports/lifecycle stays. Framework still plucks lifecycle for management.                    |
| Don't change extension storage                       | Yes            | `extensions[key]` stays as `result.exports`. No lifecycle merged onto stored objects. Keeps consumer API unchanged. |
| Pass full client as context                          | Yes            | `ExtensionContext` becomes `WorkspaceClient`-so-far. `context.whenReady` is the composite of all prior extensions.  |
| `ExtensionContext` type → alias to `WorkspaceClient` | Yes            | Eliminates the parallel type. One fewer type to maintain. Extension factories get the same shape consumers get.     |
| Apply to both static and dynamic APIs                | Yes            | Both `create-workspace.ts` files have identical patterns.                                                           |

## Architecture

```
BEFORE:
  factory receives:  { id, ydoc, tables, kv, awareness, extensions }
  factory CANNOT:    await context.whenReady  (doesn't exist)

AFTER:
  factory receives:  { id, ydoc, tables, kv, awareness, extensions, whenReady, destroy, definitions, ... }
  factory CAN:       await context.whenReady  (composite of all prior extensions)
```

Extension storage is unchanged: `extensions[key] = result.exports`

The key insight: `buildClient` already computes `whenReady = Promise.all(whenReadyPromises)` on each call. When `.withExtension()` is called, the client-so-far already has a `whenReady` that represents extensions 0..N. We just need to pass that client as context instead of building a stripped-down object.

## Implementation Plan

### Phase 1: Pass full client as context (static API)

- [x] **1.1** In `packages/epicenter/src/static/create-workspace.ts`, change `withExtension` to pass `client` instead of `{ id, ydoc, tables, kv, awareness, extensions }`
- [x] **1.2** Update `ExtensionContext` type in `packages/epicenter/src/static/types.ts`: alias it to `WorkspaceClient`-so-far (or add `whenReady`, `destroy`, `definitions` to match)
- [x] **1.3** Update `ExtensionFactory` type signature if needed to accept the new context shape
- [x] **1.4** Add test in `define-workspace.test.ts` verifying `context.whenReady` is accessible and resolves after prior extensions

### Phase 2: Same changes for dynamic API

- [x] **2.1** Apply identical context change to `packages/epicenter/src/dynamic/workspace/create-workspace.ts`
- [x] **2.2** Update `ExtensionContext` type in `packages/epicenter/src/dynamic/workspace/types.ts`
- [x] **2.3** Add test verifying `context.whenReady`

### Phase 3: Simplify `createSyncExtension`

- [x] **3.1** Remove `persistence` from `SyncExtensionConfig` type
- [x] **3.2** Rewrite `createSyncExtension` to use `context.whenReady` instead of manually orchestrating persistence
- [x] **3.3** Update call sites in `apps/tab-manager/src/entrypoints/background.ts` and `apps/tab-manager/src/lib/workspace-popup.ts` to use two separate extensions (`.withExtension('persistence', ...).withExtension('sync', ...)`)
- [x] **3.4** Update tests in `sync.test.ts`
- [x] **3.5** Update JSDoc and examples on `createSyncExtension`, `indexeddbPersistence`, `filesystemPersistence`

### Phase 4: Cleanup

- [x] **4.1** Remove `Lifecycle` import from `sync.ts` (no longer needed for the persistence parameter type)
- [x] **4.2** Audit JSDoc across `lifecycle.ts` and `types.ts`: remove "consumers never see lifecycle hooks" language, update `ExtensionContext` docs
- [x] **4.3** Run build + tests, verify everything passes (5 pre-existing type errors in `table-helper.ts`, unrelated)

## Edge Cases

### `context.whenReady` timing

`context.whenReady` is `Promise.all(whenReadyPromises)` computed at `buildClient` time. At the point extension N+1's factory runs, `whenReadyPromises` contains promises from extensions 0..N. This correctly represents "everything before me is ready."

### Extension with no prior extensions

First extension in the chain gets `context.whenReady = Promise.all([])` which resolves immediately. Correct behavior, nothing to wait for.

### Extension factory calls `context.destroy()`

An extension factory could call `context.destroy()` and nuke the workspace. This is the same trust model as any npm dependency. Extensions are locally installed code chosen by the developer. Not worth a type-level guard.

### `indexeddbPersistence` function signature

Currently `indexeddbPersistence` takes `{ ydoc }`: a subset of `ExtensionContext`. After this change, it receives the full client. The destructured `{ ydoc }` still works since it just picks what it needs. No change to `indexeddbPersistence` itself.

## Success Criteria

- [x] `context.whenReady` is accessible and correctly typed in extension factories
- [x] `createSyncExtension` no longer takes a `persistence` config parameter
- [x] Tab manager app uses two separate extensions (persistence + sync) instead of one combined
- [x] All existing tests pass
- [x] New tests verify `context.whenReady` resolves after prior extensions
- [x] Build passes with no new type errors (5 pre-existing in `table-helper.ts`)

## References

- `packages/epicenter/src/static/create-workspace.ts`: Static builder, lines 159-166 (context construction)
- `packages/epicenter/src/static/types.ts`: `ExtensionContext`, `ExtensionFactory`, `WorkspaceClientBuilder`
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic builder, line 129 (context construction)
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic `ExtensionContext`, `ExtensionFactory`
- `packages/epicenter/src/shared/lifecycle.ts`: `defineExtension`, `Extension<T>` (unchanged)
- `packages/epicenter/src/extensions/sync.ts`: `createSyncExtension` (simplification target)
- `packages/epicenter/src/extensions/sync/web.ts`: `indexeddbPersistence`
- `packages/epicenter/src/extensions/sync/desktop.ts`: `filesystemPersistence`
- `apps/tab-manager/src/entrypoints/background.ts`: Consumer call site
- `apps/tab-manager/src/lib/workspace-popup.ts`: Consumer call site
