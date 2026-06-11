# withDocument: Replace updatedAt Column Mapping with onUpdate Callback

**Date**: 2026-03-04
**Status**: Draft
**Author**: AI-assisted

## Overview

Replace the `updatedAt` column-name mapping in `.withDocument()` with a zero-argument `onUpdate` callback that returns a partial row update. This gives callers full control over what gets written when a content Y.Doc changes, instead of hardcoding `Date.now()` to a single `number` column.

## Motivation

### Current State

```typescript
// file-table.ts
export const filesTable = defineTable(
  type({
    id: FileId,
    name: 'string',
    parentId: FileId.or(type.null),
    type: "'file' | 'folder'",
    size: 'number',
    createdAt: 'number',
    updatedAt: 'number',  // must be number: system writes Date.now()
    trashedAt: 'number | null',
    _v: '1',
  }),
).withDocument('content', {
  guid: 'id',
  updatedAt: 'updatedAt',  // column name, not a value
  tags: ['persistent'],
});
```

The type system enforces `updatedAt` must point to a `number` column via `NumberKeysOf<TRow>`. At runtime, `create-document.ts:316` writes `Date.now()` unconditionally.

This creates problems:

1. **Format inflexibility**: Callers who store timestamps as ISO strings or DateWithTimezoneStrings (`"2024-01-01T20:00:00.000Z|America/New_York"`) can't use those columns as `updatedAt`. They're forced to maintain a separate `number` column just for the document system.
2. **No co-located writes**: If you want to write `lastEditedBy` or other metadata atomically when a doc changes, there's no hook: you'd need a separate observer that races with the system's own write.
3. **Over-specified API**: The system dictates both *which column* and *what value* to write. Callers only need to say "what to do when a doc changes."

### Desired State

```typescript
export const filesTable = defineTable(
  type({
    id: FileId,
    name: 'string',
    parentId: FileId.or(type.null),
    type: "'file' | 'folder'",
    size: 'number',
    createdAt: 'number',
    updatedAt: 'number',
    trashedAt: 'number | null',
    _v: '1',
  }),
).withDocument('content', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
  tags: ['persistent'],
});
```

The callback takes zero arguments and returns `Partial<Omit<TRow, 'id'>>`. TypeScript verifies the returned object against the row shape. Callers compute whatever they need inline: `Date.now()`, `new Date().toISOString()`, a DateWithTimezoneString, multiple fields, etc.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Callback arity | Zero arguments | Nothing useful to pass: `Date.now()`, timezone, user ID are all app state the caller already has via closure. Keeps the API surface minimal. |
| Callback return type | `Partial<Omit<TRow, 'id'>>` | Type-safe against the row schema. The system plugs the return value into `tableHelper.update(guid, ...)`. |
| Remove `NumberKeysOf` from withDocument | Yes | No longer needed: the callback return type provides equivalent safety. |
| Remove `ClaimedDocumentColumns` for updatedAt | Yes, for updatedAt only | The claiming was needed because the system auto-targeted a column. With a callback, the user owns the write. Guid claiming stays: two documents sharing a GUID still causes storage collisions. |
| Dual API (column name OR callback) | No: callback only | One path through the code, one set of types. The column-name shorthand saves one line but adds a discriminated union and two code paths. |
| `onUpdate` is required | Yes | A document without change tracking is a footgun: you'd have stale metadata and no way to detect it. If someone truly wants a no-op, `onUpdate: () => ({})` is explicit. |

## Architecture

```
BEFORE:
┌─────────────────────────────────────────────────┐
│ .withDocument('content', {                      │
│   guid: 'id',            ← string column name   │
│   updatedAt: 'updatedAt' ← number column name   │
│ })                                               │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼ runtime (create-document.ts:316)
          tableHelper.update(guid, {
              [updatedAtKey]: Date.now()   ← hardcoded
          })

AFTER:
┌─────────────────────────────────────────────────┐
│ .withDocument('content', {                      │
│   guid: 'id',                  ← string column   │
│   onUpdate: () => ({           ← user callback   │
│     updatedAt: Date.now()                        │
│   })                                             │
│ })                                               │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼ runtime (create-document.ts:316)
          tableHelper.update(guid, onUpdate())
```

## Implementation Plan

### Phase 1: Type Changes

- [ ] **1.1** In `types.ts`: Update `DocumentConfig`: replace `updatedAt: TUpdatedAt` with `onUpdate: () => Partial<Omit<TRow, 'id'>>`. This changes the type params: remove `TUpdatedAt`, add `TRow` (the inferred row type from the schema).
- [ ] **1.2** In `types.ts`: Remove `NumberKeysOf` (no longer used anywhere).
- [ ] **1.3** In `types.ts`: Update `ClaimedDocumentColumns` to only collect `guid` keys (not updatedAt).
- [ ] **1.4** In `define-table.ts`: Update `TableDefinitionWithDocBuilder.withDocument` generic signature: remove the `TUpdatedAt` type parameter, add `TOnUpdate` constrained to `() => Partial<Omit<InferredRow, 'id'>>`.
- [ ] **1.5** In `define-table.ts`: Update the config param shape from `{ guid, updatedAt, tags? }` to `{ guid, onUpdate, tags? }`.
- [ ] **1.6** In `define-table.ts`: Update the runtime `attachDocumentBuilder` to store `onUpdate` instead of `updatedAt` in the documents map.
- [ ] **1.7** In `define-table.ts`: Update JSDoc examples.

