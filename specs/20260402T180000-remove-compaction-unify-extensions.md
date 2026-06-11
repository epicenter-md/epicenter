# Remove Compaction and Unify Extension Registration

**Date**: 2026-04-02
**Status**: Implemented
**Author**: AI-assisted
**Supersedes**: `20260402T153000-workspace-anchor-and-reset-history.md` (kept for reference. Contains anchor model design if compaction is ever needed)

## Overview

Delete the entire epoch-based compaction system from `create-workspace.ts` and unify the three extension registration methods into one. This is a deletion-heavy change that removes ~300 lines and simplifies the mental model from "two Y.Docs with epoch-based compaction" to "one Y.Doc."

## Motivation

### The numbers don't justify compaction

We benchmarked Yjs doc sizes under realistic workload conditions:

| Scenario | Clean size | After churn | Bloat | Wasted |
|---|---|---|---|---|
| Whispering (500 recordings, 3 edits each) | 509 KB | 529 KB | 1.04x | 20 KB |
| Tab Manager (200 tabs, 10 delete/replace cycles) | 12 KB | 24 KB | 2.0x | 12 KB |
| Heavy notes app (200 notes, 50 edits each) | 62 KB | 265 KB | 4.3x | 203 KB |
| Extreme (1000 rows, 100 edits each) | 70 KB | 1 MB | 14.9x | ~1 MB |

The extreme case (1 MB) loads in 20-50ms from IndexedDB and syncs in <2s on 4G. The realistic cases waste 12-200 KB. None of these justify the complexity cost:

- ~200 lines of the most intricate code in the file
- 10 mutable `let` variables that only exist for the swap
- A coordination Y.Doc that only exists for epoch tracking
- 2 test files (450 lines) testing swap behavior
- Conceptual overhead for every developer reading the code

### The compaction infrastructure has a deeper bug

The coordination doc (`coordYdoc`) isn't persisted or synced. No extension sees it. After a page reload, the epoch resets to 0. The blue-green swap masks this by making compaction take effect in-process, but the epoch is lost on reload without sync. Fixing this properly (the anchor model in the superseded spec) would add significant new complexity.

### Three extension methods cause confusion

`withExtension()`, `withWorkspaceExtension()`, and `withDocumentExtension()` have overlapping responsibilities. The unified API is valuable independently of compaction.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove compaction | Delete entirely | Numbers don't justify complexity. Can be added later with the anchor model (see superseded spec) if a use case demands it. |
| Remove coordination doc | Delete, move awareness to data doc | Coordination doc only existed for epoch tracking. Without epochs, it's dead weight. |
| Data doc GUID | Changed to just `{id}` (clean break) | No data at rest to preserve. The `-0` suffix was epoch baggage. |
| Keep `encodedSize()` | Useful for monitoring, costs nothing | Users can track doc growth without compaction. |
| Extension methods | Keep three methods (`withExtension`, `withWorkspaceExtension`, `withDocumentExtension`) | The unified single-method API was implemented then reverted. Three methods are clearer at call sites, more discoverable via autocomplete, and easier for TypeScript to resolve. See Review section. |

## What to delete

### Functions to remove

| Function | Lines | Purpose (no longer needed) |
|---|---|---|
| `prepareFreshDoc()` | ~329-385 | Creates fresh epoch doc for swap |
| `createFreshExtensions()` | ~392-436 | Re-fires extensions on fresh doc |
| `doBlueGreenSwap()` | ~452-516 | PREPARE/COMMIT/CLEANUP orchestrator |
| `requestSwap()` | ~533-537 | Remote epoch swap request |
| `drainSwapQueue()` | ~539-556 | Latest-wins swap serialization |
| `compact()` | ~688-715 | Public API for compaction |

### Variables to remove

| Variable | Purpose (no longer needed) |
|---|---|
| `let ydoc` → `const ydoc` | Was mutable for swap |
| `let currentDataEpoch` | Tracked current epoch |
| `let kvStore` → `const kvStore` | Was mutable for swap |
| `let kvHelper` → `const kvHelper` | Was mutable for swap |
| `let swapState` | Late-bound builder state for swap |
| `let swapExtensions` | Late-bound extensions for swap |
| `let pendingEpoch` | Latest-wins swap queue |
| `let isSwapping` | Serialization guard |
| `dataDocExtensionFactories[]` | Stored factories for re-fire |

