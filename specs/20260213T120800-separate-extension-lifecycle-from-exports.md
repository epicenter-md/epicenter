# Separate Extension Lifecycle from Exports

**Date**: 2026-02-13
**Status**: Complete
**Author**: AI-assisted

## Overview

Introduce `defineExtension()` to separate lifecycle hooks (`destroy`, `whenReady`) from custom exports, so the framework manages lifecycle internally and `workspace.extensions[key]` only exposes what consumers actually need.

## Motivation

### Current State

Extensions return a flat object mixing lifecycle hooks with custom exports:

```typescript
// packages/epicenter/src/extensions/sqlite/sqlite.ts
return defineExports({
  db: client,              // custom export
  pullToSqlite,            // custom export
  pushFromSqlite,          // custom export
  async destroy() { ... }, // lifecycle hook
});
```

The framework then treats the whole object as both "lifecycle container" and "consumer API":

```typescript
// In withExtension(): dynamic create-workspace.ts:131
const exports = defineExports(result as Record<string, unknown>);
extensionCleanups.push(() => exports.destroy());
whenReadyPromises.push(exports.whenReady);
// ...
const newExtensions = { ...extensions, [key]: exports };
```

This creates problems:

1. **Lifecycle leaks to consumers.** `workspace.extensions.sqlite.destroy()` shows up in autocomplete and is callable. Consumers shouldn't be destroying individual extensions: that's the framework's job.

2. **`defineExports` destructure+spread kills getters.** `ySweetPersistSync` had to opt out of `defineExports()` entirely because `{ ...rest }` strips its `provider` getter. The comment in the code:

   ```typescript
   // Build exports manually instead of using defineExports() because
   // defineExports() destructures + spreads, which strips the provider getter.
   ```

3. **Static workspace doesn't aggregate `whenReady`.** The static `create-workspace.ts` pushes `exports.destroy()` but never collects `whenReady` into a top-level promise. The dynamic version does. Inconsistency.

4. **No type distinction between "framework hooks" and "your stuff."** Both are `Lifecycle & T`: a flat intersection. There's no way for the type system to say "these two fields are special."

### Desired State

```typescript
// Extension authoring
return defineExtension({
  exports: { db, pullToSqlite, pushFromSqlite },
  destroy: () => db.close(),
});

// Consumer access: clean, no lifecycle pollution
workspace.extensions.sqlite.db           // ✅ visible
workspace.extensions.sqlite.destroy      // ❌ doesn't exist
workspace.extensions.sqlite.whenReady   // ❌ doesn't exist

// Getter-based extensions just work
return defineExtension({
  exports: {
    get provider() { return provider; },
    reconnect(newAuth) { ... },
  },
  whenReady,
  destroy() { persistenceCleanup?.(); provider.destroy(); },
});
```

## Research Findings

### Extension Authoring Inventory (8 extensions)

| Extension             | Current Pattern   | Custom Exports                         | Lifecycle Hooks | Getter? |
| --------------------- | ----------------- | -------------------------------------- | --------------- | ------- |
| websocketSync         | `defineExports()` | none                                   | `destroy`       | No      |
| sqliteProvider        | `defineExports()` | `db`, tables, pull/push                | `destroy`       | No      |
| markdownProvider      | `defineExports()` | pull/push/scan                         | `destroy`       | No      |
| indexeddbPersistence  | `defineExports()` | `clearData`                            | both            | No      |
| persistence (desktop) | `defineExports()` | none                                   | `whenReady`     | No      |
| workspace-persistence | `defineExports()` | none                                   | both            | No      |
| ySweetPersistSync     | **manual object** | `provider`, `reconnect`                | both            | **Yes** |
| localRevisionHistory  | **manual object** | save/list/view/restore/count/directory | `destroy` only  | No      |

**Key finding**: 6/8 extensions use `defineExports()`. The 2 that don't have legitimate reasons: getters and missing `whenReady`. Option A naturally handles both cases.

### Extension Consumption Inventory

