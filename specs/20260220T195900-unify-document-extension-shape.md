# Unify Document Extension Return Shape

**Date**: 2026-02-20
**Status**: Draft
**Author**: AI-assisted

## Overview

Make document extensions return `{ exports?, lifecycle? }`: the same shape as workspace extensions. Move `clearData` from the lifecycle to exports. Reconsider whether `purge()` should exist as a framework method.

## Motivation

### Current State

Workspace extensions and document extensions return different shapes for the same conceptual pattern:

```typescript
// Workspace extension: returns Extension<T>
.withExtension('persistence', ({ ydoc }) => ({
  exports: { clearData: () => idb.clearData() },
  lifecycle: {
    whenReady: idb.whenSynced,
    destroy: () => idb.destroy(),
  },
}))

// Document extension: returns DocumentLifecycle
.withDocumentExtension('persistence', ({ ydoc }) => ({
  whenReady: idb.whenSynced,
  destroy: () => idb.destroy(),
  clearData: () => idb.clearData(),
}))
```

Both do the same thing: create an IndexedDB persistence provider for a Y.Doc. But the return shapes are different, so the same factory function can't be used for both. The fs-explorer demonstrates this awkwardness:

```typescript
// Line 7: imports the built-in helper for workspace-level
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
// Line 11: imports the raw class for document-level
import { IndexeddbPersistence } from 'y-indexeddb';
```

The workspace extension uses the clean helper. The document extension manually instantiates the class and wires the lifecycle because the helper returns the wrong shape.

This creates three problems:

1. The same factory can't serve both levels. Every document persistence pattern requires bespoke code.
2. `clearData` lives in different places at each level: exports (workspace) vs lifecycle (document). No good reason for the split.
3. Document extensions have no exports mechanism. A document extension can't expose capabilities to consumers the way workspace extensions do.

### Desired State

Both levels return `{ exports?, lifecycle? }`. The same factory works for both:

```typescript
createWorkspace({ id: 'fs-explorer', tables: { files: filesTable } })
	.withExtension('persistence', indexeddbPersistence)
	.withDocumentExtension('persistence', indexeddbPersistence, {
		tags: ['persistent'],
	});
```

One import. One factory. Two levels.

## Research Findings

### Where `clearData` Is Used

Searched the entire `packages/epicenter/src/` directory for `clearData`:

| Location                              | How it's used                                               |
| ------------------------------------- | ----------------------------------------------------------- |
| `create-document-binding.ts` line 328 | `purge()` iterates `lifecycles` and calls `l.clearData!()`  |
| `sync/web.ts` line 37                 | Workspace-level `indexeddbPersistence` puts it in `exports` |
| `lifecycle.ts` line 227               | Type definition on `DocumentLifecycle`                      |
| Test files                            | Test that purge calls clearData                             |

`clearData` is only called by the framework inside `purge()`. It is never called automatically on row deletion. The default `onRowDeleted` calls `destroy()`, which frees memory but preserves persisted data.

### Where `purge()` Is Called

| Location                                         | Context                      |
| ------------------------------------------------ | ---------------------------- |
| `create-document-binding.test.ts` (3 call sites) | Tests for clearData behavior |
| **No production code**                           | Zero calls outside tests     |

`purge()` is dead code in production today. No app calls it.

### Row Deletion Flow

When a row is deleted from the table:

1. The table observer in `createDocumentBinding` fires
2. It checks if the deleted row has an open content doc
3. It calls `onRowDeleted(binding, guid)` or the default: `binding.destroy(guid)`
4. `destroy()` frees the Y.Doc from memory but **keeps persisted data in IndexedDB**

This is the right default for CRDTs. A deleted row might come back from another peer during sync. Destroying persisted data eagerly would cause data loss on resync. The consumer should explicitly decide when deletion is permanent.

### Current Type Shapes

```
Workspace Extension (Extension<T>)        Document Extension (DocumentLifecycle)
─────────────────────────────────          ────────────────────────────────────
{                                          {
  exports?: T,                               whenReady?: Promise<unknown>,
  lifecycle?: {                              destroy: () => MaybePromise<void>,
    whenReady?: Promise<unknown>,            clearData?: () => MaybePromise<void>,
    destroy?: () => MaybePromise<void>,    }
  },
}
```

The document shape is flat; the workspace shape nests lifecycle. `clearData` exists only on the document shape, despite the workspace shape already carrying it in exports.

## Design Decisions