### Types to remove

| Type | Location |
|---|---|
| `StoredExtensionFactory` | `create-workspace.ts` |

### Files to remove/rename

| File | Action |
|---|---|
| `epoch.ts` | Delete |
| `epoch.test.ts` | Delete |
| `compact.test.ts` | Delete |
| `compact.multi-client.test.ts` | Delete |

### Lines to remove in `buildClient`

```typescript
// Remove these two lines (~590-591):
swapState = state;
swapExtensions = extensions;

// Remove null-clearing in dispose (~596-597):
swapState = null;
swapExtensions = null;
```

### Line to remove in `withExtension`

```typescript
// Remove this line (~865):
dataDocExtensionFactories.push({ key, factory });
```

### Mutations to remove

```typescript
// Remove this pattern (used during swap):
encryptedStores.length = 0;
encryptedStores.push(...fresh.encryptedStores);
```

## What to keep

- `encodedSize()`: useful for monitoring doc growth
- `onEpochChange()`: remove (no epochs to change)
- `epoch` getter: remove
- `encryptedStores` array: keep (encryption needs it), just never mutated after construction
- `epochChangeCallbacks`: remove
- The epoch observer (`unsubEpochObserver`): remove
- `createEpochTracker` import: remove

## What to change

### Move awareness to data doc

```typescript
// Before:
const coordYdoc = new Y.Doc({ guid: id });
const awareness = createAwareness(coordYdoc, awarenessDefs);

// After:
const ydoc = new Y.Doc({ guid: `${id}-0` });
const awareness = createAwareness(ydoc, awarenessDefs);
```

The `-0` suffix is kept for backward compatibility with existing persisted data. The coordination doc is deleted entirely.

### Make mutable variables const

```typescript
// Before:
let ydoc = new Y.Doc({ guid: `${id}-${initialEpoch}` });
let kvStore = createEncryptedYkvLww(kvYarray, { key: options?.key });
let kvHelper = createKv(kvStore, kvDefs);

// After:
const ydoc = new Y.Doc({ guid: `${id}-0` });
const kvStore = createEncryptedYkvLww(kvYarray, { key: options?.key });
const kvHelper = createKv(kvStore, kvDefs);
```

### Simplify dispose

```typescript
// Before:
const dispose = async () => {
    unsubEpochObserver();
    swapState = null;
    swapExtensions = null;
    // ... document cleanups, extension cleanups ...
    awareness.raw.destroy();
    coordYdoc.destroy();
    ydoc.destroy();
};

// After:
const dispose = async () => {
    // ... document cleanups, extension cleanups ...
    awareness.raw.destroy();
    ydoc.destroy();
};
```

### Simplify client object

Remove `compact()`, `epoch` getter, `onEpochChange()` from the client object. Keep `encodedSize()`.

### Simplify kv getter

```typescript
// Before (getter because kvHelper was mutable):
get kv() { return kvHelper; },

// After (direct reference):
kv: kvHelper,
```

Same for `ydoc`:
```typescript
// Before:
get ydoc() { return ydoc; },

// After:
ydoc,
```

## Unified withExtension API

### Two forms

```typescript
// Form 1: Single function: fires on all scopes (90% case)
.withExtension('persistence', indexeddbPersistence)

// Form 2: Object: per-scope control
.withExtension('persistence', {
  workspace: ({ ydoc, tables, kv, ... }) => sqlitePersistence({ ydoc }),
  document: ({ ydoc, timeline, ... }) => sqliteDocPersistence({ ydoc }),
  // anchor key reserved for future use (compaction anchor model)
})
```

Note: `anchor` key is reserved but not functional in this version. If the anchor model is ever implemented, it activates without API changes.

### Context per scope