### Phase 2: Runtime Changes

- [ ] **2.1** In `create-document.ts`: Replace `updatedAtKey` in `CreateDocumentsConfig` with `onUpdate: () => Partial<Omit<TRow, 'id'>>`.
- [ ] **2.2** In `create-document.ts`: Change the update handler (line ~316) from `{ [updatedAtKey]: Date.now() }` to `onUpdate()`.
- [ ] **2.3** In `create-workspace.ts`: Update the wiring in the `createDocuments()` call (line ~176) to pass `onUpdate` from the document config instead of `updatedAtKey`.

### Phase 3: Update Consumers

- [ ] **3.1** In `packages/filesystem/src/file-table.ts`: Change `.withDocument('content', { guid: 'id', updatedAt: 'updatedAt', tags: ['persistent'] })` to `.withDocument('content', { guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }), tags: ['persistent'] })`.
- [ ] **3.2** Search for any other `.withDocument()` call sites and update them.

### Phase 4: Update Tests

- [ ] **4.1** In `define-table.test.ts`: Update all `withDocument` tests to use `onUpdate` callback instead of `updatedAt` column name.
- [ ] **4.2** Update type error tests: the "rejects reusing an updatedAt column" test becomes irrelevant (remove it). The "rejects reusing a guid column" test stays.
- [ ] **4.3** Add new type-level test: `onUpdate` return type is checked against the row schema (returning a non-existent column or wrong type is a compile error).
- [ ] **4.4** In `create-workspace.test.ts`: Update all `withDocument` usages to use `onUpdate`.
- [ ] **4.5** Add runtime test: verify the callback is actually invoked when a doc changes, and the returned values are written to the row.

### Phase 5: Cleanup

- [ ] **5.1** In `index.ts` (workspace package exports): Verify `DocumentConfig` export still works with the new shape. Remove `NumberKeysOf` export if it was exported.
- [ ] **5.2** Update JSDoc on `DocumentConfig`, `CreateDocumentsConfig`, and `createDocuments`.

## Edge Cases

### onUpdate returns empty object

1. User writes `onUpdate: () => ({})`
2. `tableHelper.update(guid, {})` is called: should be a no-op
3. Valid use case: user tracks changes via a separate observer and doesn't need the built-in bump

### onUpdate returns fields that don't exist on the row

1. User writes `onUpdate: () => ({ nonExistent: 123 })`
2. TypeScript catches this at compile time: `Partial<Omit<TRow, 'id'>>` won't include `nonExistent`
3. No runtime issue

### onUpdate closure captures stale state

1. User defines `onUpdate` at table definition time, captures a `let userId` variable
2. The closure runs later when the doc changes: `userId` may have changed
3. This is standard JavaScript closure behavior. Not our problem to solve, but worth noting in JSDoc.

### Two documents with onUpdate writing to the same column

1. `body` and `cover` documents both write `{ updatedAt: Date.now() }` via their respective callbacks
2. Both fire independently: last write wins (LWW via Yjs)
3. This is valid and expected. The `ClaimedDocumentColumns` restriction only applies to `guid` (preventing GUID collisions), not to onUpdate write targets.

## Open Questions

1. **Should `onUpdate` be optional?**
   - If omitted, no row update happens when the doc changes (pure Y.Doc tracking with no metadata bump).
   - **Recommendation**: Keep it required. A document with no change tracking is almost always a bug. `onUpdate: () => ({})` is an explicit no-op if someone truly wants it.

2. **Should the `DocumentConfig` type carry the row type as a generic parameter?**
   - Currently `DocumentConfig<TGuid, TUpdatedAt, TTags>`. With this change, the `onUpdate` return type needs to know the row shape.
   - Options: (a) Add `TRow` as a type param to `DocumentConfig`, (b) Use a wide type (`Record<string, unknown>`) at the config level and narrow at the `withDocument` call site.
   - **Recommendation**: Option (a) is cleaner: it keeps the type safety threaded through. Investigate whether this creates issues for `ExtractAllDocumentTags` or other type-level consumers of `DocumentConfig`.

## Success Criteria

- [ ] `.withDocument()` accepts `onUpdate: () => Partial<Omit<TRow, 'id'>>` instead of `updatedAt: string`
- [ ] `NumberKeysOf` is removed from the codebase
- [ ] All existing tests pass (updated to new API)
- [ ] New type-level test verifies `onUpdate` return type is checked against row schema
- [ ] New runtime test verifies callback is invoked and return values are written
- [ ] `packages/filesystem/src/file-table.ts` compiles and works with the new API
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes

## References

- `packages/epicenter/src/workspace/types.ts`: `DocumentConfig`, `NumberKeysOf`, `StringKeysOf`, `ClaimedDocumentColumns`
- `packages/epicenter/src/workspace/define-table.ts`: `TableDefinitionWithDocBuilder.withDocument`, `attachDocumentBuilder`
- `packages/epicenter/src/workspace/create-document.ts`: `CreateDocumentsConfig`, `createDocuments`, the update handler at line ~316
- `packages/epicenter/src/workspace/create-workspace.ts`: wiring at line ~173
- `packages/epicenter/src/workspace/define-table.test.ts`: withDocument tests starting line 248
- `packages/filesystem/src/file-table.ts`: primary consumer
