# Extension Handle Passthrough

**Date:** 2026-02-20
**Status:** Superseded
**Author:** AI-assisted
**Scope:** `Extension`, `ExtensionHandle`, `create-workspace.ts`, `create-document-binding.ts`, `types.ts`, `lifecycle.ts`
**Superseded by:** `specs/20260220T200000-flat-extension-type.md`: The `{ exports, lifecycle }` wrapper was subsequently flattened back into `Extension<T> = T & { whenReady, destroy }`. The flat type achieved the same goals (no `Object.assign` mutation, no collision risk) with better ergonomics (`client.extensions.X.method()` instead of `client.extensions.X.exports.method()`).

## Overview

Replace Option B (flat inject `whenReady` into exports via `Object.assign`) with a `{ exports, lifecycle }` wrapper that mirrors the factory return shape. Each extension entry in `client.extensions[key]` becomes an `ExtensionHandle<T>` with `.exports` and `.lifecycle` sub-properties.

## Motivation

### Current State

Extension factories return `{ exports?, lifecycle? }`: the `Extension<T>` type. But the consumer never sees this shape. Instead, `withExtension()` destructures the result, extracts lifecycle hooks into shared mutable arrays, mutates the exports object to inject `whenReady`, and stores only the mutated exports:

```typescript
// create-workspace.ts: withExtension() lines 243-260
const result = factory(client);
const destroy = result.lifecycle?.destroy;
if (destroy) extensionCleanups.push(destroy);

const extWhenReady: Promise<void> = result.lifecycle?.whenReady
	? result.lifecycle.whenReady.then(() => {})
	: Promise.resolve();
whenReadyPromises.push(extWhenReady);

// Mutate exports to inject whenReady (Option B: flat inject)
const exports = result.exports ?? {};
Object.assign(exports, { whenReady: extWhenReady });

const newExtensions = {
	...extensions,
	[key]: exports, // Only exports stored: lifecycle discarded
} as TExtensions & Record<TKey, TExports>;
```

This same pattern repeats in three files with increasing complexity:

| File                                    | Lines   | Complexity                                        |
| --------------------------------------- | ------- | ------------------------------------------------- |
| `static/create-workspace.ts`            | 243-260 | Full ceremony + `Object.assign` hack              |
| `dynamic/workspace/create-workspace.ts` | 129-141 | Simpler (no `whenReady` injection)                |
| `static/create-document-binding.ts`     | 262-301 | Most complex: branching on exports vs no-exports |

This creates problems:

1. **`Object.assign` mutation**: Exports are mutated at runtime to inject `whenReady`. This violates reference integrity: the object the factory returned is silently modified after the fact.
2. **`& { whenReady }` intersection types**: The mapped type `TExtensions[K] & { whenReady: Promise<void> }` adds complexity in type definitions and forces every consumer to know about the injection.
3. **Lifecycle/exports collision risk**: If an extension ever exports a property named `whenReady`, it would be silently overwritten by the framework injection.
4. **Three-file duplication**: The destructure-extract-inject ceremony is repeated in static workspace, dynamic workspace, and document bindings.
5. **Shape mismatch**: Factories return `{ exports, lifecycle }`, consumers see flat exports. The 1:1 mapping is broken.

### Desired State

The factory returns `{ exports?, lifecycle? }`. The consumer sees `{ exports, lifecycle }`. 1:1 mapping, no magic injection, no collision risk, self-documenting:

```typescript
// BEFORE (Option B: flat inject):
client.extensions.persistence.clearData();
await client.extensions.persistence.whenReady;

// AFTER ({ exports, lifecycle } wrapper):
client.extensions.persistence.exports.clearData();
await client.extensions.persistence.lifecycle.whenReady;
```

## Relationship to Document Handle API Spec

This spec builds on the already-implemented [Document Handle API](./20260220T195900-document-handle-api.md) (Status: Implemented).

**How they relate**: Document Handle changed the binding surface: `open()` returns `DocumentHandle`, `destroy→close`. This spec changes what's _inside_ the extension results that get wired up when a document is opened. They touch the same file (`create-document-binding.ts`) but different concerns:

```
Document Handle API (implemented)     ExtensionHandle Passthrough (this spec)
─────────────────────────────         ──────────────────────────────────────
binding.open() → DocumentHandle       docExtensionsMap wrapping
binding.close() / closeAll()          Object.assign removal in extension loop
handle.read() / handle.write()        { exports, lifecycle } handle shape
handle.exports (flat)                 DocumentContext.extensions (ExtensionHandle)
```

**The one shared file** is `create-document-binding.ts`:

- Document Handle already changed how `open()` returns a `DocumentHandle` with `ydoc`, `read()`, `write()`, `exports`.
- This spec changes lines 257-270 inside the extension loop: how `docExtensionsMap` entries are built. It replaces the `Object.assign` flat inject + branching with a clean `{ exports, lifecycle }` handle.
- `DocumentHandle.exports` (what consumers get after `open()`) stays **flat** `Record<string, Record<string, unknown>>`. It is NOT wrapped in `ExtensionHandle`. Only `DocumentContext.extensions` (what factories receive for prior doc extensions) uses `ExtensionHandle`.

| Layer                         | What it stores                                 | Changed by which spec             |
| ----------------------------- | ---------------------------------------------- | --------------------------------- |
| `DocumentHandle.exports`      | Flat per-doc extension exports                 | Document Handle API (implemented) |
| `DocumentContext.extensions`  | Prior doc extensions for factory context       | **This spec**                     |
| `WorkspaceClient.extensions`  | Workspace-level extension results              | **This spec**                     |
| `ExtensionContext.extensions` | Prior workspace extensions for factory context | **This spec**                     |

**No conflicts.** The Document Handle spec's changes are stable ground that this spec builds on.

## Design

### New Type: `ExtensionHandle<T>`

Added to `packages/epicenter/src/shared/lifecycle.ts`:

```typescript
/**
 * What consumers see per extension in `client.extensions[key]`.
 *
 * Mirrors the factory return shape (`Extension<T>`) with normalized defaults:
 * - `exports` is always present (defaults to `{}` for lifecycle-only extensions)
 * - `lifecycle.whenReady` is always `Promise<void>` (resolved if factory didn't provide one)
 *
 * Note: `lifecycle.destroy` is intentionally omitted: destruction is managed
 * by the workspace, not by consumers. Consumers should never call destroy on
 * individual extensions.
 *
 * @typeParam T - The extension's exports type
 */
export type ExtensionHandle<
	T extends Record<string, unknown> = Record<string, unknown>,
> = {
	exports: T;
	lifecycle: { whenReady: Promise<void> };
};
```

### What Changes

| Aspect                                            | Before                                          | After                                           |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `client.extensions.X.method()`                    | Flat: exports merged with injected `whenReady` | `client.extensions.X.exports.method()`          |
| `client.extensions.X.whenReady`                   | Injected via `Object.assign`                    | `client.extensions.X.lifecycle.whenReady`       |
| `context.extensions.X.clearData()` (in factories) | Flat access                                     | `context.extensions.X.exports.clearData()`      |
| `context.extensions.X?.whenReady` (doc context)   | Flat access                                     | `context.extensions.X?.lifecycle.whenReady`     |
| `Object.assign(exports, { whenReady })`           | Required in 2 files                             | Removed entirely                                |
| `TExtensions[K] & { whenReady }` intersection     | In `types.ts` and `create-workspace.ts`         | Replaced with `ExtensionHandle<TExtensions[K]>` |

### What Stays the Same

- `Extension<T>` type (what factories return): `{ exports?, lifecycle? }`
- `Lifecycle` type: `{ whenReady, destroy }`
- Composite `client.whenReady` (wait-for-everything)
- `ExtensionContext = WorkspaceClient` alias
- Extension factory signatures: they still return `Extension<T>`
- The chaining API: `.withExtension('key', factory)` is identical
- Internal `extensionCleanups[]` and `whenReadyPromises[]` arrays: still shared, still accumulate
- `lifecycle.destroy` extraction: still pushed to `extensionCleanups` internally

## Implementation Plan

### Phase 1: Type definitions

- [x] **1.1** Add `ExtensionHandle<T>` to `packages/epicenter/src/shared/lifecycle.ts`
- [x] **1.2** Update `DocumentContext.extensions` mapped type in `lifecycle.ts` to use `ExtensionHandle`
- [x] **1.3** Update JSDoc examples in `DocumentContext` to use `.exports.` / `.lifecycle.whenReady`
- [x] **1.4** Import and update `WorkspaceClient.extensions` mapped type in `static/types.ts`
- [x] **1.5** Update JSDoc examples on `extensions` property and `ExtensionContext` in `types.ts`
- [x] **1.6** Re-export `ExtensionHandle` from `static/types.ts` (line 946)
- [x] **1.7** Export `ExtensionHandle` from `static/index.ts` (lifecycle exports block)
- [x] **1.8** Update `dynamic/workspace/types.ts`: change `extensions: TExtensions` to mapped `ExtensionHandle` type
- [x] **1.9** Re-export `ExtensionHandle` from `dynamic/workspace/types.ts`
- [x] **1.10** Export `ExtensionHandle` from `dynamic/index.ts` and `dynamic/extension.ts`

