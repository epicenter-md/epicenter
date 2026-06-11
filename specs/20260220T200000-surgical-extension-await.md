# Surgical Extension Await and Typed Document Exports

**Date**: 2026-02-20
**Status**: Superseded
**Author**: AI-assisted
**Prerequisite**: `specs/20260220T195900-unify-document-extension-shape.md` (must be implemented first)
**Superseded by:** `specs/20260220T200000-flat-extension-type.md` and the unified extension lifecycle refactor (`f42d3770a`). The Option B flat-inject approach was replaced by making `whenReady` and `destroy` first-class fields on `Extension<T> = T & { whenReady, destroy }`, normalized by `defineExtension()`. Typed `DocumentContext.extensions` and `ExtensionContext` as a standalone type (not alias for `WorkspaceClient`) survived into the final design.

## Overview

Add per-extension `whenReady` access so factories can surgically await specific prior extensions instead of a flat composite. Extend the document extension system with typed, accumulated exports so document factories get the same typed `context.extensions` that workspace factories already have.

## Motivation

### Current State (after prerequisite spec)

Both levels return `{ exports?, lifecycle? }`. The same factory works at both levels. That's the prerequisite spec's win.

But two gaps remain:

```typescript
// Workspace factory: can access prior exports, but whenReady is a flat blob
.withExtension('sync', (context) => {
  // ✅ Typed access to prior exports
  context.extensions.persistence.clearData();
  // ❌ Can only await ALL prior extensions, not just persistence
  await context.whenReady; // waits for persistence AND sqlite AND everything else
})

// Document factory: no access to prior extensions at all
.withDocumentExtension('sync', ({ ydoc, whenReady }) => {
  // ❌ No typed access to prior document extension exports
  // ❌ whenReady is still a flat composite
  await whenReady; // waits for everything
})
```

This creates two problems:

1. A sync extension that only needs persistence to be ready must wait for every other extension too. With expensive extensions (SQLite indexing, markdown file scanning), that's wasted time.
2. Document extension factories are blind to prior document extensions. A document sync extension can't call `persistence.clearData()` or await `persistence.whenReady` specifically.

### Desired State

```typescript
// Workspace: surgical await
.withExtension('sync', (context) => {
  context.extensions.persistence.clearData();        // typed exports (unchanged)
  await context.extensions.persistence.whenReady;    // surgical await (NEW)
})

// Document: same pattern
.withDocumentExtension('sync', (context) => {
  context.extensions.persistence.clearData();        // typed exports (NEW)
  await context.extensions.persistence.whenReady;    // surgical await (NEW)
})
```

Same access pattern at both levels. Factories see prior extensions with both exports and readiness.

## Research Findings

### How `whenReady` Flows Today

Workspace level (`create-workspace.ts`):

```
.withExtension('a', factory) → result.lifecycle?.whenReady pushed to whenReadyPromises[]
.withExtension('b', factory) → result.lifecycle?.whenReady pushed to whenReadyPromises[]
                              ↓
client.whenReady = Promise.all(whenReadyPromises)
```

Each factory receives the client-so-far, which includes `whenReady` = `Promise.all` of everything before it. This composite is rebuilt on each `buildClient()` call, so extension B's `context.whenReady` only includes extension A's promise.

Document level (`create-document-binding.ts` `open()` loop):

```
for (const reg of applicableExtensions) {
  const whenReady = Promise.all(prior lifecycles' whenReady);
  const result = reg.factory({ ydoc, whenReady, binding });
  lifecycles.push(result);
}
```

Same pattern: each document factory gets a composite of all prior document extensions.

### `ExtensionContext` Is an Alias for `WorkspaceClient`

```typescript
export type ExtensionContext<...> = WorkspaceClient<...>;
```

These are the same type (line 981-993 of `types.ts`). Adding factory-only properties (like per-extension whenReady) requires splitting them into separate types. The consumer-facing `WorkspaceClient` shouldn't expose internal factory plumbing.

### Document Extension Type Accumulation

Workspace extensions already accumulate types via generics:

```
createWorkspace(def)                        // TExtensions = {}
  .withExtension('a', ...)                  // TExtensions = { a: ExportsA }
  .withExtension('b', ...)                  // TExtensions = { a: ExportsA, b: ExportsB }
```

Document extensions currently only track key names (`TDocExtKeys extends string = never`), not export types. To give document factories typed access to prior exports, we need:

```
createWorkspace(def)
  .withDocumentExtension('persistence', ...)  // TDocExt = { persistence: { clearData: () => void } }
  .withDocumentExtension('sync', ...)         // TDocExt = { persistence: ..., sync: { provider: ... } }
```