| Access Pattern            | Count                 | Location                                             |
| ------------------------- | --------------------- | ---------------------------------------------------- |
| `extensions.X.customProp` | Many                  | Throughout apps and tests                            |
| `extensions.X.whenReady`  | **1**                 | `apps/tab-manager/src/entrypoints/background.ts:346` |
| `extensions.X.destroy()`  | **0** (consumer code) | Only framework-internal (2 sites)                    |
| Spread/iterate extensions | **0** (consumer code) | Only framework-internal builder                      |

**Key finding**: Separating lifecycle from exports breaks exactly 1 line of real consumer code. The refactor is essentially free from a migration standpoint.

## Design Decisions

| Decision               | Choice                                                            | Rationale                                                              |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Separation approach    | Structured return object with `exports` key + top-level lifecycle | Cleanest type boundary; framework never exposes lifecycle to consumers |
| Helper name            | `defineExtension()` replaces `defineExports()`                    | Clean break; clear naming distinction                                  |
| Exports storage        | Store by reference (no spread)                                    | Preserves getters, proxies, and object identity                        |
| `defineExports()` fate | Remove entirely                                                   | Breaking change: no compat shim, no deprecation period                |
| Static/dynamic parity  | Both workspaces share same normalization                          | Fixes the `whenReady` aggregation inconsistency                        |
| `whenReady` default    | `Promise.resolve()` when omitted                                  | Same as today: extension with no async init is ready immediately      |
| `destroy` default      | `() => {}` when omitted                                           | Same as today: extension with no cleanup is a no-op                   |

## Architecture

### New Return Shape

```
defineExtension() input                    defineExtension() output
┌──────────────────────────┐               ┌──────────────────────────┐
│  exports?: { ... }       │               │  exports: T              │  ← stored by reference
│  whenReady?: Promise    │  ──────────►  │  lifecycle: {            │
│  destroy?: () => void    │               │    whenReady: Promise   │  ← framework-managed
│                          │               │    destroy: () => void   │  ← framework-managed
└──────────────────────────┘               │  }                       │
                                           └──────────────────────────┘
```

### Framework Consumption

```
withExtension(key, factory)
─────────────────────────────

STEP 1: Call factory (must return ExtensionResult from defineExtension())
─────────────────────────────────────────────────────────────────────────
const { exports, lifecycle } = factory(context);

STEP 2: Register lifecycle
──────────────────────────
extensionCleanups.push(lifecycle.destroy);
whenReadyPromises.push(lifecycle.whenReady);

STEP 3: Store exports by reference
───────────────────────────────────
allExtensions[key] = exports;  // NO spread: getters survive
```

### Type Flow

```typescript
// What the extension author writes
defineExtension({
	exports: { db, helper },
	destroy: () => db.close(),
});

// What defineExtension() returns (internal)
type ExtensionResult<T> = {
	exports: T;
	lifecycle: Lifecycle;
};

// What workspace.extensions[key] exposes (consumer-facing)
workspace.extensions.sqlite; // type: { db: Database; helper: () => void }
//                              no .destroy, no .whenReady
```

## Implementation Plan

### Phase 1: Core: `defineExtension()` replaces `defineExports()`

- [x] **1.1** Create `defineExtension()` in `shared/lifecycle.ts`
  - Accepts `{ exports?, whenReady?, destroy? }`
  - Returns `{ exports: T, lifecycle: Lifecycle }` with defaults filled in
  - Stores `exports` by reference (no spread/copy)
- [x] **1.2** Remove `defineExports()` entirely from `shared/lifecycle.ts`
- [x] **1.3** Add `ExtensionResult<T>` type to `shared/lifecycle.ts`
- [x] **1.4** Update `ExtensionExports` type (or remove if no longer needed)
- [x] **1.5** Tests: `defineExtension()` basic behavior, getter preservation, default filling

### Phase 2: Framework integration: both workspace systems

- [x] **2.1** Update `static/create-workspace.ts` `withExtension()`
  - Factory return type: `ExtensionResult<T>` (from `defineExtension()`)
  - Pluck `result.lifecycle` into internal arrays
  - Store only `result.exports` in `extensions[key]` by reference
  - **Add `whenReady` aggregation** (currently missing in static)
