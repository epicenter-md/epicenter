# Brand file IDs with `FileId` type

**Date**: 2026-02-09
**Status**: Done
**Author**: AI-assisted

## Overview

Add a branded `FileId` type to the filesystem package. All string-based file identifiers become `FileId = Guid & Brand<'FileId'>`. The `ROOT_ID` sentinel and `RootId` type are eliminated: `null` represents root everywhere, including as a `Map` key.

## Motivation

### Current State

Every file identifier in the filesystem is typed as `string`:

```typescript
// types.ts
export type FileRow = {
	id: string;
	parentId: string | null;
	// ...
};

export type FileSystemIndex = {
	pathToId: Map<string, string>;
	childrenOf: Map<string, string[]>;
	plaintext: Map<string, string>;
};
```

A sentinel constant converts `null` to a magic string at the index boundary:

```typescript
// types.ts
export const ROOT_ID = '__ROOT__';

// file-system-index.ts
const parentKey = row.parentId ?? ROOT_ID;

// validation.ts: hardcoded, not even using the constant
const parentKey = parentId ?? '__ROOT__';
```

This creates problems:

1. **No type safety on IDs**: A workspace GUID, a table row ID, and a file ID are all `string`. Nothing prevents passing one where another is expected.
2. **Impedance mismatch**: The data layer uses `null` for root, but the index layer uses a string sentinel. Every boundary requires coalescing (`?? ROOT_ID`).
3. **Inconsistent sentinel**: `validation.ts:41` hardcodes `'__ROOT__'` instead of using the constant. Works today by coincidence, but invites future bugs if the sentinel value ever changes.

### Desired State

```typescript
export type FileId = Guid & Brand<'FileId'>;

export type FileRow = {
	id: FileId;
	parentId: FileId | null;
	// ...
};

export type FileSystemIndex = {
	pathToId: Map<string, FileId>;
	childrenOf: Map<FileId | null, FileId[]>;
};
// Note: plaintext cache was subsequently removed: see specs/20260209T000000-simplify-content-doc-lifecycle.md
```

No sentinel. No coalescing. `null` means root in both the data layer and index layer.

## Research Findings

### Can `null` be branded in TypeScript?

Verified empirically: `null & Brand<T>` resolves to `never` for any `T`. TypeScript treats `null` as a primitive that cannot carry object properties, so the intersection is uninhabitable. This applies to all branding approaches:

| Type expression                       | Result  |
| ------------------------------------- | ------- |
| `null & Brand<'RootId'>`              | `never` |
| `null & { readonly __tag: 'RootId' }` | `never` |
| `null & { readonly [symbol]: true }`  | `never` |
| `string & Brand<'RootId'>`            | OK      |

**Implication**: There's no way to create a branded null type. The choice is between a branded string sentinel (`RootId`) or unbranded `null`.

### Can `null` be used as a JavaScript `Map` key?

Yes. `Map` supports any value as a key, including `null`, `undefined`, `NaN`, and objects. `map.get(null)` works correctly and is distinct from `map.get(undefined)`.

**Implication**: `Map<FileId | null, FileId[]>` works at both the type level and runtime.

## Design Decisions

| Decision                    | Choice                            | Rationale                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File ID type                | `FileId = Guid & Brand<'FileId'>` | Semantically distinct from other GUIDs. Prevents mixing file IDs with workspace IDs or doc IDs. `generateFileId()` wraps `generateGuid()` with a cast. Note: `FileId` carries two brands (`Brand<'Guid'>` from `Guid` and `Brand<'FileId'>`), which is intentional: it's a `Guid` that is also specifically a file ID. |
| Root representation         | `null` (no sentinel)              | Data layer already uses `null`. Eliminates impedance mismatch, coalescing logic, and the hardcoded `'__ROOT__'` bug. Null-as-Map-key works fine in JS.                                                                                                                                                                  |
| `ROOT_ID` constant          | Remove entirely                   | No longer needed. `resolveId('/')` returns `null`. Root checks become `=== null`.                                                                                                                                                                                                                                       |
| Arktype schema              | Keep as `id: 'string'`            | Runtime validation doesn't need brands. `FileId extends string` satisfies the schema.                                                                                                                                                                                                                                   |
| `TableHelper` compatibility | No changes needed                 | `FileId extends Guid extends string`. `TableHelper.get(id: string)` accepts `FileId` via widening.                                                                                                                                                                                                                      |
| Content doc pool IDs        | `FileId`                          | `fileId` params in `ContentDocPool`, `openDocument`, and `DocumentHandle` all become `FileId`.                                                                                                                                                                                                                          |
| `Y.Doc` guid param          | Accept `FileId`                   | `new Y.Doc({ guid: fileId })` works because `FileId extends string`.                                                                                                                                                                                                                                                    |

## Architecture

```
DATA LAYER (Yjs/TableHelper)           INDEX LAYER (FileSystemIndex)
─────────────────────────────           ────────────────────────────
FileRow.parentId: FileId | null    →    childrenOf: Map<FileId | null, FileId[]>
                                         (null key = root children)

FileRow.id: FileId                 →    pathToId: Map<string, FileId>
```

