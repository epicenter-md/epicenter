# Flatten Extension Exports

**Date:** 2026-02-20
**Status:** Superseded
**Scope:** `lifecycle.ts`, `create-workspace.ts` (static + dynamic), `create-document-binding.ts`, `types.ts` (static + dynamic), index files, tests, JSDoc
**Superseded by:** `specs/20260220T200000-flat-extension-type.md`: The flat extension type refactor (`5940a556c`) achieved the same goal (flat `client.extensions.foo.bar` access, no `.exports.` indirection) by flattening `Extension<T>` itself to `T & { whenReady, destroy }` rather than stripping a wrapper. `ResolvedExtension` was never introduced (the handle-passthrough spec it aimed to revert was also superseded).

## Overview

Remove the `{ exports, lifecycle }` wrapper from `client.extensions[key]`. Store extension exports directly so `client.extensions.foo.bar` works instead of `client.extensions.foo.exports.bar`. Remove per-extension `whenReady` from the consumer API: factories use `context.whenReady` (composite) for sequencing.

This reverts to the Spec 1 ("Separate Extension Lifecycle from Exports") ergonomics where `workspace.extensions[key]` is the flat exports object with no lifecycle pollution.

## Motivation

The handle passthrough spec overcorrected. It solved `Object.assign` mutation by wrapping in `{ exports, lifecycle }`, but every consumer now writes:

```typescript
// Current: verbose
workspace.extensions.revisions.exports.save('Before refactor');
await workspace.extensions.persistence.lifecycle.whenReady;

// Desired: flat
workspace.extensions.revisions.save('Before refactor');
```

Per-extension `whenReady` on the consumer side had exactly 1 usage in the entire codebase (tab-manager), and that was already migrated to `client.whenReady`. The surgical await pattern is mainly useful inside extension factories, which receive the full context anyway.

## Design

### What Changes

| Aspect                                      | Before                                               | After                             |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `client.extensions.X.method()`              | `client.extensions.X.exports.method()`               | `client.extensions.X.method()`    |
| Per-extension whenReady (consumer)          | `client.extensions.X.lifecycle.whenReady`            | Removed: use `client.whenReady`  |
| Per-extension whenReady (factory)           | `context.extensions.X.lifecycle.whenReady`           | Removed: use `context.whenReady` |
| `ResolvedExtension` type                    | Exists, exported                                     | Removed entirely                  |
| `WorkspaceClient.extensions` mapped type    | `ResolvedExtension<TExtensions[K]>`                  | `TExtensions[K]`                  |
| `DocumentContext.extensions` mapped type    | `ResolvedExtension<TDocExtensions[K]>`               | `TDocExtensions[K]`               |
| Runtime: what's stored in `extensions[key]` | `{ exports: {}, lifecycle: { whenReady, destroy } }` | `{}` (exports directly)           |

### What Stays the Same

- `Extension<T>` type (what factories return): `{ exports?, lifecycle? }`
- `Lifecycle` type: `{ whenReady, destroy }`
- Composite `client.whenReady` (wait-for-everything)
- Extension factory signatures: still return `Extension<T>`
- The chaining API: `.withExtension('key', factory)` identical
- Internal `extensionCleanups[]` and `whenReadyPromises[]` arrays
- `lifecycle.destroy` extraction: still pushed to `extensionCleanups` internally

## Implementation Plan

### Phase 1: Type definitions

- [ ] **1.1** Remove `ResolvedExtension` type from `shared/lifecycle.ts`
- [ ] **1.2** Update `DocumentContext.extensions` mapped type: `ResolvedExtension<T>` to just `T`
- [ ] **1.3** Update JSDoc examples in `DocumentContext`: remove `.exports.` / `.lifecycle.whenReady`
- [ ] **1.4** Update `WorkspaceClient.extensions` mapped type in `static/types.ts`: `ResolvedExtension<T>` to `T`
- [ ] **1.5** Update JSDoc on `extensions` property and `ExtensionContext` in `static/types.ts`
- [ ] **1.6** Remove `ResolvedExtension` re-export from `static/types.ts`
- [ ] **1.7** Remove `ResolvedExtension` export from `static/index.ts`
- [ ] **1.8** Update `WorkspaceClient.extensions` in `dynamic/workspace/types.ts`: same change
- [ ] **1.9** Remove `ResolvedExtension` re-export from `dynamic/workspace/types.ts`
- [ ] **1.10** Remove `ResolvedExtension` export from `dynamic/extension.ts` and `dynamic/index.ts`

### Phase 2: Runtime implementation

- [ ] **2.1** `static/create-workspace.ts`: `withExtension()`: store `result.exports ?? {}` directly instead of `{ exports, lifecycle }` handle
- [ ] **2.2** `static/create-workspace.ts`: Remove extensions cast to `ResolvedExtension`
- [ ] **2.3** `dynamic/workspace/create-workspace.ts`: same: store exports directly
- [ ] **2.4** `static/create-document-binding.ts`: store exports directly in `docExtensionsMap`, remove `ResolvedExtension` import

### Phase 3: Test updates

- [ ] **3.1** `static/create-workspace.test.ts`: `.extensions.X.exports.prop` to `.extensions.X.prop`, remove `.lifecycle.whenReady` tests
- [ ] **3.2** `static/create-document-binding.test.ts`: same pattern updates
- [ ] **3.3** `static/define-workspace.test.ts`: same pattern updates
- [ ] **3.4** `dynamic/workspace/create-workspace.test.ts`: same pattern updates

### Phase 4: JSDoc-only updates

- [ ] **4.1** `extensions/sync.ts`: JSDoc example
- [ ] **4.2** `extensions/revision-history/index.ts`: JSDoc examples
- [ ] **4.3** `extensions/revision-history/local.ts`: JSDoc examples
- [ ] **4.4** `extensions/sqlite/sqlite.ts`: JSDoc examples
- [ ] **4.5** `dynamic/workspace/create-workspace.ts`: JSDoc example

### Phase 5: Verification

- [ ] **5.1** `bun tsc --noEmit` from `packages/epicenter`: zero new type errors
- [ ] **5.2** `bun test` from `packages/epicenter`: all tests pass
- [ ] **5.3** Grep `ResolvedExtension`: zero results in source files
- [ ] **5.4** Grep `\.exports\.` on extensions: zero results (except Extension factory return, which still has `.exports`)

## Success Criteria

- [ ] `ResolvedExtension` type removed from codebase
- [ ] `client.extensions.foo.bar` works directly (no `.exports.` indirection)
- [ ] No per-extension `whenReady` on consumer API
- [ ] `client.whenReady` still works as composite
- [ ] All tests pass
- [ ] Type check passes
