# Flat Extension Type

**Date**: 2026-02-20
**Status**: Draft
**Author**: AI-assisted
**Scope**: `lifecycle.ts`, `create-workspace.ts` (static + dynamic), `create-document-binding.ts`, `types.ts` (static + dynamic), all extension factories, tests

## Overview

Flatten the `Extension` type from `{ exports?, lifecycle?: { whenReady?, destroy? } }` to a single flat object where custom exports, `whenReady`, and `destroy` coexist at the same level. The framework normalizes defaults via an internal `defineExtension()` helper so the stored form always has `whenReady: Promise<void>` and `destroy: () => MaybePromise<void>`. Both workspace and document extension initialization loops use the same normalization pattern.

## Motivation

### Current State

Extension factories return a nested shape: custom exports under `exports`, lifecycle hooks under `lifecycle`:

```typescript
// indexeddbPersistence (extensions/sync/web.ts)
return {
	exports: { clearData: () => idb.clearData() },
	lifecycle: {
		whenReady: idb.whenSynced,
		destroy: () => idb.destroy(),
	},
};

// revision-history (extensions/revision-history/local.ts)
return {
	exports: { save, list, view, restore, count, directory: snapshotDir },
	lifecycle: {
		destroy() {
			/* cleanup */
		},
	},
};
```

The framework destructures the nested shape:

```typescript
// In withExtension():
const result = factory(client);
const destroy = result.lifecycle?.destroy; // lifecycle.destroy
const whenReady = result.lifecycle?.whenReady; // lifecycle.whenReady
extensions[key] = result.exports ?? {}; // only exports stored
```

This creates problems:

1. **Five specs of churn.** The exports/lifecycle boundary has been introduced, wrapped, injected into, reverted, and re-flattened across five separate specs. The nesting is an internal bookkeeping detail that keeps surfacing as an authoring and ergonomics problem.

2. **Pre-existing bug: sqlite's `destroy` is silently dropped.** The sqlite extension already returns `destroy` at the top level (not inside `lifecycle`). The framework reads `result.lifecycle?.destroy` and misses it. The extension's cleanup never runs.

   ```typescript
   // sqlite returns this (extensions/sqlite/sqlite.ts:263-326):
   return {
	exports: { pullToSqlite, pushFromSqlite, db, ...drizzleTables },
	async destroy() {
		/* close db, clear timeouts */
	},
   };
   // Framework reads result.lifecycle?.destroy → undefined. Bug.
   ```

3. **No per-extension `whenReady` on stored form.** The stored form is just exports: no `whenReady`. Surgical await (waiting for a specific prior extension) requires either `Object.assign` injection or redundant `whenReady` in both exports and lifecycle.

4. **Two different initialization patterns.** Workspace extensions use separate `whenReadyPromises[]` and `extensionCleanups[]` arrays mutated across chained calls. Document extensions use a `lifecycles[]` array in a for loop. Same logic, different shapes.

### Desired State

Extension factories return a flat bag of properties. `whenReady` and `destroy` are reserved names at the top level alongside custom exports:

```typescript
// indexeddbPersistence: flat
return {
	clearData: () => idb.clearData(),
	whenReady: idb.whenSynced,
	destroy: () => idb.destroy(),
};

// revision-history: flat
return {
	save,
	list,
	view,
	restore,
	count,
	directory: snapshotDir,
	destroy() {
		/* cleanup */
	},
};

// sqlite: already partially flat (destroy was top-level), now fully flat
return {
	pullToSqlite,
	pushFromSqlite,
	db: sqliteDb,
	...drizzleTables,
	whenReady: initPromise,
	destroy: async () => {
		/* close db */
	},
};
```

The framework normalizes once. The stored form always includes `whenReady` and `destroy`:

```typescript
// Consumer access: flat, whenReady always present:
client.extensions.persistence.clearData();
await client.extensions.persistence.whenReady; // surgical await
client.extensions.sqlite.db.query('...');
await client.extensions.sqlite.whenReady; // surgical await
```

## Research Findings

### Spec History (5 Iterations)

| Spec                                              | Date       | What it did                                                          | Status              |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ------------------- |
| `20260213T120800` Separate Lifecycle from Exports | 2026-02-13 | Introduced `{ exports, lifecycle }` separation + `defineExtension()` | Complete            |
| `20260214T133054` Remove defineExtension          | 2026-02-14 | Removed `defineExtension()`, kept nested `{ exports?, lifecycle? }`  | Complete            |
| `20260220T200000` Extension Handle Passthrough    | 2026-02-20 | Wrapped stored form in `{ exports, lifecycle }` handle               | Complete (reverted) |
| `20260220T200000` Surgical Extension Await        | 2026-02-20 | Added per-extension `whenReady` via `Object.assign` injection        | Complete (reverted) |
| `20260220T195900` Flatten Extension Exports       | 2026-02-20 | Reverted handle passthrough, removed per-extension `whenReady`       | Complete            |