Types resolve at chain time (generics). Values are created at `open()` time (runtime). This is sound because the factory signature carries the types, and the runtime builds matching values when iterating registered factories.

### Approaches for Exposing `whenReady` Per Extension

Three viable approaches emerged from design review. All share the same unified return type (`{ exports?, lifecycle? }`); they differ in what factories _receive_.

**Option A: Handle pattern**

Each extension in `context.extensions` is wrapped: `{ exports: T, whenReady: Promise<void> }`.

```typescript
.withExtension('sync', (ctx) => {
  await ctx.extensions.persistence.whenReady;          // surgical
  ctx.extensions.persistence.exports.clearData();      // exports via .exports
})
```

**Option B: Flat exports with injected `whenReady`**

Framework merges `whenReady` into the exports object. No wrapper.

```typescript
.withExtension('sync', (ctx) => {
  await ctx.extensions.persistence.whenReady;     // injected by framework
  ctx.extensions.persistence.clearData();          // flat exports
})
```

**Option D: Flat exports with `$` lifecycle namespace**

Exports are flat. Lifecycle goes under a reserved `$` property.

```typescript
.withExtension('sync', (ctx) => {
  await ctx.extensions.persistence.$.whenReady;    // lifecycle via $
  ctx.extensions.persistence.clearData();           // flat exports
})
```

## Design Decisions

| Decision                                        | Choice                    | Rationale                                                                                                                                                       |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-extension whenReady access                  | Yes, at both levels       | The flat composite forces unnecessary waiting. Sync shouldn't wait for SQLite indexing.                                                                         |
| Approach for whenReady access                   | Open (see below)          | This is the central design question. Both B and D are viable; the implementer should evaluate after the prerequisite spec lands and usage patterns are clearer. |
| Split `ExtensionContext` from `WorkspaceClient` | Yes                       | Factory-only properties shouldn't leak to consumers. `WorkspaceClient` stays clean; `ExtensionContext` extends it.                                              |
| Typed document extension exports                | Yes, accumulated generics | Same pattern as workspace. Types at chain time, values at open time.                                                                                            |
| `DocumentContext` gains `extensions`            | Yes                       | Prior document extension exports + whenReady, same access pattern as workspace.                                                                                 |
| Composite `whenReady`                           | Keep at both levels       | Still useful as a "wait for everything" shortcut. New surgical access is additive.                                                                              |
| `client.extensions[key]` for consumers          | Unchanged (flat exports)  | Consumer-facing API should stay simple. Surgical await is a factory-author concern.                                                                             |

### The Open Design Question: B vs D

This is the decision that should be deferred until the prerequisite spec is implemented and real extension authoring patterns emerge.

**Option B (flat inject)**

```typescript
// Type:
type ExtensionInstance<T> = T & { whenReady: Promise<void> };

// context.extensions and client.extensions are the same type
ctx.extensions.persistence.clearData();
await ctx.extensions.persistence.whenReady;
```

| Strength                                    | Weakness                                                      |
| ------------------------------------------- | ------------------------------------------------------------- |
| Most ergonomic: no prefix, no namespace    | Name collision if an extension exports `whenReady`            |
| Consistent type for factories and consumers | Framework silently injects a property into the exports object |
| Consumers can also surgically await         | TypeScript type is `T & { whenReady }` which could shadow     |

**Option D (`$` namespace)**

```typescript
// Type:
type ExtensionMeta = { whenReady: Promise<void> };
type ExtensionInstance<T extends ExtensionExports> = T & { $: ExtensionMeta };
type ExtensionExports = Record<string, unknown> & { $?: never }; // reserves $

// Same type for factories and consumers
ctx.extensions.persistence.clearData();
await ctx.extensions.persistence.$.whenReady;
```

| Strength                                                      | Weakness                                          |
| ------------------------------------------------------------- | ------------------------------------------------- |
| Zero collision risk: `$` is reserved at the type level       | Extra `.$` in the access path                     |
| Clean separation: exports are exports, lifecycle is lifecycle | `$` convention isn't standard (though short)      |
| Consistent type for factories and consumers                   | Could confuse with Svelte's `$` reactivity prefix |

**Recommendation**: lean toward B for ergonomics unless real-world extension authoring surfaces a collision. The `whenReady` name is a framework concept that no domain export would plausibly use.

## Architecture

### Context Shape (Both Levels)

