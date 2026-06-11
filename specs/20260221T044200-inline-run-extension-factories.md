# Inline run-extension-factories

**Date**: 2026-02-21
**Status**: Complete
**Author**: AI-assisted

## Overview

Delete `run-extension-factories.ts` and inline its logic into both call sites (`create-workspace.ts` and `create-document-binding.ts`), simplified for each case. The shared abstraction hides an asymmetry between the two callers that makes the code harder to understand without providing meaningful deduplication.

## Motivation

### Current State

`runExtensionFactories()` was extracted in the "Unify Extension Lifecycle" spec (`20260220T195900`) to provide a single source of truth for extension initialization. It handles void skip, `defineExtension` normalization, LIFO cleanup on throw, and incremental `whenReady` composition.

Two call sites:

**Workspace builder** (`create-workspace.ts:249`): always passes 1 entry:

```typescript
const result = runExtensionFactories({
  entries: [{ key, factory }],  // always length 1
  buildContext: ({ whenReadyPromises }) => ({
    id, ydoc, definitions, tables, kv, awareness,
    batch: (fn: () => void) => ydoc.transact(fn),
    whenReady: /* composite */,
    extensions,
  }),
  priorDestroys: state.extensionCleanups,
});
```

**Document binding** (`create-document-binding.ts:254`): passes N entries, no priorDestroys:

```typescript
factoryResult = runExtensionFactories({
  entries,  // N applicable extensions
  buildContext: ({ whenReadyPromises, extensions }) => ({
    id, ydoc: contentYdoc,
    whenReady: /* composite */,
    extensions: { ...extensions },
  }),
  // no priorDestroys
});
```

This creates problems:

1. **Hidden asymmetry**: The workspace side always passes a single-element array. The loop, incremental `buildContext`, and LIFO cleanup of _new_ entries are all dead code paths for this caller. The document side is the only caller that uses the multi-entry loop.
2. **`priorDestroys` is a workspace-only concern**: The document binding never passes it (defaults to `[]`). This parameter exists solely for one caller, leaking workspace-specific cleanup semantics into the "shared" helper.
3. **Indirection without payoff**: To understand what `withExtension()` does, you jump to `runExtensionFactories`, mentally strip away the loop (1 entry), ignore `priorDestroys` context, and back out. The actual logic for the workspace case is ~10 lines.
4. **Fire-and-forget async cleanup**: The runner is synchronous but accepts `MaybePromise<void>` destroys. Async destroy errors are silently swallowed via `result.catch(() => {})`. Each caller should handle cleanup in its own context (the document binding `open()` is already `async`).
5. **`any` types at the boundary**: Three `biome-ignore noExplicitAny` comments. The function erases type safety that each caller preserves locally via generics.
6. **No direct tests**: `runExtensionFactories` has zero dedicated tests: it's only tested indirectly through workspace and document binding tests. Inlining doesn't lose test coverage.
7. **Confusing name**: "Run extension factories" describes the mechanism (calling functions), not the purpose (initializing extensions with safe cleanup). Every reader's first question is "what does this actually do?"

### Desired State

Each caller owns its initialization logic directly. The workspace side is a simple try/catch around a single factory call. The document side is a self-contained loop. Both are obvious without jumping to a shared module.

**Workspace builder** (~10 lines, no loop):

```typescript
withExtension(key, factory) {
  const ctx = { id, ydoc, definitions, tables, kv, awareness, ... };
  try {
    const raw = factory(ctx);
    if (!raw) return buildClient(extensions, state);

    const resolved = defineExtension(raw);
    return buildClient(
      { ...extensions, [key]: resolved },
      {
        extensionCleanups: [...state.extensionCleanups, resolved.destroy],
        whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
      },
    );
  } catch (err) {
    // Clean up prior extensions in LIFO order
    for (let i = state.extensionCleanups.length - 1; i >= 0; i--) {
      try { state.extensionCleanups[i]!(); } catch { /* logged below */ }
    }
    throw err;
  }
}
```

**Document binding** (~20 lines, loop with LIFO):

```typescript
const extensions = {};
const destroys = [];
const whenReadyPromises = [];

try {
	for (const { key, factory } of applicableEntries) {
		const ctx = {
			id,
			ydoc: contentYdoc,
			whenReady:
				whenReadyPromises.length === 0
					? Promise.resolve()
					: Promise.all(whenReadyPromises).then(() => {}),
			extensions: { ...extensions },
		};
		const raw = factory(ctx);
		if (!raw) continue;

		const resolved = defineExtension(raw);
		extensions[key] = resolved;
		destroys.push(resolved.destroy);
		whenReadyPromises.push(resolved.whenReady);
	}
} catch (err) {
	for (let i = destroys.length - 1; i >= 0; i--) {
		try {
			destroys[i]!();
		} catch {
			/* continue */
		}
	}
	contentYdoc.destroy();
	throw err;
}
```

## Design Decisions