| Scope | Context | Replaces |
|---|---|---|
| `workspace` | Full `ExtensionContext` (id, ydoc, tables, kv, awareness, extensions) | `withWorkspaceExtension` |
| `document` | `DocumentContext` (id, ydoc, timeline, extensions) | `withDocumentExtension` |
| Function form | `SharedExtensionContext` ({ ydoc, whenReady }) | `withExtension` (current) |

### Removes

- `withWorkspaceExtension()`: use `{ workspace: fn }` instead
- `withDocumentExtension()`: use `{ document: fn }` instead

## Implementation Plan

### Phase 1: Unify extension registration

Standalone refactoring. No behavioral change. Do first because it's independently valuable and simplifies subsequent phases.

- [x] ~~**1.1-1.5** Unify extension methods~~: **Reverted.** Implemented the unified object form, evaluated it, and decided three methods are the better API. See Review.
- [x] **1.6** Run tests: `bun test packages/workspace`: 246 pass
- [x] **1.7** Run typecheck: `bun run typecheck`: clean (pre-existing `NumberKeysOf` error in `@epicenter/ai` only)

### Phase 2: Delete compaction machinery

The big deletion. Work through this methodically. Each step should leave the code compilable.

- [x] **2.1** Delete `epoch.ts` and `epoch.test.ts`
- [x] **2.2** Delete `compact.test.ts` and `compact.multi-client.test.ts`
- [x] **2.3** In `create-workspace.ts`: remove `createEpochTracker` import and `coordYdoc` creation
- [x] **2.4** Move awareness from `coordYdoc` to `ydoc`: `createAwareness(ydoc, awarenessDefs)`
- [x] **2.5** Delete `prepareFreshDoc()`, `createFreshExtensions()`, `doBlueGreenSwap()`
- [x] **2.6** Delete `requestSwap()`, `drainSwapQueue()`, epoch observer setup
- [x] **2.7** Delete `StoredExtensionFactory` type and `dataDocExtensionFactories` array
- [x] **2.8** Remove `dataDocExtensionFactories.push(...)` from `withExtension`
- [x] **2.9** Delete `swapState`, `swapExtensions`, `pendingEpoch`, `isSwapping` and all references
- [x] **2.10** Remove `swapState = state; swapExtensions = extensions;` from `buildClient`
- [x] **2.11** Remove `swapState = null; swapExtensions = null;` and `unsubEpochObserver()` from `dispose`
- [x] **2.12** Remove `coordYdoc.destroy()` from `dispose`
- [x] **2.13** Make `ydoc` `const`, change `get ydoc() { return ydoc }` to `ydoc`
- [x] **2.14** Make `kvStore` and `kvHelper` `const`, change `get kv() { return kvHelper }` to `kv: kvHelper`
- [x] **2.15** Remove `compact()` method from client object
- [x] **2.16** Remove `epoch` getter from client object
- [x] **2.17** Remove `onEpochChange()` method and `epochChangeCallbacks` array
- [x] **2.18** Remove `currentDataEpoch` variable
- [x] **2.19** Remove `encryptedStores.length = 0; encryptedStores.push(...)` (only in deleted swap code)
- [x] **2.20** Remove `-0` suffix from GUID entirely. Clean break, no backward compat needed
- [x] **2.21** Update module-level JSDoc (remove "Epoch-based compaction" section)
- [x] **2.22** Run tests: `bun test packages/workspace`: 246 pass
- [x] **2.23** Run typecheck: `bun run typecheck`: clean

### Phase 3: Update types

- [x] **3.1** Verified: `compact`, `epoch`, `onEpochChange` were only on the runtime object, not in types.ts
- [x] **3.2** `encodedSize()` already present on `WorkspaceClient` type
- [x] **3.3** Three methods kept. No type changes needed for extension API
- [x] **3.4** Typecheck passes

### Phase 4: Documentation

- [x] **4.1** Updated `packages/workspace/src/workspace/README.md`
- [x] **4.2** No compaction references found in root workspace README
- [x] **4.3** Updated JSDoc in `create-workspace.ts`: removed epoch/compaction language, updated `encodedSize` docs

## Edge Cases

None. We're removing features, not adding them. The only edge case is backward compatibility:

