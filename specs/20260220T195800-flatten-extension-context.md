# Flatten ExtensionContext and DocumentContext

**Date**: 2026-02-20
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove the `client` wrapper from both `ExtensionContext` and `DocumentContext`, flattening workspace resources (ydoc, tables, kv, etc.) to the top level alongside `whenReady` and `extensions`. Exclude `destroy` and `[Symbol.asyncDispose]`: factories return their own lifecycle, they don't control the workspace's. Standardize both context types to follow the same flat pattern.

## Motivation

### Current State

Both context types wrap scope-specific resources inside a `client` object:

```typescript
// Workspace ExtensionContext
type ExtensionContext = {
	client: {
		// ← wrapper
		id;
		ydoc;
		definitions;
		tables;
		kv;
		awareness;
		batch;
	};
	whenReady: Promise<void>;
	extensions: TExtensions;
};

// DocumentContext
type DocumentContext = {
	client: {
		// ← wrapper
		ydoc: Y.Doc;
		binding: { tableName; documentName; tags };
	};
	whenReady: Promise<void>;
	extensions: TDocExtensions;
};
```

Every single factory in the codebase destructures through `client` immediately. Nobody passes `ctx.client` as a unit:

```typescript
// sync.ts
const { ydoc, awareness } = ctx.client;

// sqlite.ts
{ client: { id, tables } }: ExtensionContext

// web.ts (persistence)
{ client: { ydoc } }: { client: { ydoc: Y.Doc } }

// markdown.ts
const { id, tables, ydoc } = context.client;

// workspace-persistence.ts
const { ydoc, id, kv } = ctx.client;

// revision-history
{ client: { ydoc, id } }: ExtensionContext
```

This creates problems:

1. **Pure friction at every callsite.** `{ client: { ydoc } }` instead of `{ ydoc }`. The nesting adds one destructuring layer to every extension factory for zero functional benefit.

2. **The `client` wrapper doesn't disambiguate `whenReady`.** That was the original justification, but `whenReady` is already at the top level of ExtensionContext: not inside `client`. The factory author knows they're inside a factory; "whenReady" self-evidently means "prior extensions ready."

3. **Extra types to maintain.** `WorkspaceExtensionClient` (static), `DynamicWorkspaceExtensionClient` (dynamic), and `DocumentExtensionClient` exist solely as the `client` wrapper type. Each needs its own generic parameters and JSDoc.

### Desired State

Both contexts are flat: scope-specific resources alongside chain state:

```typescript
// Workspace ExtensionContext: flat
type ExtensionContext = {
	id: TId;
	ydoc: Y.Doc;
	definitions: { tables; kv; awareness };
	tables: TablesHelper<TTables>;
	kv: KvHelper<TKv>;
	awareness: AwarenessHelper<TAwareness>;
	batch: (fn: () => void) => void;
	whenReady: Promise<void>; // prior extensions
	extensions: TExtensions; // prior extension exports
	// NO destroy, NO [Symbol.asyncDispose]
};

// DocumentContext: flat
type DocumentContext = {
	ydoc: Y.Doc;
	binding: { tableName; documentName; tags };
	whenReady: Promise<void>; // prior document extensions
	extensions: TDocExtensions; // prior document extension exports
	// NO destroy, NO [Symbol.asyncDispose]
};
```

Callsites simplify:

```typescript
// BEFORE                              // AFTER
{ client: { ydoc } }                   { ydoc }
{ client: { id, tables } }            { id, tables }
const { ydoc, awareness } = ctx.client → const { ydoc, awareness } = ctx
const { id, tables, ydoc } = ctx.client → const { id, tables, ydoc } = ctx
```

## Research Findings

### Property Usage Across All Extension Factories

Exhaustive search of every extension factory in the codebase:

| Factory                          | File                                          | Properties Accessed              |
| -------------------------------- | --------------------------------------------- | -------------------------------- |
| `indexeddbPersistence`           | `extensions/sync/web.ts`                      | `ydoc`                           |
| `createSyncExtension`            | `extensions/sync.ts`                          | `ydoc`, `awareness`, `whenReady` |
| `persistence` (desktop)          | `extensions/sync/desktop.ts`                  | `ydoc`                           |
| `sqlite`                         | `extensions/sqlite/sqlite.ts`                 | `id`, `tables`                   |
| `localRevisionHistory`           | `extensions/revision-history/local.ts`        | `ydoc`, `id`                     |
| `markdown`                       | `extensions/markdown/markdown.ts`             | `id`, `tables`, `ydoc`           |
| `workspacePersistence`           | `apps/epicenter/.../workspace-persistence.ts` | `ydoc`, `id`, `kv`               |
| `markdownPersistence`            | `apps/tab-manager-markdown/...`               | `ydoc`, `tables`                 |
| indexeddbPersistence (doc-level) | `apps/fs-explorer/...`                        | `ydoc` (same factory)            |