| Decision                        | Choice                                         | Rationale                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document extension return shape | `{ exports?, lifecycle? }` (same as workspace) | One shape. Same factory works for both levels. No reason for the divergence.                                                                                                                                                             |
| `clearData` location            | `exports` (not lifecycle)                      | It's a consumer-facing capability, not a framework lifecycle hook. The workspace level already puts it in exports.                                                                                                                       |
| `purge()` on DocumentBinding    | Remove                                         | Dead code in production. The consumer can call `clearData` from exports and then `destroy`. Simpler, more explicit, composable.                                                                                                          |
| Per-doc export accumulation     | Not needed for this change                     | Document extensions fire lazily at `open()` time. Accumulating their exports into the workspace builder doesn't make sense given the timing difference. Per-doc exports are accessible through the binding's existing open-doc tracking. |
| `DocumentLifecycle` type        | Remove, replace with `Extension<T>`            | Eliminates the redundant type. One type for both levels.                                                                                                                                                                                 |
| `DocumentContext.whenReady`     | Keep as-is                                     | Document extensions still chain via `whenReady` in the context. This doesn't change.                                                                                                                                                     |

## Architecture

### Before

```
withExtension factory → Extension<T>      withDocumentExtension factory → DocumentLifecycle
{ exports?, lifecycle? }                   { whenReady?, destroy, clearData? }
       │                                          │
       ▼                                          ▼
create-workspace.ts reads:                 create-document-binding.ts reads:
  result.lifecycle?.destroy                  result.destroy
  result.lifecycle?.whenReady                result.whenReady
  result.exports                             result.clearData  ← purge() uses this
```

### After

```
withExtension factory → Extension<T>      withDocumentExtension factory → Extension<T>
{ exports?, lifecycle? }                   { exports?, lifecycle? }
       │                                          │
       ▼                                          ▼
create-workspace.ts reads:                 create-document-binding.ts reads:
  result.lifecycle?.destroy                  result.lifecycle?.destroy
  result.lifecycle?.whenReady                result.lifecycle?.whenReady
  result.exports                             result.exports  ← consumer accesses clearData here
```

Same shape. Same unwrapping logic. The framework only touches `lifecycle`. The consumer accesses `exports`.

### How the Same Factory Works for Both

```typescript
// packages/epicenter/src/extensions/sync/web.ts
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		exports: { clearData: () => idb.clearData() },
		lifecycle: {
			whenReady: idb.whenSynced,
			destroy: () => idb.destroy(),
		},
	};
}

// Usage: same function, both levels:
createWorkspace(definition)
	.withExtension('persistence', indexeddbPersistence)
	.withDocumentExtension('persistence', indexeddbPersistence, {
		tags: ['persistent'],
	});
```

Both `ExtensionContext` and `DocumentContext` have `ydoc`. The factory destructures `{ ydoc }` and it works at both levels.

### Accessing Per-Doc Exports (clearData)

Without `purge()`, the consumer calls `clearData` explicitly. Two patterns:

**Pattern A: Through the binding's open doc tracking**

`createDocumentBinding` already tracks open docs in a `Map<string, DocEntry>`. Extend `DocEntry` to include accumulated exports:

```typescript
type DocEntry = {
	ydoc: Y.Doc;
	lifecycles: {
		whenReady?: Promise<unknown>;
		destroy: () => MaybePromise<void>;
	}[];
	exports: Record<string, Record<string, unknown>>; // keyed by extension name
	unobserve: () => void;
	whenReady: Promise<Y.Doc>;
};
```

Expose a method on the binding to access per-doc exports, or let the consumer clear data before calling destroy:

```typescript
// Consumer code for permanent deletion:
const clearData = binding.getExports(guid)?.persistence?.clearData;
await clearData?.();
await binding.destroy(guid);
```

**Pattern B: Close over the binding in onRowDeleted**

The existing `onRowDeleted` hook already receives the binding and guid:

```typescript
createDocumentBinding({
	...config,
	onRowDeleted: async (binding, guid) => {
		// Consumer decides: permanent delete or soft delete?
		const exports = binding.getExports(guid);
		await exports?.persistence?.clearData?.();
		await binding.destroy(guid);
	},
});
```

**Pattern C: Keep it even simpler: no getExports, just keep purge**

If Pattern A/B feels like overengineering, keep `purge()` but rewrite it to iterate `exports` instead of `lifecycles` for `clearData`. It's a convenience method, not framework magic. The only change is where it looks for `clearData`.

## Do You Actually Need `purge()`?

Three arguments against keeping it:

1. Zero production call sites. Nobody uses it today.
2. It conflates two operations (clear persisted data + destroy runtime resources) into one opaque method. The consumer can't do one without the other.
3. It implicitly scans all extensions for `clearData`. The consumer doesn't know which extensions provide it or what data gets cleared.

Three arguments for keeping it:

1. Convenience for the common case: "nuke everything about this document."
2. Without it, the consumer needs framework knowledge (which extensions have clearData) to do permanent deletion.
3. It's 10 lines of code. Not exactly tech debt.

My recommendation: remove it now while there are zero production callers, but provide Pattern A (expose per-doc exports via `binding.getExports(guid)`) so the consumer can compose their own purge logic when they need it. If the pattern proves too verbose in practice, add purge back as sugar later.

## Implementation Plan

### Phase 1: Update the Type System

- [x] **1.1** In `shared/lifecycle.ts`: remove the `DocumentLifecycle` type entirely. Document extensions will return `Extension<T>`, same as workspace extensions.
- [x] **1.2** In `shared/lifecycle.ts`: update `DocumentContext` to keep `{ ydoc, whenReady, binding }` unchanged. The context is fine; only the return type changes.
- [x] **1.3** In `static/types.ts`: update `DocumentExtensionRegistration`: the `factory` field changes from `(context: DocumentContext) => DocumentLifecycle | void` to `(context: DocumentContext) => Extension<Record<string, unknown>> | void`.
- [x] **1.4** In `static/types.ts`: update `WorkspaceClientBuilder.withDocumentExtension`: factory return type changes from `DocumentLifecycle | void` to `Extension<Record<string, unknown>> | void`.

### Phase 2: Update `create-document-binding.ts`

- [x] **2.1** Change the internal `DocEntry` type: replace `lifecycles: DocumentLifecycle[]` with separate `lifecycles` and `exports` arrays (or a combined structure). The binding needs to track both per-doc lifecycle hooks and per-doc exports.
- [x] **2.2** Update the `open()` method: when iterating document extension factories, unwrap `{ exports, lifecycle }` the same way `create-workspace.ts` does. Store lifecycle hooks and exports separately.
- [x] **2.3** Add `getExports(input: TRow | string): Record<string, Record<string, unknown>> | undefined` to `DocumentBinding`. Returns the accumulated per-doc exports for an open document, keyed by extension name. Returns undefined if the doc isn't open.
- [x] **2.4** Remove `purge()` from `DocumentBinding` (type and implementation). Update the `DocumentBinding` type in `static/types.ts`.
- [x] **2.5** Update `destroy()` to only call `lifecycle.destroy` (it already does this; just verify no clearData references remain).

### Phase 3: Update Call Sites