- **Existing persisted data**: Data doc GUID changed from `{id}-0` to `{id}`. Clean break. No migration.
- **Code that calls `compact()`**: TypeScript error (method removed). Migration: delete the call.
- **Code that uses `onEpochChange`**: TypeScript error. Migration: delete the callback.
- **Code using `withWorkspaceExtension` / `withDocumentExtension`**: No change needed. Three methods preserved.

## Success Criteria

- [x] `coordYdoc` and `epoch.ts` are gone
- [x] `compact()`, `onEpochChange()`, `epoch` getter are gone
- [x] `ydoc`, `kvStore`, `kvHelper` are `const`
- [x] All 10 swap-related mutable variables are gone
- [x] `withWorkspaceExtension` and `withDocumentExtension` **preserved** (unified API reverted)
- [x] `encodedSize()` still works
- [x] All tests pass: 246 pass, 0 fail
- [x] Typecheck passes (pre-existing `@epicenter/ai` error only)
- [x] File is ~380 lines shorter (1091 → 711)

## Future: If compaction is ever needed

See `20260402T153000-workspace-anchor-and-reset-history.md` for the full anchor model design:
- Promote coordination doc to first-class "anchor" that extensions persist/sync
- `resetHistory()` creates a fresh epoch doc, fires factories for persistence, bumps epoch
- Epoch cache (localStorage) prevents reload loops
- Multi-device sync flow with data-before-epoch ordering

The design work is done. It can be implemented when a use case justifies it. Likely when doc sizes exceed 5-10 MB and load times become noticeable.

## References

- `packages/workspace/src/workspace/create-workspace.ts`: primary target (1091 lines → ~700)
- `packages/workspace/src/workspace/types.ts`: remove compaction types, update builder type
- `packages/workspace/src/workspace/epoch.ts`: delete
- `packages/workspace/src/workspace/epoch.test.ts`: delete
- `packages/workspace/src/workspace/compact.test.ts`: delete
- `packages/workspace/src/workspace/compact.multi-client.test.ts`: delete

## Review

**Completed**: 2026-04-02
**Branch**: `feat/epoch-based-ydoc-compaction`

### Summary

Deleted the entire epoch-based compaction system (~1,094 lines net across 7 files). The workspace now uses a single `Y.Doc` with `guid: id` (no coordination doc, no `-0` suffix, no epoch tracking). All swap-related mutable state is gone: `ydoc`, `kvStore`, `kvHelper` are `const`, and the client exposes them as direct properties instead of getters.

### Deviations from Spec

1. **Extension API unification reverted.** The spec proposed merging three methods into one `withExtension(key, fn | { workspace?, document?, tags? })`. This was fully implemented and tested, then reverted after critical evaluation:
   - Three distinct method names (`withExtension`, `withWorkspaceExtension`, `withDocumentExtension`) are immediately scannable and autocomplete-friendly
   - The object form `{ workspace: fn }` adds indirection without reducing cognitive load
   - TypeScript overloaded call signatures on object properties are harder to resolve than separate methods
   - The 90% case (`withExtension(key, fn)` registering for both scopes) was already the correct default from a previous spec

2. **GUID `-0` suffix removed** (spec said keep for backward compat). Changed to clean break since no data at rest needs preserving. GUID is now just the workspace `id`.

### Stragglers Investigated

- `apps/api/src/base-sync-room.ts` "compaction": **false positive.** This is Durable Object update log compaction (merging SQLite rows), completely unrelated to workspace epoch compaction.
- `packages/workspace/src/shared/y-keyvalue/ymap-simplicity-case.test.ts`: **false positive.** Educational console.log strings about the general compaction concept.
- All `specs/*.md` references: **historical records**, intentionally untouched.

### Follow-up Work

- Consider building `encryptedStores` as a single-pass `const` array (currently uses imperative `.push()` loop)
- Evaluate `options?: { key?: Uint8Array }` construction-time encryption parameter. May have a cleaner alternative
- Review `withEncryption()` wiring (~120 lines) for unnecessary indirection
- `packages/workspace/src/workspace/README.md`: update