### Phase 2: Runtime implementation

- [x] **2.1** `static/create-workspace.ts`: Replace `Object.assign` flat inject with `{ exports, lifecycle }` handle wrapping in `withExtension()`
- [x] **2.2** `static/create-workspace.ts`: Update the extensions cast in `buildClient()`
- [x] **2.3** `dynamic/workspace/create-workspace.ts`: Wrap in `{ exports, lifecycle }` handle in `withExtension()`
- [x] **2.4** `static/create-document-binding.ts`: Replace flat inject + branching with handle wrapping in document extension loop

### Phase 3: Test updates

- [x] **3.1** `static/create-workspace.test.ts`: Update all `.extensions.X.prop` → `.extensions.X.exports.prop` and `.whenReady` → `.lifecycle.whenReady`
- [x] **3.2** `static/create-document-binding.test.ts`: Update extension access patterns
- [x] **3.3** `static/define-workspace.test.ts`: Update all consumer extension access
- [x] **3.4** `dynamic/workspace/create-workspace.test.ts`: Update all extension access

### Phase 4: JSDoc-only updates

- [x] **4.1** `extensions/sync.ts`: line 136 JSDoc example
- [x] **4.2** `extensions/revision-history/index.ts`: lines 19, 22, 25, 28
- [x] **4.3** `extensions/revision-history/local.ts`: lines 83, 86, 89, 93, 107, 111, 117
- [x] **4.4** `extensions/sqlite/sqlite.ts`: lines 77, 79
- [x] **4.5** `shared/actions.ts`: no JSDoc references to extension access found (skipped)
- [x] **4.6** `dynamic/workspace/create-workspace.ts`: line 24 JSDoc example

### Phase 5: Verification

- [x] **5.1** `bun tsc --noEmit` from `packages/epicenter`: zero NEW type errors (pre-existing errors in benchmark.test.ts unchanged)
- [x] **5.2** `bun test` from `packages/epicenter`: all 687 tests pass
- [x] **5.3** Grep `Object.assign.*whenReady`: zero results
- [x] **5.4** Grep `TExtensions[K] & { whenReady`: zero results (old mapped type removed)
- [x] **5.5** Grep `Option B`: zero results in source files

## Edge Cases

### Extension that exports a `whenReady` property

Before: silently overwritten by `Object.assign`. After: no collision: `whenReady` lives on `.lifecycle`, user's export lives on `.exports`. This is a correctness improvement.

### Extension with no exports (lifecycle-only)

Before: `Object.assign({}, { whenReady })` creates `{ whenReady }`. After: `{ exports: {}, lifecycle: { whenReady } }`. Clean. The empty `exports` object is explicit rather than being a container for the injected `whenReady`.

### Extension with no lifecycle

Before: `Object.assign(exports, { whenReady: Promise.resolve() })`. After: `{ exports, lifecycle: { whenReady: Promise.resolve() } }`. Same behavior, explicit shape.

## Simplification Summary

| Metric                                             | Before                                        | After     |
| -------------------------------------------------- | --------------------------------------------- | --------- |
| Lines in `withExtension()` (static)                | ~20                                           | ~8        |
| `Object.assign` hacks                              | 2 files                                       | 0         |
| `& { whenReady }` intersections                    | 2 types                                       | 0         |
| Document binding branching (exports vs no-exports) | 14 lines                                      | 4 lines   |
| `NormalizedLifecycle` references                   | Unchanged (still needed for destroy tracking) | Unchanged |

## Success Criteria

- [ ] `ExtensionHandle<T>` type exists and is exported from static and dynamic entry points
- [ ] All `Object.assign(exports, { whenReady })` calls removed
- [ ] All `TExtensions[K] & { whenReady }` mapped types replaced with `ExtensionHandle<TExtensions[K]>`
- [ ] All consumer access uses `.exports.` and `.lifecycle.whenReady`
- [ ] All tests pass
- [ ] Type check passes with zero errors
- [ ] No `Option B` references in source files

## References

- `packages/epicenter/src/shared/lifecycle.ts`: New type definition
- `packages/epicenter/src/static/types.ts`: Mapped type update
- `packages/epicenter/src/static/create-workspace.ts`: Runtime implementation
- `packages/epicenter/src/static/create-document-binding.ts`: Document extension handling
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic workspace types
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic runtime
- `specs/20260220T195900-document-handle-api.md`: Compatible companion spec