**Key finding**: No factory accesses `destroy`, `[Symbol.asyncDispose]`, or passes `ctx.client` as a unit. Every single one destructures immediately.

### Property Frequency

| Property                | Factories Using It | Include?                                                     |
| ----------------------- | ------------------ | ------------------------------------------------------------ |
| `ydoc`                  | 7/8                | ✅ Core resource                                             |
| `id`                    | 4/8                | ✅ Used for paths, identifiers                               |
| `tables`                | 3/8                | ✅ Used for schema introspection, data access                |
| `kv`                    | 1/8                | ✅ Used for settings persistence                             |
| `awareness`             | 1/8                | ✅ Used by sync (critical)                                   |
| `whenReady`             | 1/8                | ✅ Used by sync (critical: wait for persistence)            |
| `extensions`            | 0 (real)           | ✅ Needed for chain pattern (typed access to prior)          |
| `definitions`           | 0 (direct)         | ✅ Keep for schema introspection (sqlite gets it via tables) |
| `batch`                 | 0                  | ✅ Keep for atomic init operations                           |
| `destroy`               | 0                  | ❌ Factories return their own                                |
| `[Symbol.asyncDispose]` | 0                  | ❌ Consumer lifecycle only                                   |

### One-Factory-Two-Levels Compatibility

The `indexeddbPersistence` factory already works at both workspace and document level (fs-explorer uses it for both). With flattening, both contexts have `ydoc` at the top level, so structural typing continues to work:

```typescript
// Works for BOTH levels: same function signature
function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) { ... }

// Workspace: ExtensionContext has ydoc ✅
.withExtension('persistence', indexeddbPersistence)

// Document: DocumentContext has ydoc ✅
.withDocumentExtension('persistence', indexeddbPersistence, { tags: ['persistent'] })
```

## Design Decisions

| Decision                        | Choice                        | Rationale                                                   |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Remove `client` wrapper         | Flatten to top level          | 8/8 factories destructure through it; zero pass it as unit  |
| Keep `whenReady` name           | Don't rename                  | Factory context makes meaning obvious; renaming hurts DX    |
| Exclude `destroy`               | Not in context                | Factories return their own; shouldn't tear down workspace   |
| Exclude `[Symbol.asyncDispose]` | Not in context                | Consumer lifecycle, not factory concern                     |
| Include `batch`                 | In context                    | Low cost, useful for atomic init; already on static context |
| Include `definitions`           | In context                    | Schema introspection for SQLite-like extensions             |
| Delete `*ExtensionClient` types | Inline into context           | Types existed solely for the wrapper; no longer needed      |
| Standardize patterns            | Same flat pattern both levels | `{ ...resources, whenReady, extensions }`                   |
| Dynamic context gets `batch`    | Add to dynamic                | Static already has it; dynamic should match for consistency |

## Architecture

### Shared Pattern (Both Levels)

```
┌─────────────────────────────────────────────────────────────┐
│  { ...scope-specific resources, whenReady, extensions }      │
└─────────────────────────────────────────────────────────────┘
         │                                │
         ▼                                ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│  Workspace Extension      │    │  Document Extension       │
│  Context                  │    │  Context                  │
│                           │    │                           │
│  id, ydoc, definitions,   │    │  ydoc, binding,           │
│  tables, kv, awareness,   │    │  whenReady, extensions    │
│  batch, whenReady,        │    │                           │
│  extensions               │    │                           │
└──────────────────────────┘    └──────────────────────────┘
```

### Before → After (Type Definitions)

```
BEFORE (3 types per scope):                AFTER (1 type per scope):

WorkspaceExtensionClient<...>              ExtensionContext<...>
  { id, ydoc, definitions,                   { id, ydoc, definitions,
    tables, kv, awareness, batch }             tables, kv, awareness, batch,
         ↓ wrapped by                          whenReady, extensions }
ExtensionContext<...>
  { client: WorkspaceExtensionClient,
    whenReady, extensions }

DocumentExtensionClient                    DocumentContext<...>
  { ydoc, binding }                          { ydoc, binding,
         ↓ wrapped by                          whenReady, extensions }
DocumentContext<...>
  { client: DocumentExtensionClient,
    whenReady, extensions }
```

## Implementation Plan

### Phase 1: Flatten Type Definitions

