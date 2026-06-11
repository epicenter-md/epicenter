# Rename Document Binding Types

**Date**: 2026-02-21
**Status**: Complete
**Author**: AI-assisted

## Overview

Pure rename refactor across the document binding layer. Aligns type names, function names, local variables, and symbols with the new `documents` namespace introduced in the previous spec (`20260221T204200-documents-top-level-namespace.md`).

No behavior changes. No new types. No deleted types (beyond renames). No structural changes.

## Motivation

After moving document bindings to `client.documents`, the old names (`DocBinding`, `DocumentBinding`, `createDocument`, etc.) no longer matched the API surface. `DocBinding` described a single document's config, but read like it was the binding itself. `DocumentBinding` was the actual binding object but its name collided conceptually with the config. `createDocument` was singular but creates a namespace of bindings for a table.

The renames make each name self-documenting:

| Old Name                     | New Name                 | Why                                                                              |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `DocBinding`                 | `DocumentConfig`         | It's configuration for a document, not a binding                                 |
| `DocumentBinding`            | `Documents`              | Matches `client.documents.{table}.{doc}`: the object IS the documents namespace |
| `DOCUMENT_BINDING_ORIGIN`    | `DOCUMENTS_ORIGIN`       | Matches the `documents` namespace                                                |
| `createDocument()`           | `createDocuments()`      | Creates multiple document bindings for a table, not a single document            |
| `ExtractDocTags`             | `ExtractDocumentTags`    | Expands abbreviation for consistency                                             |
| `ExtractAllDocTags`          | `ExtractAllDocumentTags` | Same                                                                             |
| `CreateDocumentConfig`       | `CreateDocumentsConfig`  | Aligns with `createDocuments()`                                                  |
| `Symbol('document-binding')` | `Symbol('documents')`    | Matches the namespace name                                                       |

Local variable renames (`binding` → `documents`, `docBinding` → `documentConfig`, `documentBindingCleanups` → `documentCleanups`) follow from the type renames.

## Implementation Plan

### Phase 1: Type renames in types.ts

- [x] Rename `DocBinding` → `DocumentConfig`
- [x] Rename `DocumentBinding` → `Documents`
- [x] Rename `ExtractDocTags` → `ExtractDocumentTags`
- [x] Rename `ExtractAllDocTags` → `ExtractAllDocumentTags`

### Phase 2: Function and constant renames in create-document.ts

- [x] Rename `DOCUMENT_BINDING_ORIGIN` → `DOCUMENTS_ORIGIN`
- [x] Rename `CreateDocumentConfig` → `CreateDocumentsConfig`
- [x] Rename `createDocument()` → `createDocuments()`
- [x] Rename `Symbol('document-binding')` → `Symbol('documents')`

### Phase 3: Local variable renames in create-workspace.ts

- [x] Rename `docBinding` → `documentConfig`
- [x] Rename `binding` → `documents` (loop variable)
- [x] Rename `documentBindingCleanups` → `documentCleanups`
- [x] Update `createDocument` import → `createDocuments`

### Phase 4: Update re-exports

- [x] Update `workspace/index.ts`: `DocBinding` → `DocumentConfig`, `DocumentBinding` → `Documents`
- [x] Update `src/index.ts`: same changes

### Phase 5: Update consumers

- [x] `packages/filesystem/src/yjs-file-system.ts`: `DocumentBinding` → `Documents`
- [x] `packages/filesystem/src/content-helpers.ts`: `DocumentBinding` → `Documents`
- [x] `packages/epicenter/src/workspace/define-table.ts`: `DocBinding` → `DocumentConfig`
- [x] `create-document.test.ts`: all constant and function name updates
- [x] `create-workspace.test.ts`: `createDocument` → `createDocuments` in comment

### Phase 6: Verify

- [x] Grep for all old names: zero hits in `.ts` files
- [x] `bun typecheck`: no new errors
- [x] `bun test` in packages/epicenter: 336 pass, 0 fail
- [x] `bun test` at repo root: 813 pass, 0 fail

## Decisions

| Decision                                | Choice                            | Rationale                                                                     |
| --------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `DocsPropertyOf` rename                 | Skipped                           | Already deleted in previous spec's implementation (commit `fc065978a`)        |
| `createDocument` in `apps/tab-manager/` | Not renamed                       | That's `browser.offscreen.createDocument`: a browser API, not ours           |
| Historical spec files                   | Not rewritten                     | Old references are documentation history; specs record how the design evolved |
| LSP rename vs manual                    | Manual (`edit` with `replaceAll`) | LSP rename returned "Method not found" in this environment                    |

## Files Changed

| File                                                        | Changes                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/epicenter/src/workspace/types.ts`                 | `DocBinding` → `DocumentConfig`, `DocumentBinding` → `Documents`, `ExtractDocTags` → `ExtractDocumentTags`, `ExtractAllDocTags` → `ExtractAllDocumentTags`                                   |
| `packages/epicenter/src/workspace/create-document.ts`       | `DOCUMENT_BINDING_ORIGIN` → `DOCUMENTS_ORIGIN`, `CreateDocumentConfig` → `CreateDocumentsConfig`, `createDocument` → `createDocuments`, `Symbol('document-binding')` → `Symbol('documents')` |
| `packages/epicenter/src/workspace/create-document.test.ts`  | Updated all references to renamed constants and functions                                                                                                                                    |
| `packages/epicenter/src/workspace/create-workspace.ts`      | Local var renames (`docBinding`, `binding`, `documentBindingCleanups`), import update                                                                                                        |
| `packages/epicenter/src/workspace/create-workspace.test.ts` | Updated comment reference                                                                                                                                                                    |
| `packages/epicenter/src/workspace/define-table.ts`          | `DocBinding` → `DocumentConfig`                                                                                                                                                              |
| `packages/epicenter/src/workspace/index.ts`                 | Updated re-exports                                                                                                                                                                           |
| `packages/epicenter/src/index.ts`                           | Updated re-exports                                                                                                                                                                           |
| `packages/filesystem/src/yjs-file-system.ts`                | `DocumentBinding` → `Documents`                                                                                                                                                              |
| `packages/filesystem/src/content-helpers.ts`                | `DocumentBinding` → `Documents`                                                                                                                                                              |

## Review

### Summary

Pure rename refactor: 10 files changed, zero behavior changes. All type names, function names, constants, local variables, and symbols now align with the `client.documents` namespace introduced in the previous spec.

### Verification

- **Typecheck**: Zero new errors. Pre-existing errors in `@epicenter/filesystem` (`_v: number` vs `_v: 1` literal mismatches in test files) and `@epicenter/tab-manager` (`#/utils.js` module resolution) are unrelated.
- **Tests**: 813 pass, 0 fail, 2 skip across 52 files (full monorepo).
- **Grep sweep**: Zero hits for any old name (`DocBinding`, `DocumentBinding`, `DOCUMENT_BINDING_ORIGIN`, `createDocument` as our function, `ExtractDocTags`, `ExtractAllDocTags`, `CreateDocumentConfig`, `documentBindingCleanups`) in `.ts` files. Only historical `.md` spec files contain old references.
- **No `any` casts or `@ts-ignore` introduced**.