```
Before (current):

  WorkspaceFactory receives:              DocumentFactory receives:
  ┌──────────────────────────┐            ┌────────────────────────┐
  │ context (= WorkspaceClient)           │ { ydoc, whenReady,     │
  │   .extensions: { a: ExportsA }        │   binding }            │
  │   .whenReady: Promise (composite)     │                        │
  │   .ydoc, .tables, .kv, ...  │         │ No typed extensions    │
  └──────────────────────────┘            │ No surgical await      │
                                          └────────────────────────┘

After:

  WorkspaceFactory receives:              DocumentFactory receives:
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ context (ExtensionContext)    │        │ context (DocumentContext)     │
  │   .extensions.a.doThing()    │        │   .extensions.a.doThing()    │
  │   .extensions.a.whenReady ←──── surgical  .extensions.a.whenReady ←──── surgical
  │   .whenReady: Promise (composite)     │   .whenReady: Promise (composite)
  │   .ydoc, .tables, .kv, ...  │        │   .ydoc, .binding            │
  └──────────────────────────────┘        └──────────────────────────────┘
```

### Type Accumulation for Document Extensions

```
Chain time (types resolve):
  .withDocumentExtension<'persistence', { clearData: () => void }>(...)
  .withDocumentExtension<'sync', { provider: WebsocketProvider }>(...)
                    ↓
  TDocExtensions = { persistence: { clearData: () => void }, sync: { provider: ... } }

Open time (values created):
  for each registered doc extension:
    build context with prior extensions map
    call factory → get { exports, lifecycle }
    add to extensions map (keyed by registration key)
    store lifecycle for cleanup
```

### Split `ExtensionContext` from `WorkspaceClient`

```typescript
// Consumer-facing: stays clean
type WorkspaceClient<..., TExtensions> = {
  extensions: TExtensions;           // flat exports (unchanged)
  whenReady: Promise<void>;          // composite (unchanged)
  // ... ydoc, tables, kv, etc.
};

// Factory-facing: extends with per-extension handles
type ExtensionContext<..., TExtensions> = Omit<WorkspaceClient<...>, 'extensions'> & {
  extensions: {
    [K in keyof TExtensions]: TExtensions[K] & { whenReady: Promise<void> }
    // Option B: flat inject. Option D: use $ namespace instead.
  };
};
```

## Implementation Plan

### Phase 1: Split `ExtensionContext` from `WorkspaceClient`

- [ ] **1.1** In `static/types.ts`: define `ExtensionContext` as its own type, no longer a type alias for `WorkspaceClient`. It extends `WorkspaceClient` with per-extension whenReady (approach B or D).
- [ ] **1.2** In `static/create-workspace.ts`: in the `withExtension` method, build a `contextExtensions` map that wraps each prior extension's exports with its `whenReady` promise. Pass this to the factory instead of the raw `client`.
- [ ] **1.3** Verify existing workspace extension factories still work unchanged (they already destructure what they need; the added `whenReady` is additive).

### Phase 2: Add Typed Document Extension Accumulation

- [ ] **2.1** In `static/types.ts`: change `WorkspaceClientBuilder` to track `TDocExtensions extends Record<string, unknown>` instead of `TDocExtKeys extends string`. Update `withDocumentExtension` generic signature to accumulate export types.
- [ ] **2.2** In `static/types.ts`: update `DocumentExtensionRegistration` to carry the export type (or use a generic registration that erases to `Record<string, unknown>` at runtime but preserves types at chain time).
- [ ] **2.3** In `shared/lifecycle.ts`: update `DocumentContext` to include `extensions` map: typed access to prior document extensions' exports + whenReady.

### Phase 3: Wire Runtime in `create-document-binding.ts`

- [ ] **3.1** In the `open()` loop: build an `extensions` map incrementally. After each document extension factory runs, store its exports + whenReady under its key.
- [ ] **3.2** Pass the accumulated extensions map to subsequent document extension factories via `DocumentContext.extensions`.
- [ ] **3.3** Keep the composite `whenReady` on `DocumentContext` for backward compatibility.

### Phase 4: Update Consumers

- [ ] **4.1** Update `indexeddbPersistence` factory if needed (it destructures `{ ydoc }`: should work as-is).
- [ ] **4.2** Update `createSyncExtension` to use surgical await if beneficial.
- [ ] **4.3** Update fs-explorer's document extensions to use typed `context.extensions` if beneficial.

### Phase 5: Tests