- [x] **1.1** `packages/epicenter/src/static/types.ts`: Delete `WorkspaceExtensionClient` type, inline its properties directly into `ExtensionContext`. Update `ExtensionFactory` JSDoc examples.
- [x] **1.2** `packages/epicenter/src/dynamic/workspace/types.ts`: Delete `DynamicWorkspaceExtensionClient` type, inline into `ExtensionContext`. Add `batch` property to match static. Update `ExtensionFactory` JSDoc examples.
- [x] **1.3** `packages/epicenter/src/shared/lifecycle.ts`: Delete `DocumentExtensionClient` type, inline `ydoc` and `binding` directly into `DocumentContext`. Update JSDoc.

### Phase 2: Update Runtime (buildContext)

- [x] **2.1** `packages/epicenter/src/static/create-workspace.ts`: In `withExtension`, change `buildContext` from `{ client: { id, ydoc, ... }, whenReady, extensions }` to flat `{ id, ydoc, ..., whenReady, extensions }`.
- [x] **2.2** `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Same flattening of `buildContext`. Add `batch` property.
- [x] **2.3** `packages/epicenter/src/static/create-document-binding.ts`: In `open()`, change `buildContext` from `{ client: { ydoc, binding }, whenReady, extensions }` to flat `{ ydoc, binding, whenReady, extensions }`.

### Phase 3: Update Extension Factories (Consumers)

- [x] **3.1** `packages/epicenter/src/extensions/sync/web.ts`: `{ client: { ydoc } }` → `{ ydoc }`
- [x] **3.2** `packages/epicenter/src/extensions/sync.ts`: `const { ydoc, awareness } = ctx.client` → `const { ydoc, awareness } = ctx`; `ctx.whenReady` stays as-is
- [x] **3.3** `packages/epicenter/src/extensions/sync/desktop.ts`: `{ client: { ydoc } }` → `{ ydoc }`
- [x] **3.4** `packages/epicenter/src/extensions/sqlite/sqlite.ts`: `{ client: { id, tables } }` → `{ id, tables }`
- [x] **3.5** `packages/epicenter/src/extensions/revision-history/local.ts`: `{ client: { ydoc, id } }` → `{ ydoc, id }`
- [x] **3.6** `packages/epicenter/src/extensions/markdown/markdown.ts`: `const { id, tables, ydoc } = context.client` → `const { id, tables, ydoc } = context`
- [x] **3.7** `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: `const { ydoc, id, kv } = ctx.client` → `const { ydoc, id, kv } = ctx`
- [x] **3.8** `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`: `{ client: { ydoc, tables } }` → `{ ydoc, tables }`; also fix old `{ exports, lifecycle }` return shape to flat

### Phase 4: Update Re-exports and Cleanup

- [x] **4.1** `packages/epicenter/src/static/index.ts`: Remove `WorkspaceExtensionClient` from exports if exported
- [x] **4.2** `packages/epicenter/src/dynamic/index.ts`: Remove `DynamicWorkspaceExtensionClient` from exports if exported
- [x] **4.3** `packages/epicenter/src/dynamic/extension.ts`: Verify re-exports still work
- [x] **4.4** `packages/epicenter/src/shared/lifecycle.ts`: Remove `DocumentExtensionClient` export

### Phase 5: Update Tests

- [x] **5.1** `packages/epicenter/src/static/define-workspace.test.ts`: `({ client, extensions, whenReady })` → destructure flat
- [x] **5.2** `packages/epicenter/src/static/create-workspace.test.ts`: Update any `client:` references in extension factories
- [x] **5.3** `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`: Same
- [x] **5.4** `packages/epicenter/src/static/create-document-binding.test.ts`: `({ client })` → flat destructure
- [x] **5.5** Run full test suite: `bun test`

### Phase 6: Update JSDoc and Comments

- [x] **6.1** Search for all `ctx.client` references in JSDoc across the codebase and update examples
- [x] **6.2** Update `dynamic/workspace/README.md` extension context examples
- [x] **6.3** Update `shared/lifecycle.ts` module-level JSDoc (architecture diagram)

## Edge Cases

### Name Collision With Extension Exports

If a prior extension exports a property named `tables` or `kv`, it would collide with the workspace resource. In practice:

1. Extension exports live under `extensions.{key}`, not at the top level
2. TypeScript would catch any collision at compile time
3. No real extension uses names that clash with workspace resources

### Dynamic API Missing `batch` and `definitions`

The dynamic `ExtensionContext` currently lacks `batch` and `definitions` (static has them). Adding `batch` is straightforward. It's just `(fn) => ydoc.transact(fn)`. The dynamic API doesn't have a `definitions` property on its client; this can be deferred since no dynamic factory currently uses it.

### `filesystemPersistence` (desktop.ts line 100)

