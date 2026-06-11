# Remove Document Binding Dead Code

**Date**: 2026-02-21
**Status**: Complete
**Branch**: `chore/remove-document-binding-dead-code`

## Overview

Remove dead methods and unused exports from the `DocumentBinding` / `DocumentHandle` API surface.

## Audit Results

Exhaustive grep of every method on `DocumentBinding<TRow>` and `DocumentHandle` across the entire monorepo (apps/, packages/, tests).

### `DocumentBinding<TRow>`: 4 methods

| Method         | Production callers                                             | Test callers                     | Verdict                            |
| -------------- | -------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `open(input)`  | `content-helpers.ts` (4 sites), `fs-state.svelte.ts` (2 sites) | `create-document.test.ts` (many) | **KEEP**: core API                |
| `close(input)` | `create-document.ts` internal (row deletion cleanup)           | `create-document.test.ts`        | **KEEP**: needed for cleanup      |
| `closeAll()`   | `create-workspace.ts` (workspace destroy wiring)               | `create-document.test.ts`        | **KEEP**: needed for shutdown     |
| `guidOf(row)`  | **0 production callers**                                       | 1 test                           | **REMOVE**: dead column extractor |

### `DocumentHandle`: 4 properties

| Property      | Production callers                                                                                     | Test callers                        | Verdict                         |
| ------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------- |
| `ydoc`        | `content-helpers.ts` (4 sites: `{ ydoc } = await binding.open()`), `yjs-file-system.test.ts` (4 sites) | `create-document.test.ts` (many)    | **KEEP**: core escape hatch    |
| `read()`      | `fs-state.svelte.ts` (1 site: `handle.read()`)                                                         | `create-document.test.ts` (3 sites) | **KEEP**: used in app          |
| `write(text)` | `fs-state.svelte.ts` (1 site: `handle.write(data)`)                                                    | `create-document.test.ts` (3 sites) | **KEEP**: used in app          |
| `exports`     | **0 production callers**                                                                               | `create-document.test.ts` (many)    | **KEEP**: extensions need this |

Note on `exports`: While it has no callers today, it's the mechanism for document extensions to surface data. Any future extension (persistence, sync) will use it. It's part of the extension contract, not dead weight.

### Exported constants/types

| Symbol                    | External importers (outside epicenter pkg)                                               | Verdict                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `DOCUMENT_BINDING_ORIGIN` | **0**: only used internally in `create-document.ts` (2 sites: set origin, check origin) | **UNEXPORT**: keep as internal, remove from public API |
| `CreateDocumentConfig`    | **0**: only used internally by `createDocument()` and its tests                         | **UNEXPORT**: keep as internal, remove from public API |
| `createDocument`          | `create-workspace.ts` (1 site), `create-workspace.test.ts` (1 site)                      | **UNEXPORT**: internal wiring only, not a public API   |
| `DocumentBinding` type    | `yjs-file-system.ts`, `content-helpers.ts`                                               | **KEEP**: needed by filesystem pkg                     |
| `DocumentHandle` type     | **0 external importers**: but it's the return type of `open()`                          | **KEEP**: consumers use it implicitly                  |
| `DocBinding` type         | Internal only (define-table.ts, create-workspace.ts, types.ts)                           | **KEEP**: schema-level wiring type                     |

## Plan

### Phase 1: Remove `guidOf`

- [x] Remove `guidOf` from `DocumentBinding` type in `types.ts`
- [x] Remove `guidOf` implementation from `create-document.ts`
- [x] Remove `guidOf` test from `create-document.test.ts`
- [x] Remove `guidOf` assertion from `create-workspace.test.ts`

### Phase 2: Unexport internal symbols

- [x] Remove `DOCUMENT_BINDING_ORIGIN` from `workspace/index.ts` re-exports
- [x] Remove `DOCUMENT_BINDING_ORIGIN` from `src/index.ts` re-exports
- [x] Remove `CreateDocumentConfig` from `workspace/index.ts` re-exports
- [x] Remove `CreateDocumentConfig` from `src/index.ts` re-exports
- [x] Remove `createDocument` from `workspace/index.ts` re-exports
- [x] Remove `createDocument` from `src/index.ts` re-exports

### Phase 3: Update specs and docs

- [x] Update `specs/20260221T204200-rename-doc-binding-types.md`: remove `guidOf` from the proposed `Documents` type
- [x] Update `specs/20260220T195900-document-handle-api.md`: note guidOf removal in review

### Phase 4: Verify

- [x] `bun test` passes: 201 tests, 0 failures
- [x] `bun typecheck`: pre-existing errors in filesystem package only, no new errors from these changes

## What this does NOT change

- `open()`, `close()`, `closeAll()`: all have real callers
- `handle.ydoc`, `handle.read()`, `handle.write()`, `handle.exports`: all kept
- `DOCUMENT_BINDING_ORIGIN` still exists in `create-document.ts`: just no longer public
- `createDocument` still exists: just no longer re-exported (it's internal wiring)
- `DocBinding`, `DocumentBinding`, `DocumentHandle` types: all kept

## Success Criteria

- [x] `guidOf` does not appear on `DocumentBinding` type or implementation
- [x] `DOCUMENT_BINDING_ORIGIN`, `CreateDocumentConfig`, `createDocument` not in public exports
- [x] `bun test` passes (201 tests, 0 failures)
- [x] Specs updated to not reference `guidOf` as part of the current API

## Review

### Files changed

| File                                                        | Change                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/epicenter/src/workspace/types.ts`                 | Removed `guidOf(row: TRow): string` from `DocumentBinding` type                         |
| `packages/epicenter/src/workspace/create-document.ts`       | Removed `guidOf` method from binding object                                             |
| `packages/epicenter/src/workspace/create-document.test.ts`  | Removed `describe('guidOf', ...)` test block                                            |
| `packages/epicenter/src/workspace/create-workspace.test.ts` | Removed `guidOf` function-existence assertion                                           |
| `packages/epicenter/src/workspace/index.ts`                 | Removed re-exports: `DOCUMENT_BINDING_ORIGIN`, `CreateDocumentConfig`, `createDocument` |
| `packages/epicenter/src/index.ts`                           | Same removals from root package exports                                                 |
| `specs/20260221T204200-rename-doc-binding-types.md`         | Removed `guidOf` from proposed `Documents` type                                         |
| `specs/20260220T195900-document-handle-api.md`              | Updated method counts, noted `guidOf` removal                                           |

### Notes

- **Typecheck**: Pre-existing errors exist in `packages/filesystem/` (unrelated `_v` literal type mismatches in test fixtures). No new errors introduced by this change.
- **`DOCUMENT_BINDING_ORIGIN`** still exists in `create-document.ts` as an internal symbol. Only the public re-export was removed.
- **`createDocument`** still exists as an internal factory. `create-workspace.ts` imports it directly via relative path, unaffected by the export removal.