- [x] **3.1** Update `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: replace the inline document extension with `indexeddbPersistence`. Remove the `y-indexeddb` import.
- [x] **3.2** Update any other document extension call sites (grep for `withDocumentExtension` across all apps).
- [x] **3.3** Remove `DocumentLifecycle` from all export barrels (`static/index.ts`, `shared/lifecycle.ts` re-exports).

### Phase 4: Update Tests

- [x] **4.1** In `create-document-binding.test.ts`: update all document extension factories in tests to return `{ exports?, lifecycle? }` shape instead of the flat `DocumentLifecycle` shape.
- [x] **4.2** Remove the three `purge()` tests. Replace with tests for `getExports()`.
- [x] **4.3** In `create-workspace.test.ts`: update `withDocumentExtension` tests to use the new shape.
- [x] **4.4** Verify existing `onRowDeleted` tests still pass (they test `destroy`, not `purge`).

### Phase 5: Verify

- [x] **5.1** `bun tsc --noEmit` from packages/epicenter: zero new type errors (pre-existing errors in unrelated test files).
- [x] **5.2** `bun test` from packages/epicenter: 680 pass, 0 fail.
- [x] **5.3** Grep the entire repo for `DocumentLifecycle`, `clearData` in lifecycle position, and `purge(`: no stale references in source (only historical specs).
- [x] **5.4** Build the fs-explorer app to verify the indexeddbPersistence reuse works end-to-end.

## Edge Cases

### Document extension factory returns void

Currently allowed (`DocumentLifecycle | void`). The unified shape keeps this: `Extension<T> | void`. The `open()` method already handles void returns (skips them). No change needed.

### Document extension with exports but no lifecycle

New capability. A document extension could return `{ exports: { helpers } }` with no lifecycle. The binding stores the exports and uses noop lifecycle defaults. This is fine: workspace extensions already support this pattern.

### `indexeddbPersistence` receives `DocumentContext` instead of `ExtensionContext`

`indexeddbPersistence` only destructures `{ ydoc }`. Both `ExtensionContext` and `DocumentContext` have `ydoc`. So it works at both levels without changes. The extra fields on each context (`whenReady`, `binding`, `extensions`, etc.) are simply ignored by the factory.

### CRDT row resurrection after clearData

If a consumer clears persisted data for a document and the row later reappears from another peer via sync, the content doc will be empty (persisted state was deleted). The row metadata (title, updatedAt, etc.) will be restored by CRDT sync, but the content doc starts fresh. This is the expected behavior for permanent deletion. The consumer explicitly chose to destroy the data. Not a framework concern; it's a product decision.

### The `whenReady` chaining in document extensions

Document extensions receive `whenReady` in their context (composite of prior document extensions). This mechanism lives in `create-document-binding.ts`'s `open()` loop and doesn't depend on the return shape. The loop currently reads `l.whenReady` from the flat `DocumentLifecycle`; after this change it reads `result.lifecycle?.whenReady`. Same chain, different field path.

## Open Questions

1. **Should `getExports` be typed per extension key?**
   - Currently proposed as `Record<string, Record<string, unknown>>`: loose typing.
   - Could be tightened if document extensions accumulated type information like workspace extensions do. But that requires generic plumbing on `withDocumentExtension` return types.
   - Recommendation: start with loose typing. Tighten later if consumers need autocomplete on per-doc exports. The common case (clearData) is simple enough that loose typing works.

2. **Should we also expose `clearAll()` on the binding for bulk purge?**
   - The current `destroyAll()` destroys all open docs. A `clearAll()` would clear data for all open docs too.
   - Recommendation: defer. No production code needs it today. Add when a real use case appears.

3. **Should `indexeddbPersistence` remain the ONLY built-in that works at both levels, or should we create a separate `indexeddbDocumentPersistence` with a more explicit name?**
   - One function for both is the whole point of this change.
   - But the semantics are slightly different: workspace-level persists one shared Y.Doc; document-level persists per-row content docs.
   - Recommendation: one function. The Y.Doc guid differentiates the storage bucket already. The consumer picks the level by calling `.withExtension` vs `.withDocumentExtension`. The factory doesn't need to know.

## Success Criteria

- [x] `DocumentLifecycle` type is removed from the codebase
- [x] `purge()` is removed from `DocumentBinding`
- [x] Document extensions return `{ exports?, lifecycle? }` (the `Extension<T>` shape)
- [x] `indexeddbPersistence` works for both `.withExtension` and `.withDocumentExtension`
- [x] `fs-explorer` uses `indexeddbPersistence` at both levels (one import, no raw `y-indexeddb`)
- [x] `binding.getExports(guid)` exposes per-doc exports for consumer-driven cleanup
- [x] All tests pass, type check passes

## References

- `packages/epicenter/src/shared/lifecycle.ts`: `Extension<T>`, `DocumentLifecycle` (to be removed), `DocumentContext`
- `packages/epicenter/src/static/types.ts`: `DocumentExtensionRegistration`, `WorkspaceClientBuilder.withDocumentExtension`, `DocumentBinding`
- `packages/epicenter/src/static/create-workspace.ts`: `withDocumentExtension` implementation
- `packages/epicenter/src/static/create-document-binding.ts`: `open()`, `purge()`, `DocEntry`
- `packages/epicenter/src/extensions/sync/web.ts`: `indexeddbPersistence` (the factory that will work at both levels)
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: primary consumer, the motivating example

## Review

Implemented all 5 phases. The core change: document extensions now return the same `{ exports?, lifecycle? }` shape as workspace extensions, eliminating `DocumentLifecycle` as a separate type.

Key implementation details:

- Introduced `NormalizedLifecycle` as an internal type in `create-document-binding.ts` since all lifecycle properties are optional (destroy uses `?.()`)
- `DocEntry` now tracks `exports: Record<string, Record<string, unknown>>` alongside lifecycle arrays
- `open()` unwraps `result.lifecycle ?? {}` and `result.exports` separately, accumulating exports keyed by extension name
- `getExports()` returns the accumulated exports for a given doc guid, or `undefined` if not open
- fs-explorer replaced its inline `IndexeddbPersistence` document extension with the shared `indexeddbPersistence` factory: one import, used at both workspace and document levels

Files changed: `lifecycle.ts` (removed type), `types.ts` (updated signatures), `create-document-binding.ts` (core logic), `create-workspace.ts` (factory type), `index.ts` (removed export), `fs-state.svelte.ts` (consumer), plus both test files.