- [x] **2.2** Update `dynamic/workspace/create-workspace.ts` `withExtension()` with same pattern
- [x] **2.3** Update `WorkspaceClient` types in both `static/types.ts` and `dynamic/workspace/types.ts`
  - `extensions: TExtensions` maps to exports-only types (no `Lifecycle` in the type)
  - `withExtension` factory return type constraint: `ExtensionResult<T>` instead of `TExports extends Lifecycle`
- [x] **2.4** Add `whenReady` to static `WorkspaceClient` type (parity with dynamic)
- [x] **2.5** Tests: verify `workspace.extensions` doesn't expose destroy/whenReady, verify lifecycle still runs

### Phase 3: Migrate extensions

- [x] **3.1** `websocketSync` → `defineExtension()`
- [x] **3.2** `sqliteProvider` → `defineExtension()`
- [x] **3.3** `markdownProvider` → `defineExtension()`
- [x] **3.4** `indexeddbPersistence` → `defineExtension()` (via y-sweet-persist-sync/web.ts)
- [x] **3.5** `persistence` (desktop) → `defineExtension()` (via y-sweet-persist-sync/desktop.ts)
- [x] **3.6** `workspace-persistence` (app) → `defineExtension()`
- [x] **3.7** `ySweetPersistSync` → `defineExtension()` (getter-based: validates the design)
- [x] **3.8** `localRevisionHistory` → `defineExtension()` (no whenReady: validates defaults)

### Phase 4: Update consumers, exports, and cleanup

- [x] **4.1** Fix the 1 consumer site: `apps/tab-manager/src/entrypoints/background.ts:346`
  - `await client.extensions.sync.whenReady` → `await client.whenReady` (use workspace-level aggregated promise)
- [x] **4.2** Update re-exports: replace `defineExports` with `defineExtension` in `dynamic/extension.ts`, `dynamic/index.ts`, `static/index.ts`, `packages/epicenter/src/index.ts`
- [x] **4.3** Update `dynamic/provider-types.ts` re-exports
- [x] **4.4** Remove all remaining `defineExports` imports and references across the codebase
- [x] **4.5** Update tests that used `defineExports()` to use `defineExtension()`
- [x] **4.6** Run full test suite, fix any type errors: 868 pass, 2 skip, 0 fail

## Edge Cases

### Extension with no exports (lifecycle-only)

```typescript
// E.g., persistence that just syncs Y.Doc
return defineExtension({
	whenReady: loadPromise,
	destroy: cleanup,
});
// → exports: {} (empty object), lifecycle filled in
// → workspace.extensions.persistence is {}: valid, just empty
```

### Extension with no lifecycle (exports-only)

```typescript
// E.g., a pure computation helper
return defineExtension({
	exports: { compute: (x) => x * 2 },
});
// → lifecycle: { whenReady: Promise.resolve(), destroy: () => {} }
```

### Extension returning nothing

```typescript
// Side-effect-only extension (e.g., logging observer)
return defineExtension();
// → exports: {}, lifecycle: { whenReady: Promise.resolve(), destroy: () => {} }
```

### Getter on exports

```typescript
return defineExtension({
	exports: {
		get provider() {
			return currentProvider;
		},
	},
	destroy() {
		currentProvider.destroy();
	},
});
// → exports stored by reference, getter preserved
```

### Extension that needs both exports AND whenReady/destroy

```typescript
return defineExtension({
	exports: { db, pullToSqlite, pushFromSqlite },
	whenReady: db.initialize(),
	destroy: () => db.close(),
});
```

## Open Questions

1. **Should `workspace.extensions.X.whenReady` be available as an escape hatch?**
   - The tab-manager currently uses it. After migration it should use `workspace.whenReady` instead.
   - But some advanced use case might want per-extension readiness.
   - **Recommendation**: Don't expose it. If a real need arises later, extensions can explicitly include a readiness signal in their `exports`.

2. **Name: `defineExtension` vs `extension` vs `createExtension`?**
   - `defineExtension` matches `defineWorkspace`, `defineTable` naming.
   - `createExtension` implies instantiation (but this is a return-shape wrapper, not a factory).
   - **Recommendation**: `defineExtension`: consistent with codebase conventions.

## Success Criteria

