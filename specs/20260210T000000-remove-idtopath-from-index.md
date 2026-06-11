# Remove `idToPath` from FileSystemIndex

**Date**: 2026-02-10
**Status**: Draft
**Author**: AI-assisted
**Parent**: `specs/20260208T000000-yjs-filesystem-spec.md`

## Overview

Remove the `idToPath` map from `FileSystemIndex`. It's built on every rebuild but never read by any production code. The index shrinks to two maps: `pathToId` and `childrenOf`.

## Motivation

### Current State

```typescript
// types.ts
export type FileSystemIndex = {
    pathToId: Map<string, FileId>;
    idToPath: Map<FileId, string>;        // ← built but never read
    childrenOf: Map<FileId | null, FileId[]>;
};
```

```typescript
// file-system-index.ts: buildPaths()
pathToId.set(path, row.id);
idToPath.set(row.id, path);   // ← written here, never consumed
```

A grep across the entire codebase for `idToPath.get(` returns zero results. The only reads are in test assertions (`file-system-index.test.ts` lines 36, 48, 78) that verify the map is populated. They test that dead code works correctly.

### Why it exists

The original filesystem spec (`20260208T000000`) included `idToPath` for symmetry with `pathToId`. The branded-file-ids spec (`20260209T120000`) carried it forward. Neither spec added any consumer.

### Why the two surviving maps earn their place

Each provides a lookup the underlying `TableHelper` structurally cannot:

| Map | What it provides | Why the table can't |
|-----|-----------------|-------------------|
| `pathToId` | Full path → FileId resolution | Table stores `name` + `parentId`, not computed paths |
| `childrenOf` | Parent → children reverse lookup | Table only stores child → parent via `parentId` |

`idToPath` is the reverse of `pathToId`. If a use case ever needs it, iterating `pathToId` entries is O(n) where n is file count: sub-millisecond for any realistic workspace. Adding it back later is a one-line change in `buildPaths()`.

### Desired State

```typescript
export type FileSystemIndex = {
    pathToId: Map<string, FileId>;
    childrenOf: Map<FileId | null, FileId[]>;
};
```

Two maps. Each one derives something the table can't give you directly.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remove `idToPath` | Yes | Zero consumers in production code. Dead code that signals false importance to future readers. |
| Add it back later if needed | One-line change in `buildPaths()` | Not worth keeping speculatively. Let a real use case drive it. |
| `plaintext` | Already removed | Handled by `specs/20260209T000000-simplify-content-doc-lifecycle.md`. |

## Implementation Plan

### Phase 1: Remove from type and index builder

- [ ] **1.1** Remove `idToPath` from `FileSystemIndex` type in `types.ts`
- [ ] **1.2** Remove `idToPath` map creation (`new Map<FileId, string>()`) from `createFileSystemIndex()` in `file-system-index.ts`
- [ ] **1.3** Remove `idToPath.clear()` from `rebuild()`
- [ ] **1.4** Remove `idToPath` from `buildPaths()` function signature and the `idToPath.set(row.id, path)` call
- [ ] **1.5** Remove `idToPath` from the returned object

### Phase 2: Update tests

- [ ] **2.1** Remove `idToPath` assertions from `file-system-index.test.ts` (lines 36, 48, 78)
- [ ] **2.2** Verify all filesystem tests still pass

### Phase 3: Update specs (non-blocking)

- [ ] **3.1** Update `specs/20260209T120000-branded-file-ids.md` to remove `idToPath` references (status is Done, so this is just doc cleanup)
- [ ] **3.2** Update `specs/20260208T000000-yjs-filesystem-spec.md` architecture diagram and references

## Success Criteria

- [ ] `bun test packages/epicenter/src/filesystem/` passes
- [ ] `bun run --filter epicenter typecheck` passes
- [ ] No references to `idToPath` remain in production code (specs are documentation, not production)
- [ ] `FileSystemIndex` has exactly two maps: `pathToId` and `childrenOf`

## References

- `packages/epicenter/src/filesystem/types.ts`: Type definition (primary target)
- `packages/epicenter/src/filesystem/file-system-index.ts`: Index builder (remove map + writes)
- `packages/epicenter/src/filesystem/file-system-index.test.ts`: Test assertions to remove
- `packages/epicenter/src/filesystem/yjs-file-system.ts`: Confirm zero `idToPath` usage (already verified)
- `specs/20260209T000000-simplify-content-doc-lifecycle.md`: Prior art: removed `plaintext` map
- `specs/20260209T120000-branded-file-ids.md`: References `idToPath` in diagrams (doc cleanup)