```
RESOLUTION FLOW
────────────────

path "/"           →  resolveId() returns null        →  childrenOf.get(null)
path "/docs"       →  resolveId() returns FileId      →  childrenOf.get(fileId)
path "/docs/a.md"  →  resolveId() returns FileId      →  used in getRow(), etc.

parsePath("/docs/a.md") → { parentId: FileId, name: "a.md" }
parsePath("/a.md")      → { parentId: null,   name: "a.md" }
```

## Implementation Plan

### Phase 1: Add `FileId` type and `generateFileId()` to `types.ts`

- [ ] **1.1** Add `FileId` type: `Guid & Brand<'FileId'>`
- [ ] **1.2** Add `generateFileId()`: wraps `generateGuid()` with a cast
- [ ] **1.3** Remove `ROOT_ID` constant
- [ ] **1.4** Update `FileRow.id` to `FileId`, `FileRow.parentId` to `FileId | null`
- [ ] **1.5** Update `FileSystemIndex` map types:
  - `pathToId: Map<string, FileId>`
  - `childrenOf: Map<FileId | null, FileId[]>`
  - `plaintext: Map<FileId, string>`
- [ ] **1.6** Update `TextDocumentHandle.fileId` and `RichTextDocumentHandle.fileId` to `FileId`
- [ ] **1.7** Update `ContentDocPool` method signatures: `fileId: string` → `fileId: FileId`

### Phase 2: Update `index.ts` barrel exports

- [ ] **2.1** Export `FileId` type and `generateFileId` function
- [ ] **2.2** Remove `ROOT_ID` export

### Phase 3: Update `file-system-index.ts`

- [ ] **3.1** Import `FileId` from types
- [ ] **3.2** Update map instantiation generics to match new `FileSystemIndex` types
- [ ] **3.3** Remove `pathToId.set('/', ROOT_ID)`: root no longer lives in path/id maps
- [ ] **3.4** Change `row.parentId ?? ROOT_ID` → just `row.parentId` (already `FileId | null`, use directly as map key)
- [ ] **3.5** Change `childrenOf.get(ROOT_ID)` → `childrenOf.get(null)` in `fixOrphans`
- [ ] **3.6** Update all internal function signatures to use `FileId` where appropriate
- [ ] **3.7** Cast `row.id` from `TableHelper.get()` results if needed (rows come back typed as `FileRow` which now has `FileId`)

### Phase 4: Update `yjs-file-system.ts`