- [x] `defineExtension()` exists and is exported from `@epicenter/workspace`
- [x] `workspace.extensions.sqlite` does NOT have `.destroy` or `.whenReady` in its type
- [x] `workspace.whenReady` works on both static and dynamic workspaces
- [x] `workspace.destroy()` still calls all extension cleanup in reverse order
- [x] Getter-based extensions (ySweetPersistSync) use `defineExtension()` and getter survives
- [x] `defineExports()` is fully removed: no references remain
- [x] All existing tests pass (updated to use `defineExtension()`): 868 pass, 2 skip, 0 fail
- [x] No `as any` or `@ts-ignore` introduced

## References

- `packages/epicenter/src/shared/lifecycle.ts`: Current `defineExports()` and `Lifecycle` type
- `packages/epicenter/src/static/create-workspace.ts`: Static workspace `withExtension()` (missing `whenReady` aggregation)
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic workspace `withExtension()` (has `whenReady` aggregation)
- `packages/epicenter/src/static/types.ts`: Static `ExtensionContext`, `ExtensionFactory`, `WorkspaceClientBuilder`
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic `ExtensionContext`, `ExtensionFactory`, `WorkspaceClientBuilder`
- `packages/epicenter/src/dynamic/extension.ts`: Re-exports lifecycle utilities
- `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: Getter-based manual object (prime migration candidate)
- `packages/epicenter/src/extensions/revision-history/local.ts`: No `whenReady`, manual object
- `apps/tab-manager/src/entrypoints/background.ts:346`: Only consumer accessing `.whenReady` on an extension

## Review

### Summary

Replaced `defineExports()` with `defineExtension()` across the entire codebase. This is a **breaking change**: there is no backwards compatibility shim. All extension factories now return `ExtensionResult<T>` with separated `exports` and `lifecycle` instead of the old flat `Lifecycle & T`.

### What Changed

**Core API** (`shared/lifecycle.ts`):

- `defineExports()` removed entirely
- `defineExtension()` added: accepts `{ exports?, whenReady?, destroy? }`, returns `{ exports: T, lifecycle: Lifecycle }`
- `ExtensionResult<T>` type added
- `ExtensionExports<T>` type alias removed

**Type system** (`static/types.ts`, `dynamic/workspace/types.ts`):

- `TExtensions` constraint relaxed from `Record<string, Lifecycle>` to `Record<string, unknown>`
- `ExtensionFactory` return type changed from `Lifecycle & T` to `ExtensionResult<T>`
- `withExtension` factory parameter updated to match
- `whenReady` added to static `WorkspaceClient` type (was missing: parity with dynamic)

**Framework** (`static/create-workspace.ts`, `dynamic/workspace/create-workspace.ts`):

- `withExtension()` now plucks `result.lifecycle` for internal management
- Stores `result.exports` by reference (no spread: getters survive)
- Static workspace now aggregates `whenReady` promises (previously missing)

**Extensions** (7 files):

- All migrated from `defineExports()` to `defineExtension()`
- `ySweetPersistSync` no longer needs a manual object workaround: `defineExtension()` stores exports by reference, preserving the `provider` getter

**Consumers** (3 files):

- `workspace-persistence` returns `ExtensionResult` via `defineExtension()`
- `tab-manager` uses `client.whenReady` instead of `extensions.sync.whenReady`
- `content-doc-store` tests use inline `Lifecycle` objects

### Commit History (8 waves, dependency-ordered)

1. `feat(lifecycle)!: replace defineExports with defineExtension`: foundation
2. `feat(types)!: update extension types to use ExtensionResult`: type definitions
3. `feat(workspace)!: pluck lifecycle from ExtensionResult in withExtension`: framework
4. `refactor(extensions): migrate all extensions to defineExtension`: 7 extension files
5. `refactor: update re-exports from defineExports to defineExtension`: package exports
6. `refactor: migrate consumers to defineExtension API`: apps and packages
7. `test: update tests for defineExtension API`: test migrations
8. `docs(spec): mark separate-extension-lifecycle spec complete`: this file

### Test Results

868 pass, 2 skip, 0 fail across 54 test files. Zero `defineExports` references remain in the codebase.