| Decision                        | Choice                                          | Rationale                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete vs rename                | Delete `run-extension-factories.ts` entirely    | No callers, not exported, no direct tests. Zero orphan risk.                                                                                                                                                                                              |
| Keep `lifecycle.ts` as-is       | Don't merge anything into it                    | `lifecycle.ts` is a clean protocol definition (types + `defineExtension`). Adding execution logic would muddy the separation.                                                                                                                             |
| Keep `defineExtension()`        | Still used by both call sites for normalization | The normalizer is genuinely shared and tiny. It stays in `lifecycle.ts`.                                                                                                                                                                                  |
| Workspace cleanup: sync         | Keep fire-and-forget for sync context           | `withExtension()` is synchronous by design. The workspace `destroy()` method already handles proper async cleanup in LIFO order: the try/catch in `withExtension` is only for factory _construction_ errors, not async teardown. Match current behavior. |
| Document cleanup: sync in catch | Keep sync cleanup in factory catch              | The factory loop is synchronous (intentionally: no await between `docs.get()` and `docs.set()`). Async cleanup of `whenReady` rejections is already handled separately in the `whenReady.catch()` block below. Match current behavior.                   |
| Don't "fix" async cleanup       | Out of scope                                    | Improving async destroy error handling is a valid concern but orthogonal to this refactor. Keep behavior identical.                                                                                                                                       |

## Implementation Plan

### Phase 1: Inline into workspace builder

- [x] **1.1** In `create-workspace.ts`, replace the `runExtensionFactories()` call inside `withExtension()` with direct inline logic: call factory, void check, `defineExtension()`, try/catch with LIFO cleanup of `state.extensionCleanups`
- [x] **1.2** Remove the import of `runExtensionFactories` from `create-workspace.ts`

### Phase 2: Inline into document binding

- [x] **2.1** In `create-document-binding.ts`, replace the `runExtensionFactories()` call inside `open()` with direct inline logic: loop over applicable entries, build context per-iteration, void skip, `defineExtension()`, accumulate destroys/whenReadyPromises, LIFO cleanup on throw + `contentYdoc.destroy()`
- [x] **2.2** Remove the imports of `runExtensionFactories` and `RunExtensionFactoriesResult` from `create-document-binding.ts`

### Phase 3: Delete the file

- [x] **3.1** Delete `run-extension-factories.ts`
- [x] **3.2** Verify no other imports reference it (already confirmed: only 2 callers, not in index.ts)

### Phase 4: Verify

- [x] **4.1** Run `bun test` on workspace tests (`create-workspace.test.ts`, `create-document-binding.test.ts`): all existing tests must pass unchanged (61 tests, 0 failures)
- [x] **4.2** Run LSP diagnostics on both modified files: zero errors
- [ ] **4.3** Run full build to confirm no import breakage

## Edge Cases

### Builder branching

The workspace builder's immutable state pattern (new arrays per `buildClient`) is unaffected. Each `withExtension()` call still creates a new state snapshot with its own `extensionCleanups` and `whenReadyPromises`. The inline try/catch reads from the same `state.extensionCleanups` the current code passes as `priorDestroys`.

### Void factory return

Both inlined versions preserve the current behavior: `if (!raw) continue` (document) or `if (!raw) return buildClient(extensions, state)` (workspace). No semantic change.

### Factory throws with async prior destroys

Current behavior: async destroys are fire-and-forget in the sync catch block. This is preserved exactly. The workspace `destroy()` method handles proper async LIFO cleanup separately. This refactor doesn't change cleanup semantics.

## Open Questions

1. **Should we improve async destroy error handling while we're here?**
   - The current fire-and-forget `result.catch(() => {})` pattern swallows async cleanup errors silently
   - Options: (a) Keep as-is (scope discipline), (b) Log async cleanup errors to console, (c) Collect and attach to thrown error
   - **Recommendation**: Keep as-is. This is a behavior-preserving refactor. Async cleanup improvements should be a separate spec with its own test coverage.

## Success Criteria

- [x] `run-extension-factories.ts` is deleted
- [x] Both call sites contain self-contained, obvious initialization logic
- [x] All existing workspace and document binding tests pass unchanged
- [x] No new `any` types introduced (1 biome-ignore in document binding for runtime storage, down from 3 in the deleted file)
- [x] LSP diagnostics clean on both modified files
- [ ] Build passes

## Review

Behavior-preserving refactor executed as specified. Key observations:

- **Workspace inlining** simplified significantly: no loop, no `buildContext` callback, no `priorDestroys` parameter. The `whenReady` composition collapsed from a two-source merge (`state.whenReadyPromises` + accumulator) to just `state.whenReadyPromises` since there's always exactly one entry.
- **Document binding inlining** is nearly identical to the original `runExtensionFactories` loop: same accumulators, same incremental context building. The only addition is `contentYdoc.destroy()` after LIFO cleanup in the catch block (was previously in a separate outer catch).
- **Error handling semantics preserved exactly**: async fire-and-forget (`result.catch(() => {})`), sync error collection into `errors[]`, `console.error` logging, re-throw of the original error.
- **biome-ignore comments**: Went from 3 `noExplicitAny` comments in the deleted file to 1 in the document binding (for `resolvedExtensions` runtime storage). The workspace side needs zero since its generic types flow through naturally.
- **No `entries.map()` indirection**: The document binding iterates `applicableExtensions` directly instead of mapping to a separate `entries` array.

## References

- `packages/epicenter/src/workspace/run-extension-factories.ts`: file to delete
- `packages/epicenter/src/workspace/create-workspace.ts`: `withExtension()` method (~line 248)
- `packages/epicenter/src/workspace/create-document-binding.ts`: `open()` method (~line 252)
- `packages/epicenter/src/workspace/lifecycle.ts`: `defineExtension()` stays here, unchanged
- `packages/epicenter/specs/20260220T195900-unify-extension-lifecycle.md`: original spec that created `runExtensionFactories`