**Key finding**: Every iteration tried to solve the same tension: exports need to be flat for consumers, but lifecycle needs to be tracked for the framework. The nesting was never the right boundary: it kept leaking. The answer is to not separate them at all: `whenReady` and `destroy` are just properties on the same flat object, with reserved names.

### Current Factory Return Shapes (Audit)

| Extension             | `exports` key | `lifecycle` key | Top-level `destroy` | Top-level `whenReady` |
| --------------------- | ------------- | --------------- | ------------------- | --------------------- |
| sqlite                | Yes           | No              | **Yes (bug!)**      | No                    |
| indexeddbPersistence  | Yes           | Yes             | No                  | No                    |
| desktop persistence   | No            | Yes             | No                  | No                    |
| revision-history      | Yes           | Yes             | No                  | No                    |
| workspace-persistence | No            | Yes             | No                  | No                    |

**Key finding**: sqlite already returns `destroy` at the top level. The framework reads `result.lifecycle?.destroy` and silently misses it. This is a pre-existing bug that the flat type fixes by reading `result.destroy` directly.

### Initialization Loop Comparison

| Aspect            | Workspace extensions                   | Document extensions                       |
| ----------------- | -------------------------------------- | ----------------------------------------- |
| Collection        | Chain calls to `.withExtension()`      | `for` loop over registrations in `open()` |
| whenReady storage | `whenReadyPromises[]` (Promise array)  | `lifecycles[]` (objects, mapped later)    |
| Cleanup storage   | `extensionCleanups[]` (function array) | `lifecycles[]` (objects, mapped later)    |
| Void coercion     | `.then(() => {})` on each promise      | None                                      |
| Missing whenReady | Pushes `Promise.resolve()`             | Pushes lifecycle object, maps later       |

**Key finding**: Both loops do the same normalization differently. A shared `defineExtension()` utility eliminates the divergence.

## Design Decisions

| Decision                                             | Choice | Rationale                                                                                                                                                                |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flatten `{ exports, lifecycle }` to flat object      | Yes    | Ends 5 specs of churn. The nesting was never the right abstraction: it kept leaking through to authoring and consumer APIs.                                             |
| `whenReady` and `destroy` as reserved property names | Yes    | Unambiguously framework concepts. No domain extension would plausibly export either name for a different purpose.                                                        |
| Internal `defineExtension()` normalizer              | Yes    | Single function applies defaults (`whenReady ?? Promise.resolve()`, `destroy ?? () => {}`). Called by the framework, not by extension authors.                           |
| Extension authors return raw flat object             | Yes    | No wrapper function to import. `{ db, whenReady, destroy }` is a plain object literal. TypeScript infers the type.                                                       |
| One named type: `Extension<T>` = resolved form       | Yes    | The stored/consumer form with required `whenReady` and `destroy`. The factory input doesn't need a named type: it's just the constraint on `withExtension`'s parameter. |
| Composite `client.whenReady` kept                    | Yes    | Still useful as "wait for everything." Per-extension whenReady is additive, not a replacement.                                                                           |
| `Lifecycle` type kept                                | Yes    | Still used by providers and other non-extension contexts (e.g., `filesystemPersistence` returns raw `Lifecycle`). Independent of the `Extension` type change.            |

## Architecture

### Type Flow

```
Extension author writes:              Framework does:                  Consumer sees:
──────────────────────                 ──────────────                   ──────────────
{ db, whenReady, destroy }        →   defineExtension(raw)         →   extensions.sqlite
{ db }                            →   defineExtension(raw)         →   extensions.sqlite
{ whenReady }                     →   defineExtension(raw)         →   extensions.persistence
{}  (or void)                     →   defineExtension(raw ?? {})   →   extensions.lifecycle

Every stored entry is Extension<T>:
  { db, whenReady: Promise<void>, destroy: () => MaybePromise<void> }
  { whenReady: Promise<void>, destroy: () => MaybePromise<void> }
```

### Types