- [ ] **5.1** Test that workspace extension factories can access prior extensions' whenReady per key.
- [ ] **5.2** Test that document extension factories receive typed exports from prior doc extensions.
- [ ] **5.3** Test that surgical await works correctly (extension B starts after A's whenReady resolves, not after everything).
- [ ] **5.4** Test that composite `whenReady` still works at both levels (backward compat).

### Phase 6: Verify

- [ ] **6.1** `bun tsc --noEmit` from packages/epicenter: zero type errors.
- [ ] **6.2** `bun test` from packages/epicenter: all tests pass.
- [ ] **6.3** Build fs-explorer: verify it works end-to-end.

## Edge Cases

### Extension factory that doesn't return `whenReady`

The framework defaults to `Promise.resolve()`. Subsequent extensions see an already-resolved promise for that key. No issue; this is how it works today at the workspace level.

### Document extension factory accesses an extension that was filtered by tags

Document extension registrations have optional tag filters. Extension A might fire for tag `persistent` but not tag `ephemeral`. If extension B expects `context.extensions.a` but A was skipped for this document, the value would be missing.

Two options: (a) make it optional in the type (`context.extensions.a?`), or (b) only type extensions that have no tag filter (universal extensions are always present). Recommendation: start with (a). The consumer adds a guard; the type system reminds them.

### Circular whenReady dependency

Extension A awaits B's whenReady, B awaits A's. This is impossible by construction: factories run in registration order, and each factory only sees prior extensions. Extension B can't reference A if B was registered first. The builder chain enforces ordering.

### Consumer code accessing `whenReady` on `client.extensions`

If we choose Option B (flat inject), `client.extensions.persistence.whenReady` is visible to consumers too. This is arguably a feature: consumers can surgically await in UI code. If we choose Option D, consumers see `client.extensions.persistence.$.whenReady`.

If we want to hide this from consumers, we'd need to strip `whenReady` (or `$`) from the consumer-facing `WorkspaceClient.extensions` type. This adds type complexity. Recommendation: expose it. Consumers benefit from surgical await too (e.g., render gates in Svelte).

## Open Questions

1. **Option B or Option D?**
   - The central design question. Deferred until the prerequisite spec lands and real extension authoring patterns clarify whether `whenReady` collision is a practical concern.
   - **Recommendation**: B for ergonomics. Switch to D only if a collision surfaces.

2. **Should `client.extensions` (consumer-facing) include whenReady, or only `ExtensionContext.extensions` (factory-facing)?**
   - Exposing it to consumers lets them surgically await in UI code. Hiding it keeps the consumer API simpler.
   - **Recommendation**: expose it. The `{#await client.extensions.persistence.whenReady}` pattern in Svelte is useful.

3. **Should the composite `client.whenReady` remain, or is it redundant once per-extension whenReady exists?**
   - It's still useful as a "wait for everything" shortcut.
   - **Recommendation**: keep it. It's one line of code and avoids `Promise.all(Object.values(...))` in consumer code.

4. **How should `DocumentContext.extensions` handle tag-filtered extensions that were skipped?**
   - See edge case above. Options: (a) optional types, (b) only type universal extensions.
   - **Recommendation**: (a) optional types. Simpler to implement, type system warns the consumer.

## Success Criteria

- [ ] Workspace extension factories can `await context.extensions[key].whenReady` for any specific prior extension
- [ ] Document extension factories can `await context.extensions[key].whenReady` for any specific prior document extension
- [ ] Document extension factories have typed access to prior document extension exports
- [ ] `ExtensionContext` is a separate type from `WorkspaceClient`
- [ ] Composite `whenReady` still works at both levels
- [ ] All existing tests pass without modification (additive change)
- [ ] New tests cover surgical await at both levels

## References

- `specs/20260220T195900-unify-document-extension-shape.md`: prerequisite spec (must be done first)
- `packages/epicenter/src/shared/lifecycle.ts`: `Extension<T>`, `DocumentContext`
- `packages/epicenter/src/static/types.ts`: `ExtensionContext`, `WorkspaceClientBuilder`, `DocumentExtensionRegistration`
- `packages/epicenter/src/static/create-workspace.ts`: `buildClient()`, `withExtension`, `withDocumentExtension`
- `packages/epicenter/src/static/create-document-binding.ts`: `open()` loop where document extensions fire
- `packages/epicenter/src/extensions/sync/web.ts`: `indexeddbPersistence` (the factory that works at both levels)

## Implementation Review

### B-vs-D Decision: Option B (flat inject)

**Chosen**: Option B: `whenReady` injected directly into each extension's exports object via `Object.assign`.

**Rationale**:

1. **Ergonomics win**: `ctx.extensions.persistence.whenReady` reads naturally with no prefix or namespace.
2. **No `$` confusion with Svelte**: Svelte uses `$` for reactivity; adding `$` as a lifecycle namespace would create visual noise and cognitive overhead for Svelte-heavy consumers.
3. **`whenReady` is unambiguously a framework concept**: No domain extension would plausibly export a function called `whenReady`. If one does, it's already semantically close to what the framework injects.
4. **Consumer-visible by design**: Exposing `whenReady` to consumers (not just factories) enables `{#await client.extensions.persistence.whenReady}` in Svelte templates: a pattern the spec recommended.
5. **Spec recommendation aligned**: The spec itself leaned toward B for ergonomics unless a collision surfaces.

**Trade-off accepted**: Framework silently injects a property into the exports object. This is documented and the `& { whenReady: Promise<void> }` mapped type makes it visible at the type level.

### What Changed

**`packages/epicenter/src/static/types.ts`**:

- `WorkspaceClient.extensions` mapped type: `{ [K in keyof TExtensions]: TExtensions[K] & { whenReady: Promise<void> } }`
- `ExtensionContext` JSDoc updated (kept as alias for WorkspaceClient; splitting deferred: see deviations)
- `WorkspaceClientBuilder` changed from `TDocExtKeys extends string = never` to `TDocExtensions extends Record<string, unknown> = Record<string, never>`
- `withDocumentExtension` accumulates `TDocExtensions & Record<K, TDocExports>` and receives `DocumentContext<TDocExtensions>` in its factory

**`packages/epicenter/src/shared/lifecycle.ts`**:

- `DocumentContext` made generic: `DocumentContext<TDocExtensions extends Record<string, unknown> = Record<string, unknown>>`
- Added `extensions` field: `{ [K in keyof TDocExtensions]?: TDocExtensions[K] & { whenReady: Promise<void> } }` (optional due to tag filtering)

**`packages/epicenter/src/static/create-workspace.ts`**:

- `withExtension`: normalizes `whenReady` to `Promise<void>`, injects into exports via `Object.assign(exports, { whenReady: extWhenReady })`
- `buildClient`: casts `extensions` to the mapped type (safe: runtime injects whenReady for every entry)

**`packages/epicenter/src/static/create-document-binding.ts`**:

- `open()` loop builds `docExtensionsMap` incrementally
- Each doc extension factory receives `extensions: { ...docExtensionsMap }` in its context
- Per-extension `whenReady` injected via `Object.assign` (same pattern as workspace level)
- Extensions with no exports still get a `{ whenReady }` entry in the map

### Tests Added

**`create-workspace.test.ts`** (5 new tests):

- Extension exports include injected `whenReady`
- Factory receives prior extensions with per-key `whenReady`
- Per-extension `whenReady` resolves independently
- Composite `client.whenReady` waits for all extensions
- No-lifecycle extension gets resolved `whenReady`

**`create-document-binding.test.ts`** (4 new tests):

- Second doc extension receives prior extensions map with exports + `whenReady`
- Tag filtering correctly omits/includes extensions in the map
- Lifecycle-only extension (no exports) still contributes `whenReady` entry
- `getExports()` includes `whenReady` on each extension's exports

### Deviations from Spec

1. **`ExtensionContext` not split from `WorkspaceClient`**: The spec called for `ExtensionContext` to become its own type extending `WorkspaceClient` with per-extension whenReady. In practice, since we chose Option B (flat inject), the mapped type `TExtensions[K] & { whenReady }` serves both consumers and factories. Splitting would add type complexity with no benefit until we need factory-only properties that consumers shouldn't see. `ExtensionContext` remains a type alias with updated JSDoc documenting the conceptual separation.

2. **Consumer-visible `whenReady`**: The spec left this as an open question. We chose to expose it (not strip from consumer type), enabling Svelte render gates like `{#await client.extensions.persistence.whenReady}`.

3. **Phase 4 (Update Consumers) skipped**: `indexeddbPersistence`, `createSyncExtension`, and fs-explorer weren't updated to use surgical await. This is intentional: the change is additive and existing destructuring patterns (`{ ydoc }`) work unchanged. Consumers can adopt surgical await incrementally.

### Verification

- `bun tsc --noEmit`: Zero new type errors (all errors are pre-existing in scripts/, benchmark.test.ts, table-helper.test.ts, create-tables.test.ts: `BaseRow`/`_v` issues unrelated to this work)
- `bun test`: 689 pass, 2 skip, 0 fail (up from 680: 9 new tests added)