This function returns a provider factory typed as `(context: { ydoc: Y.Doc }) => Lifecycle`. It was designed for a different API path (pre-extension). With flattening, it structurally matches the new flat context since `ydoc` is at the top level. No change needed.

## Open Questions

1. **Should dynamic `ExtensionContext` get `definitions`?**
   - Static has `definitions: { tables, kv, awareness }` for schema introspection
   - Dynamic doesn't expose this today (tables have `.definitions` on the helper)
   - **Recommendation**: Defer. No dynamic factory uses it. Add when needed.

2. **Should dynamic `ExtensionContext` get `awareness`?**
   - Static has awareness. Dynamic doesn't (no awareness in dynamic API yet).
   - **Recommendation**: Skip. Add when dynamic API supports awareness.

## Success Criteria

- [x] All extension factories destructure flat: `{ ydoc }`, `{ id, tables }`, etc.
- [x] `WorkspaceExtensionClient`, `DynamicWorkspaceExtensionClient`, `DocumentExtensionClient` types deleted
- [x] `ExtensionContext` and `DocumentContext` follow identical pattern: `{ ...resources, whenReady, extensions }`
- [x] No `destroy` or `[Symbol.asyncDispose]` on either context type
- [x] `indexeddbPersistence` still works at both workspace and document level (structural typing)
- [x] `bun test` passes
- [x] `bun run typecheck` passes (both static and dynamic packages)

## References

**Type definitions:**

- `packages/epicenter/src/static/types.ts`: Static `WorkspaceExtensionClient`, `ExtensionContext`, `ExtensionFactory`
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic `DynamicWorkspaceExtensionClient`, `ExtensionContext`, `ExtensionFactory`
- `packages/epicenter/src/shared/lifecycle.ts`: `DocumentExtensionClient`, `DocumentContext`, `Extension`

**Runtime (buildContext):**

- `packages/epicenter/src/static/create-workspace.ts`: Static `buildContext` in `withExtension`
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic `buildContext` in `withExtension`
- `packages/epicenter/src/static/create-document-binding.ts`: Document `buildContext` in `open()`

**Extension factories:**

- `packages/epicenter/src/extensions/sync/web.ts`
- `packages/epicenter/src/extensions/sync.ts`
- `packages/epicenter/src/extensions/sync/desktop.ts`
- `packages/epicenter/src/extensions/sqlite/sqlite.ts`
- `packages/epicenter/src/extensions/revision-history/local.ts`
- `packages/epicenter/src/extensions/markdown/markdown.ts`
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`
- `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`

**Re-exports:**

- `packages/epicenter/src/static/index.ts`
- `packages/epicenter/src/dynamic/index.ts`
- `packages/epicenter/src/dynamic/extension.ts`

**Tests:**

- `packages/epicenter/src/static/define-workspace.test.ts`
- `packages/epicenter/src/static/create-workspace.test.ts`
- `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`
- `packages/epicenter/src/static/create-document-binding.test.ts`

## Review

### Summary

Flattened `ExtensionContext` and `DocumentContext` by removing the intermediate `client` wrapper object. Extension factories now destructure workspace resources directly from the context (`{ ydoc }` instead of `{ client: { ydoc } }`). All 6 phases completed successfully with 696 tests passing and 0 failures.

### Changes Made

**Types deleted (3):**

- `WorkspaceExtensionClient` from `static/types.ts`
- `DynamicWorkspaceExtensionClient` from `dynamic/workspace/types.ts`
- `DocumentExtensionClient` from `shared/lifecycle.ts`

**Files modified (20):**

- 3 type definition files (inlined properties into context types)
- 3 runtime files (flattened `buildContext` calls)
- 8 extension factory files (removed `client` destructuring)
- 2 re-export files (verified, updated JSDoc)
- 4 test files (updated mock contexts)

### Deviations from Plan

1. **`sync.test.ts` was not in the original spec**: discovered during test run that mock contexts in this file also used the `client` wrapper pattern. Fixed alongside the other test files.

2. **`create-workspace.test.ts` (static) needed no changes**: the test factories in this file already used the context parameter opaquely (no `client` destructuring), so they worked without modification.

3. **`apps/tab-manager-markdown` had two issues**: in addition to the `client` wrapper, this extension was still using the old `{ exports, lifecycle }` nested return shape from before the flat extension type refactor. Both were fixed.

### Open Questions Resolution

1. **Dynamic `definitions`**: Deferred as planned. No dynamic factory uses it.
2. **Dynamic `awareness`**: Skipped as planned. Dynamic API doesn't support awareness yet.

### Test Results

```
696 tests passed, 0 failed, 2 skipped
```