```typescript
// What's stored and what consumers/factories see: always has whenReady + destroy:
type Extension<T extends Record<string, unknown> = Record<string, never>> =
	T & {
		whenReady: Promise<void>;
		destroy: () => MaybePromise<void>;
	};
```

The factory return type is expressed inline on `withExtension`:

```typescript
withExtension<TKey, TExports>(
  key: TKey,
  factory: (context) => TExports & {
    whenReady?: Promise<unknown>;
    destroy?: () => MaybePromise<void>;
  },
): Builder<TExtensions & Record<TKey, Extension<Omit<TExports, 'whenReady' | 'destroy'>>>>
```

`TExports` captures everything the factory returns. `Omit<TExports, 'whenReady' | 'destroy'>` extracts just the custom exports for the `Extension<T>` generic parameter. The stored form is `Extension<CustomExports>`: flat object with required `whenReady` and `destroy`.

### `defineExtension()`: Internal Normalizer

```typescript
function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		whenReady?: Promise<unknown>;
		destroy?: () => MaybePromise<void>;
	},
): Extension<Omit<T, 'whenReady' | 'destroy'>> {
	return {
		...input,
		whenReady: input.whenReady?.then(() => {}) ?? Promise.resolve(),
		destroy: input.destroy ?? (() => {}),
	} as Extension<Omit<T, 'whenReady' | 'destroy'>>;
}
```

Called by the framework only. Extension authors never import it.

Optional: export for extension library authors who want the resolved type for testing. But not required. The framework handles normalization.

### Standardized Initialization Loop

Both workspace and document extensions use the same pattern:

```typescript
// Shared normalization (identical for workspace + document extension loops):
const raw = factory(context);
const resolved = defineExtension(raw ?? {});
extensionMap[key] = resolved;
destroys.push(resolved.destroy);
whenReadyPromises.push(resolved.whenReady);
```

Five lines. Same for both levels. The workspace chain does this inside `withExtension()`. The document loop does this inside `open()`. The logic is identical.

### Before/After Comparison