- [ ] **4.1** Import `FileId`, `generateFileId` instead of `ROOT_ID`, `generateGuid`
- [ ] **4.2** `resolveId()`: return type → `FileId | null`. Return `null` for `'/'`, `FileId` otherwise.
- [ ] **4.3** `assertDirectory()`: param → `FileId | null`, early return on `null`
- [ ] **4.4** `getRow()`: param stays `string` internally (calls `filesTable.get(id: string)`): or narrow to `FileId` if desired
- [ ] **4.5** `getActiveChildren()`: param → `FileId[]`
- [ ] **4.6** `softDeleteDescendants()`: param → `FileId`
- [ ] **4.7** `parsePath()`: return type → `{ parentId: FileId | null; name: string }`
- [ ] **4.8** `getAllPaths()`: remove `.filter((p) => p !== '/')`: root is no longer in `pathToId`
- [ ] **4.9** Replace `generateGuid()` with `generateFileId()` in `writeFile` and `mkdir`
- [ ] **4.10** `stat()`: handle `resolved === '/'` before calling `resolveId` (already does this)
- [ ] **4.11** Callers of `resolveId` that pass result to `getRow` need a null guard: `resolveId` can now return `null` for root, but `getRow` expects a real ID. Audit each callsite:
  - `readdir`/`readdirWithFileTypes`: use `resolveId` result for `childrenOf.get()` (null OK) and `assertDirectory` (null OK: early-returns on null before calling `getRow` internally) ✓
  - `readFile`: calls `getRow(id)`: must guard `id === null` _before_ `getRow`. Throw EISDIR (can't read root). The guard also protects downstream `plaintext.get(id)` and `pool.loadAndCache(id)` which expect `FileId` ✓
  - `stat`: already special-cases `/` before `resolveId` ✓
  - `writeFile`: uses `pathToId.get()` not `resolveId` ✓
  - `rm`: uses `pathToId.get()` not `resolveId` ✓
  - `cp`: calls `getRow(srcId)`: must guard null ✓
  - `mv`: calls `getRow(id)`: must guard null ✓
  - `chmod`: calls `resolveId` but discards the return value (existence check only): null return is harmless ✓
  - `utimes`: calls `filesTable.update(id)`: must guard null (can't update root metadata) ✓

### Phase 5: Update `validation.ts`

- [ ] **5.1** Update `assertUniqueName` signature:
  - `childrenOf: Map<FileId | null, FileId[]>`
  - `parentId: FileId | null`
  - `excludeId?: FileId`
- [ ] **5.2** Remove `parentId ?? '__ROOT__'` coalescing: use `parentId` directly as map key: `childrenOf.get(parentId)`

### Phase 6: Update `content-doc-pool.ts`

- [ ] **6.1** Update standalone `openDocument` function signature: `fileId: string` → `fileId: FileId` (this is an exported function, not just internal)
- [ ] **6.2** Update internal `docs` map: `Map<string, PoolEntry>` → `Map<FileId, PoolEntry>`
- [ ] **6.3** Update all method signatures in `createContentDocPool` return object
- [ ] **6.4** `documentHandleToString`: no changes needed (doesn't take a `fileId` param)

### Phase 7: Update tests

- [ ] **7.1** `file-system-index.test.ts`:
  - Remove `ROOT_ID` import
  - Cast IDs in `makeRow` with `as FileId`
  - Remove root path/id map assertions (lines 30-31)
  - Change `childrenOf.get(ROOT_ID)` → `childrenOf.get(null)`
- [ ] **7.2** `validation.test.ts`:
  - Remove `ROOT_ID` import
  - Cast IDs in `makeRow` with `as FileId`
  - Change `new Map([[ROOT_ID, ['a' as FileId]]])` → `new Map([[null, ['a' as FileId]]])`
- [ ] **7.3** `yjs-file-system.test.ts`, `convert-on-switch.test.ts`, `markdown-helpers.test.ts`: no changes expected (they use the public API, not raw IDs), but verify they still pass

## Edge Cases

### `resolveId('/')` now returns `null` instead of `ROOT_ID`

1. Callers that previously compared `=== ROOT_ID` now compare `=== null`
2. Callers that passed the result to `getRow()` (which looks up a table row) will get `null`: root has no row
3. Each callsite in `yjs-file-system.ts` must be audited (see Phase 4, step 4.11)

### `getAllPaths()` no longer needs root filtering

1. Currently: `Array.from(this.index.pathToId.keys()).filter((p) => p !== '/')`
2. After: `Array.from(this.index.pathToId.keys())`: root was only in `pathToId` because of the `pathToId.set('/', ROOT_ID)` line which is removed
3. The filter becomes unnecessary

### `exists('/')` still works

1. `exists` checks `resolved === '/' || this.index.pathToId.has(resolved)`
2. The `resolved === '/'` short-circuit handles root: no dependency on `pathToId` containing root

### Test casts with `as FileId`

1. Tests create rows with string literals like `'f1'`, `'d1'`
2. These need `as FileId` casts since `FileId` is a branded type
3. Consider a test helper: `const fid = (s: string) => s as FileId` to reduce noise

## Open Questions

1. **Should `getRow` accept `FileId` or `string`?**
   - `TableHelper.get()` accepts `string`. Narrowing `getRow` to `FileId` adds safety but means callers must prove they have a `FileId`, not just any string.
   - **Recommendation**: Accept `FileId`: it documents that you should never call `getRow` with a null/root value. The null guard happens at the callsite before `getRow`.

2. **Should `computePath` and internal index functions use `FileId`?**
   - These are private to `file-system-index.ts` and work with values from `FileRow.id` (which is now `FileId`).
   - **Recommendation**: Yes, update them. The types flow naturally from `FileRow`.

3. **Should `content-doc-pool.ts` internal map key be `FileId` or `string`?**
   - The pool uses `fileId` as a `Y.Doc` guid and as a map key. `Y.Doc({ guid: string })` accepts `FileId` via widening.
   - **Recommendation**: Use `FileId` for the internal map. It's consistent and the values are always file IDs.

## Success Criteria

- [ ] `bun test packages/epicenter/src/filesystem/` passes
- [ ] `bun run --filter epicenter typecheck` passes
- [ ] `ROOT_ID` constant no longer exists anywhere in the codebase
- [ ] No hardcoded `'__ROOT__'` strings remain
- [ ] All `string` file ID params in the filesystem package are `FileId`
- [ ] `childrenOf` map uses `null` key for root children

## References

- `packages/epicenter/src/filesystem/types.ts`: Core type definitions (primary target)
- `packages/epicenter/src/filesystem/file-system-index.ts`: Index building, ROOT_ID coalescing
- `packages/epicenter/src/filesystem/yjs-file-system.ts`: IFileSystem implementation, resolveId
- `packages/epicenter/src/filesystem/validation.ts`: assertUniqueName with hardcoded `'__ROOT__'`
- `packages/epicenter/src/filesystem/content-doc-pool.ts`: Doc pool with string fileId params
- `packages/epicenter/src/filesystem/index.ts`: Barrel exports
- `packages/epicenter/src/filesystem/file-table.ts`: Arktype schema (no changes, `id: 'string'` stays)
- `packages/epicenter/src/dynamic/schema/fields/id.ts`: `Guid` type and `generateGuid()`
- `packages/epicenter/src/filesystem/file-system-index.test.ts`: Index tests
- `packages/epicenter/src/filesystem/validation.test.ts`: Validation tests
- `packages/epicenter/src/filesystem/yjs-file-system.test.ts`: Integration tests (no changes expected)
- `packages/epicenter/src/filesystem/convert-on-switch.test.ts`: No changes expected
- `packages/epicenter/src/filesystem/markdown-helpers.test.ts`: No changes expected