```
BEFORE (nested, two separate arrays):

  Workspace:                               Document:
  ┌─────────────────────────────┐          ┌──────────────────────────────┐
  │ result.lifecycle?.destroy   │          │ for (reg of extensions) {    │
  │   → extensionCleanups[]    │          │   lifecycles.push(lifecycle) │
  │ result.lifecycle?.whenReady │          │   docExports[key] = exports  │
  │   → whenReadyPromises[]    │          │ }                            │
  │ result.exports ?? {}        │          │ Promise.all(lifecycles.map(  │
  │   → extensions[key]        │          │   l => l.whenReady           │
  └─────────────────────────────┘          │ ))                           │
                                           └──────────────────────────────┘

AFTER (flat, same pattern):

  Both levels:
  ┌──────────────────────────────────────┐
  │ const resolved = defineExtension(raw)│
  │ extensionMap[key] = resolved         │
  │ destroys.push(resolved.destroy)      │
  │ whenReadyPromises.push(              │
  │   resolved.whenReady                 │
  │ )                                    │
  └──────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Type Definitions

- [x] **1.1** In `shared/lifecycle.ts`: Redefine `Extension<T>` as the flat resolved type:
  ```typescript
  type Extension<T extends Record<string, unknown> = Record<string, never>> =
	T & {
		whenReady: Promise<void>;
		destroy: () => MaybePromise<void>;
	};
  ```
- [x] **1.2** In `shared/lifecycle.ts`: Add `defineExtension()` normalizer function (internal utility).
- [x] **1.3** In `shared/lifecycle.ts`: Update `DocumentContext.extensions`: each entry is `Extension<T>` (optional due to tag filtering: `[K in keyof TDocExtensions]?: Extension<TDocExtensions[K]>`).
- [x] **1.4** In `static/types.ts`: Update `WorkspaceClient.extensions` mapped type: each entry is `Extension<TExtensions[K]>`.
- [x] **1.5** In `static/types.ts`: Update `withExtension` signature: factory returns flat object, `TExports` captures all properties, stored type is `Extension<Omit<TExports, 'whenReady' | 'destroy'>>`.
- [x] **1.6** In `static/types.ts`: Update `DocumentExtensionRegistration`: factory return type changes from `Extension<Record<string, unknown>> | void` to the flat input shape.
- [x] **1.7** In `static/types.ts`: Update `ExtensionFactory` type alias.
- [x] **1.8** In `dynamic/workspace/types.ts`: Same changes as 1.4-1.7 for the dynamic workspace system.

### Phase 2: Runtime: Workspace Extensions

- [x] **2.1** In `static/create-workspace.ts` `withExtension()`: Replace nested destructuring with `defineExtension()`. Store resolved extension (not just exports).
- [x] **2.2** In `static/create-workspace.ts` `buildClient()`: Update `destroy()` to iterate resolved extensions directly (or keep separate `destroys[]` array populated by the standardized loop).
- [x] **2.3** In `dynamic/workspace/create-workspace.ts`: Same changes as 2.1-2.2.

### Phase 3: Runtime: Document Extensions

- [x] **3.1** In `static/create-document-binding.ts` `open()` loop: Replace lifecycle-object collection with `defineExtension()` normalization. Store resolved extensions in `docExtensionsMap`.
- [x] **3.2** Update `DocEntry` type: replace `lifecycles: NormalizedLifecycle[]` and `exports: Record<string, Record<string, unknown>>` with a single `extensions: Record<string, Extension>` (the resolved map).
- [x] **3.3** Update `close()` and `closeAll()`: iterate `extensions` values for destroy, instead of `lifecycles` array.
- [x] **3.4** Update `makeHandle()`: pass through the resolved extensions map (handle.exports becomes the map of `Extension<T>` entries, which includes `whenReady`/`destroy` alongside custom exports).

### Phase 4: Update Extension Factories

All factories change from nested `{ exports, lifecycle }` to flat `{ ...customExports, whenReady?, destroy? }`.

- [x] **4.1** `extensions/sync/web.ts` (`indexeddbPersistence`): `{ clearData, whenReady, destroy }`.
- [x] **4.2** `extensions/sync/desktop.ts` (`persistence`): `{ whenReady }` (already nearly flat).
- [x] **4.3** `extensions/sqlite/sqlite.ts`: `{ pullToSqlite, pushFromSqlite, db, ...drizzleTables, whenReady?, destroy }`: fixes the pre-existing `destroy` bug.
- [x] **4.4** `extensions/revision-history/local.ts`: `{ save, list, view, restore, count, directory, destroy }`.
- [x] **4.5** `apps/epicenter/.../workspace-persistence.ts`: `{ whenReady, destroy }`.
- [x] **4.6** `extensions/sync/desktop.ts` (`filesystemPersistence`): Returns `Lifecycle`, not `Extension`. Unchanged: this is a provider factory, not an extension factory.

### Phase 5: Update Tests

- [x] **5.1** `static/create-workspace.test.ts`: Update all extension factories to flat shape. Update assertions to access `extensions.X.prop` directly (no `.exports.`).
- [x] **5.2** `static/create-document-binding.test.ts`: Same.
- [x] **5.3** `static/define-workspace.test.ts`: Same.
- [x] **5.4** `dynamic/workspace/create-workspace.test.ts`: Same.
- [x] **5.5** Add tests: verify `extensions.X.whenReady` is always a resolved `Promise<void>` for lifecycle-only extensions. Verify `extensions.X.destroy` is always a function.
- [x] **5.6** Add tests: verify surgical await works (extension B chains off `ctx.extensions.A.whenReady`, resolves after A but not before).

### Phase 6: JSDoc + Cleanup

- [x] **6.1** Update JSDoc in `lifecycle.ts`: module docstring, `Extension<T>`, `DocumentContext`.
- [x] **6.2** Update JSDoc in `static/types.ts`: `WorkspaceClientBuilder`, `ExtensionContext`, `ExtensionFactory`.
- [x] **6.3** Update JSDoc examples in extension files (`sync.ts`, `sqlite.ts`, `revision-history/index.ts`).
- [x] **6.4** Remove `NormalizedLifecycle` type from `create-document-binding.ts` (no longer needed).
- [x] **6.5** Grep for `result.lifecycle`: zero results in framework code (all replaced by flat access).
- [x] **6.6** Grep for `exports:` in extension return statements: zero results (all flattened).

### Phase 7: Verify

- [x] **7.1** `bun typecheck` from repo root: zero new type errors. (127 pre-existing errors in `@epicenter/filesystem`, unrelated.)
- [x] **7.2** `bun test` from `packages/epicenter`: all 690 tests pass, 0 failures.
- [ ] **7.3** Build the Epicenter app: verify it compiles. (Skipped: Tauri app requires native build toolchain.)
- [x] **7.4** Grep `result\.lifecycle` in framework code: zero results.
- [x] **7.5** Grep `NormalizedLifecycle`: zero results.

## Edge Cases

### Extension factory returns `void` or `undefined`

Some extensions may return nothing (e.g., a side-effect-only extension). The framework normalizes:

```typescript
const raw = factory(context);
const resolved = defineExtension(raw ?? {});
// resolved = { whenReady: Promise.resolve(), destroy: () => {} }
```

### Extension exports a property named `whenReady` or `destroy`

These are reserved. The framework's defaults overwrite them. TypeScript prevents this at the type level if the constraint is set up correctly (`TExports extends Record<string, unknown>` where `whenReady` and `destroy` are handled by the framework, not the generic).

If an extension genuinely needs an export called `whenReady` (extremely unlikely), it's a naming collision they need to resolve by renaming their export.

### `filesystemPersistence` returns `Lifecycle`, not `Extension`

The `filesystemPersistence` function in `extensions/sync/desktop.ts` returns a raw `Lifecycle` (required `whenReady` + `destroy`). This is used as a provider factory, not directly with `withExtension()`. The `persistence` wrapper wraps it into an `Extension`-compatible shape. No change needed: `Lifecycle` type is independent of `Extension`.

### Document extensions filtered by tags

When a document extension is skipped due to tag filtering, its entry is absent from `context.extensions`. The type is already optional (`[K in keyof TDocExtensions]?: Extension<TDocExtensions[K]>`). Factories should guard with optional chaining: `context.extensions.persistence?.whenReady`.

### Composite `client.whenReady` vs per-extension whenReady

Both coexist. `client.whenReady` is `Promise.all` of all extensions' `whenReady` promises: "wait for everything." `client.extensions.X.whenReady` is one specific extension: "wait for just this." They serve different use cases.

## Open Questions

1. **Should `defineExtension()` be exported for extension library authors?**
   - It's useful for testing and for libraries that want to construct `Extension<T>` values outside the framework.
   - Most extension authors won't need it: they return plain objects and the framework normalizes.
   - **Recommendation**: Export it but don't emphasize it. It's there if you need it.

2. **Should `destroy` be visible on `client.extensions.X`?**
   - Currently visible. Consumers could call it directly, bypassing the framework's reverse-order cleanup.
   - Hiding it requires stripping from the consumer-facing type (adds type complexity).
   - **Recommendation**: Keep it visible. Same trust model as `client.ydoc.destroy()`: visible but not meant to be called directly. Document this.

3. **Type inference: overloads vs conditional type on `withExtension`?**
   - Need to extract custom exports from the flat return (everything minus `whenReady` and `destroy`).
   - Conditional type: `TResult extends { ... } ? Omit<TResult, 'whenReady' | 'destroy'> : ...`
   - Overloads: Two signatures (with exports / lifecycle-only).
   - **Recommendation**: Try conditional type first. If IDE hover types are ugly, fall back to overloads.

## Success Criteria

- [x] `Extension<T>` is a flat type: `T & { whenReady: Promise<void>; destroy: () => MaybePromise<void> }`
- [x] `defineExtension()` exists as the single normalization point (internal, optionally exported)
- [x] All extension factories return flat objects (no `exports` key, no `lifecycle` key)
- [x] `client.extensions.X.whenReady` works for surgical await (no injection, no wrapper)
- [x] `client.extensions.X.customExport` works directly (no `.exports.` indirection)
- [x] Workspace and document extension loops use the same normalization pattern
- [x] sqlite's `destroy` is correctly captured (pre-existing bug fixed)
- [x] Composite `client.whenReady` still works
- [x] All tests pass, type check passes
- [x] Zero `result.lifecycle` references in framework code
- [x] Zero `NormalizedLifecycle` references in codebase

## Superseded Specs

This spec supersedes the following, which all addressed different facets of the same exports/lifecycle boundary problem:

- `specs/20260213T120800-separate-extension-lifecycle-from-exports.md`
- `specs/20260214T133054-remove-define-extension.md`
- `specs/20260220T200000-extension-handle-passthrough.md`
- `specs/20260220T200000-surgical-extension-await.md`
- `specs/20260220T195900-flatten-extension-exports.md`
- `specs/20260220T195900-unify-document-extension-shape.md`

## References

- `packages/epicenter/src/shared/lifecycle.ts`: `Extension<T>`, `Lifecycle`, `MaybePromise`, `DocumentContext`
- `packages/epicenter/src/static/create-workspace.ts`: `withExtension()`, `withDocumentExtension()`, `buildClient()`
- `packages/epicenter/src/static/create-document-binding.ts`: `open()` loop, `DocEntry`, `NormalizedLifecycle`, `makeHandle()`
- `packages/epicenter/src/static/types.ts`: `WorkspaceClientBuilder`, `ExtensionContext`, `ExtensionFactory`, `DocumentExtensionRegistration`
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic `withExtension()` implementation
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic `WorkspaceClientBuilder`, `ExtensionContext`
- `packages/epicenter/src/extensions/sqlite/sqlite.ts`: Pre-existing `destroy` bug (top-level, not in `lifecycle`)
- `packages/epicenter/src/extensions/sync/web.ts`: `indexeddbPersistence` factory
- `packages/epicenter/src/extensions/sync/desktop.ts`: `persistence` + `filesystemPersistence` factories
- `packages/epicenter/src/extensions/revision-history/local.ts`: `localRevisionHistory` factory
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: App-level persistence factory

## Implementation Review

### Summary

All 7 phases completed. The `Extension` type is now flat, all extension factories return `{ ...customExports, whenReady?, destroy? }`, and `defineExtension()` normalizes defaults in both workspace and document extension loops.

### Files Changed

**Type definitions (3 files):**

- `shared/lifecycle.ts`: Redefined `Extension<T>` as flat type, added `defineExtension()`, updated `DocumentContext.extensions`
- `static/types.ts`: Updated `withExtension` signature, `DocumentExtensionRegistration`, `ExtensionFactory`
- `dynamic/workspace/types.ts`: Same changes for dynamic workspace system

**Runtime (3 files):**

- `static/create-workspace.ts`: `withExtension()` uses `defineExtension()`, stores resolved extension
- `static/create-document-binding.ts`: Removed `NormalizedLifecycle`, `DocEntry.extensions` is `Record<string, Extension<any>>`, `open()` loop uses `defineExtension()`
- `dynamic/workspace/create-workspace.ts`: Same pattern with `defineExtension()`, added `as unknown as` cast for builder type

**Extension factories (7 files):**

- `extensions/sync/web.ts`: Flattened `indexeddbPersistence`
- `extensions/sync/desktop.ts`: Flattened `persistence` (left `filesystemPersistence` unchanged: returns `Lifecycle`)
- `extensions/sqlite/sqlite.ts`: Flattened, fixing pre-existing `destroy` bug
- `extensions/revision-history/local.ts`: Flattened
- `extensions/sync.ts`: Flattened `createSyncExtension` (discovered during Phase 6 grep)
- `extensions/markdown/markdown.ts`: Flattened `markdown` (discovered during Phase 6 grep)
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: Flattened, removed `Extension` return type annotation

**Re-exports (2 files):**

- `dynamic/index.ts`: Added `Extension` to lifecycle re-exports
- `dynamic/extension.ts`: Updated JSDoc

**Tests (5 files):**

- `static/create-workspace.test.ts`: Flattened all factory returns, added 3 new tests (whenReady default, destroy default, surgical await)
- `static/create-document-binding.test.ts`: Flattened all factory returns, updated lifecycle-only test to verify `whenReady`/`destroy` presence
- `static/define-workspace.test.ts`: Flattened all factory returns
- `dynamic/workspace/create-workspace.test.ts`: Flattened all factory returns
- `extensions/sync.test.ts`: Flattened type and all `result.exports.`/`result.lifecycle.` references

### Deviations from Spec

1. **Two additional extensions discovered**: `sync.ts` and `markdown/markdown.ts` were not listed in the Phase 4 checklist but still used the nested `{ exports, lifecycle }` shape. Both were flattened during Phase 6 grep verification.
2. **`Extension` re-export added**: `dynamic/index.ts` did not re-export `Extension` from `shared/lifecycle.ts`. Added to allow `workspace-persistence.ts` to import it (though the return type annotation was ultimately removed).
3. **`Extension<T>` default parameter `Record<string, never>`**: This is very strict: runtime storage maps needed `Extension<any>` to avoid variance issues. Documented as a discovery.
4. **Test assertion updated**: The "returns empty exports when extension has no exports" test was renamed and updated. Lifecycle-only extensions now produce `{ whenReady, destroy }` entries (correct new behavior).
5. **Phase 7.3 skipped**: Tauri app build requires native toolchain not available in this environment.

### Verification

- `bun typecheck`: Zero new type errors (127 pre-existing in `@epicenter/filesystem`, unrelated)
- `bun test`: 690 pass, 0 fail, 2 skip
- `grep result\.lifecycle` in framework code: Zero results
- `grep NormalizedLifecycle`: Zero results
- `grep 'exports:\s*\{'` in extension returns: Zero results
