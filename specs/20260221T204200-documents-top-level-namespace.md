# Top-Level `documents` Namespace

**Date**: 2026-02-21
**Status**: Complete
**Author**: AI-assisted

## Overview

Move document bindings from `client.tables.{table}.docs.{docName}` to a new top-level `client.documents.{table}.{docName}` namespace. This separates CRUD operations (tables) from Y.Doc lifecycle management (documents), removes the `DocsPropertyOf` intersection type entirely, kills the `FilesTableWithDocs` hand-rolled type, and cleans up the dead code that falls out.

## Motivation

### Current State

```typescript
// 4 dots to open a document
const handle = await ws.tables.files.docs.content.open(row);

// Passing a binding to helpers
const helpers = createContentHelpers(ws.tables.files.docs.content);

// Multi-doc tables
await ws.tables.notes.docs.body.open(row);
await ws.tables.notes.docs.cover.open(row);
```

The chain reads: "workspace, tables, files, docs, content, open." The `.docs` level exists solely to prevent name collisions between CRUD methods and document binding names, but it means document operations are subordinate to table operations in the hierarchy.

This creates problems:

1. **Depth**: Four property accesses to reach a document binding. Every consumer pays this cost.
2. **Mixed concerns**: `TablesHelper` is intersected with `DocsPropertyOf`, coupling row CRUD types to document lifecycle types. The type is harder to read and maintain.
3. **Discoverability**: Typing `ws.tables.files.` shows both CRUD methods (`get`, `set`, `delete`) and `docs` in the same autocomplete list. The concepts are distinct; the namespace doesn't reflect that.
4. **Workaround types**: Consumers like `yjs-file-system.ts` hand-roll `FilesTableWithDocs = TableHelper<FileRow> & { docs: { content: DocumentBinding<FileRow> } }` because there's no clean way to type "a table helper that has documents." This type is fragile and duplicates what `DocsPropertyOf` does internally.
5. **Test casts**: `create-workspace.test.ts` uses `(client.tables.files as TableWithDocs).docs` with an `any`-based test helper type because the conditional `DocsPropertyOf` intersection doesn't flow cleanly through test assertions.

### Desired State

```typescript
// 3 dots: documents are a peer of tables
const handle = await ws.documents.files.content.open(row);

// Helpers receive bindings directly
const helpers = createContentHelpers(ws.documents.files.content);

// Multi-doc
await ws.documents.notes.body.open(row);
await ws.documents.notes.cover.open(row);

// Tables are pure CRUD: no .docs property
ws.tables.files.get({ id: '1' });
ws.tables.files.docs; // ❌ Property 'docs' does not exist

// Tables without documents don't appear in ws.documents
ws.documents.tags; // ❌ Property 'tags' does not exist
```

Autocomplete on `ws.` now shows `tables`, `documents`, `kv`, `extensions`, `awareness`: each a distinct concern.

## Design Decisions

| Decision                            | Choice        | Rationale                                                                                                                                          |
| ----------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace name                      | `documents`   | Consistent with existing full-word naming (`tables`, `extensions`, `awareness`). Not `docs`: moving away from abbreviation.                       |
| Remove `.docs` from tables          | Yes           | Two paths to the same thing is worse than one. Clean break. Pre-1.0, all consumers in-monorepo.                                                    |
| `DocsPropertyOf` removal            | Yes           | The intersection type goes away entirely. `TablesHelper` becomes a plain mapped type.                                                              |
| `FilesTableWithDocs` removal        | Yes           | Dead type once `.docs` is removed from table helpers. `createYjsFileSystem` signature changes.                                                     |
| `TableWithDocs` test helper removal | Yes           | The `any`-based test helper type in `create-workspace.test.ts` is no longer needed. Tests access `client.documents` directly.                      |
| Definition side                     | No change     | `defineTable().withDocument()` stays the same. The runtime builder reads the same `docs` record from definitions and constructs the new namespace. |
| `createYjsFileSystem` signature     | Separate args | Takes `TableHelper<FileRow>` + `DocumentBinding<FileRow>` instead of `FilesTableWithDocs`. Narrow, testable, no bundled intersection type.         |
| Exported types                      | Remove + add  | Remove `DocsPropertyOf`. Add `DocumentsHelper`. `DocumentBinding` and `DocumentHandle` unchanged.                                                  |

## Architecture

### Before

```
WorkspaceClient
├── tables: TablesHelper<T>
│   ├── files: TableHelper<FileRow> & DocsPropertyOf<...>
│   │   ├── get(), set(), delete(), ...     (CRUD)
│   │   └── docs                             (document lifecycle)
│   │       └── content: DocumentBinding
│   └── tags: TableHelper<TagRow>            (no .docs: DocsPropertyOf = {})
├── kv: KvHelper<T>
├── extensions: TExtensions
└── awareness: AwarenessHelper<T>
```

### After

```
WorkspaceClient
├── tables: TablesHelper<T>                  ← SIMPLIFIED: plain mapped type
│   ├── files: TableHelper<FileRow>          ← pure CRUD, no .docs
│   └── tags: TableHelper<TagRow>
├── documents: DocumentsHelper<T>            ← NEW namespace
│   ├── files                                ← only tables with .withDocument()
│   │   └── content: DocumentBinding<FileRow>
│   └── notes
│       ├── body: DocumentBinding<NoteRow>
│       └── cover: DocumentBinding<NoteRow>
├── kv: KvHelper<T>
├── extensions: TExtensions
└── awareness: AwarenessHelper<T>
```

### Type Definitions

```typescript
// NEW: parallel to TablesHelper, only includes tables that have documents
type DocumentsHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions as HasDocs<TTableDefinitions[K]> extends true
		? K
		: never]: DocumentsOf<TTableDefinitions[K]>;
};

// Helper: does this table definition have non-empty docs?
type HasDocs<T> = T extends { docs: infer TDocs }
	? keyof TDocs extends never
		? false
		: true
	: false;

// Helper: extract the document binding map for one table
type DocumentsOf<T> = T extends {
	docs: infer TDocs;
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest extends BaseRow
		? { [K in keyof TDocs]: DocumentBinding<TLatest> }
		: never
	: never;
```

```typescript
// SIMPLIFIED TablesHelper: no more DocsPropertyOf intersection
type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};
```

### Runtime Construction (in create-workspace.ts)

The document binding creation loop already exists (lines 130-170). The change is where bindings get attached:

```
Before:  Object.defineProperty(tableHelper, 'docs', { value: docsNamespace })
After:   documentsNamespace[tableName] = docsNamespace
```

Then `documentsNamespace` is set on the client object alongside `tables`, `kv`, `extensions`.

## Implementation Plan

### Phase 1: Core type changes

Add the new types and property, then immediately remove the old ones. One atomic change, no transition period.

- [ ] **1.1** Add `DocumentsHelper`, `HasDocs`, `DocumentsOf` types to `types.ts`
- [ ] **1.2** Add `documents: DocumentsHelper<TTableDefinitions>` to `WorkspaceClient` type (line ~1073, alongside `tables`)
- [ ] **1.3** Remove `& DocsPropertyOf<TTableDefinitions[K]>` intersection from `TablesHelper` type (line ~705)
- [ ] **1.4** Delete `DocsPropertyOf` type from `types.ts` (lines 329-358): including JSDoc
- [ ] **1.5** Rewrite the `TablesHelper` JSDoc comment (line 700): remove "including .docs when declared", say "pure CRUD, no document bindings"

### Phase 2: Runtime construction

Modify `create-workspace.ts` to build the `documents` namespace instead of attaching `.docs` to table helpers.

- [ ] **2.1** Build a `documentsNamespace` object alongside the existing loop (lines 135-170 of `create-workspace.ts`)
- [ ] **2.2** Replace the `Object.defineProperty(tableHelper, 'docs', ...)` call with `documentsNamespace[tableName] = docsNamespace`
- [ ] **2.3** Pass `documentsNamespace` into `buildClient()` and set it as `documents` on the returned client object
- [ ] **2.4** Add `documents` to the `WorkspaceClientBuilder` type signature (line ~806)

### Phase 3: Export changes

- [ ] **3.1** Remove `DocsPropertyOf` from `workspace/index.ts` re-exports (line 156)
- [ ] **3.2** Remove `DocsPropertyOf` from `src/index.ts` re-exports (line 128)
- [ ] **3.3** Add `DocumentsHelper` to both `workspace/index.ts` and `src/index.ts`

### Phase 4: Migrate `packages/filesystem`

The filesystem package is the primary consumer. Signature changes here.

- [ ] **4.1** `yjs-file-system.ts`: Delete the `FilesTableWithDocs` type (lines 16-18)
- [ ] **4.2** `yjs-file-system.ts`: Change `createYjsFileSystem` signature from `(filesTable: FilesTableWithDocs)` to `(filesTable: TableHelper<FileRow>, contentBinding: DocumentBinding<FileRow>)`
- [ ] **4.3** `yjs-file-system.ts`: Update the body: `filesTable.docs.content` → `contentBinding`
- [ ] **4.4** `yjs-file-system.ts`: Update JSDoc on `createYjsFileSystem` to show new signature
- [ ] **4.5** `content-helpers.ts`: Update JSDoc example from `ws.tables.files.docs.content` → `ws.documents.files.content`
- [ ] **4.6** `yjs-file-system.test.ts`: Update `setup()`: pass `ws.documents.files.content` as second arg to `createYjsFileSystem`
- [ ] **4.7** `yjs-file-system.test.ts`: Update all 8 `ws.tables.files.docs.content` references → `ws.documents.files.content`
- [ ] **4.8** `markdown-helpers.test.ts`: Update `setup()`: same signature change

### Phase 5: Migrate `apps/fs-explorer`

- [ ] **5.1** `fs-state.svelte.ts`: Change `createYjsFileSystem(ws.tables.files)` → `createYjsFileSystem(ws.tables.files, ws.documents.files.content)`
- [ ] **5.2** `fs-state.svelte.ts`: Change both `ws.tables.files.docs.content.open(id)` calls → `ws.documents.files.content.open(id)`

### Phase 6: Migrate `packages/epicenter` tests

- [ ] **6.1** `create-workspace.test.ts`: Delete the `TableWithDocs` type helper (lines 23-26): no longer needed
- [ ] **6.2** `create-workspace.test.ts`: Rewrite all `(client.tables.files as TableWithDocs).docs` → `client.documents.files` (6 call sites: lines 502, 540, 633, 670, 671)
- [ ] **6.3** `create-workspace.test.ts`: Rewrite `(client.tables.notes as any).docs` → `client.documents.notes` (line 599)
- [ ] **6.4** `create-workspace.test.ts`: Rewrite the "table without withDocument" test: instead of checking `docs` is undefined, verify that `'posts' in client.documents` is false (or check `Object.keys(client.documents)` doesn't include `'posts'`)
- [ ] **6.5** `define-table.test.ts`: No changes. The `withDocument` describe block tests the definition-level `docs` record (e.g., `files.docs.content.guid`). These are testing `defineTable()` output, not the workspace client.

### Phase 7: Update JSDoc and documentation

- [ ] **7.1** `types.ts`: Update `DocumentBinding` JSDoc: change "Most users access this via `client.tables.files.docs.content`" → `client.documents.files.content`
- [ ] **7.2** `types.ts`: Update the old `DocsPropertyOf` JSDoc example references now embedded in `DocumentBinding` (lines 288, 339, 342)
- [ ] **7.3** `define-table.ts`: Update JSDoc on `withDocument` method: change "becomes a property under `.docs`" → "becomes a property under `client.documents.{tableName}`"
- [ ] **7.4** `create-document.ts`: Update module-level JSDoc if it mentions `.docs.content` access pattern
- [ ] **7.5** `packages/epicenter/README.md`: Search-and-replace all `client.tables.*.docs.*` patterns → `client.documents.*.*`
- [ ] **7.6** `packages/epicenter/src/workspace/README.md`: Update any `.docs.` references in code examples

### Phase 8: Dead code and simplification sweep

Everything here is cleanup that falls out from the structural change.

- [ ] **8.1** **Delete `DocsPropertyOf` re-export comments**: `workspace/index.ts` has a `// Document binding types` comment section that listed it. Clean up the comment grouping.
- [ ] **8.2** **Unexport `StringKeysOf` / `NumberKeysOf`**: These utility types are only used internally by `define-table.ts` for `withDocument()` constraints. No external consumer imports them. Remove from `workspace/index.ts` and `src/index.ts` re-exports (keep the type definitions: `define-table.ts` still needs them).
- [ ] **8.3** **Grep for stale `.docs.` references**: Run `grep -r '\.docs\.' --include='*.ts' --include='*.md'` across the entire repo. Every remaining hit should be either (a) definition-level (`defineTable(...).docs`) which is internal, or (b) unrelated (internal `Map` variables named `docs` in `create-document.ts`). Flag anything else.
- [ ] **8.4** **Grep for `DocsPropertyOf`**: Should have zero hits outside of this spec and historical specs.
- [ ] **8.5** **Grep for `FilesTableWithDocs`**: Should have zero hits. Confirm deletion complete.
- [ ] **8.6** **Grep for `TableWithDocs`**: Should have zero hits in test files. Confirm deletion complete.
- [ ] **8.7** **Check `AnyWorkspaceClient` type** (line 1152 of types.ts): It's `WorkspaceClient<any, any, any, any, any>`. Since `WorkspaceClient` now has a `documents` property, `AnyWorkspaceClient` automatically picks it up. Verify no manual update needed.
- [ ] **8.8** **Check `describe-workspace.ts`**: Uses `AnyWorkspaceClient` for introspection. Grep for `.tables.*.docs` access. If it accesses `.docs` anywhere, update to `.documents`.
- [ ] **8.9** **Update stale specs**: Add a one-line note at the top of each:
  - `specs/20260217T094400-table-level-document-api.md`: Original document API spec. The `DocsPropertyOf` design section and access pattern examples are outdated.
  - `specs/20260220T195900-document-handle-api.md`: References `tables.files.docs.content` throughout.
  - `specs/20260219T094400-migrate-filesystem-to-document-binding.md`: References `ws.tables.files.docs.content` and `FilesTableWithDocs`.
  - Note format: `> **Note**: The .docs access pattern described here was replaced by client.documents: see specs/20260221T204200-documents-top-level-namespace.md`

### Phase 9: Verify

- [ ] **9.1** `bun test`: All tests pass
- [ ] **9.2** `bun check`: No new type errors (pre-existing filesystem `_v` literal mismatches are known)
- [ ] **9.3** Final grep sweep: zero hits for `DocsPropertyOf`, `FilesTableWithDocs`, `TableWithDocs` outside of specs and this plan
- [ ] **9.4** Autocomplete spot-check: Verify in editor that `ws.documents.` shows only tables with documents, and `ws.tables.files.` does NOT show `docs`

## Edge Cases

### Table with no documents

Tables without `.withDocument()` calls don't appear in `ws.documents` at all. The `HasDocs` conditional type filters them out via key remapping (`as HasDocs<...> extends true ? K : never`). TypeScript errors if you try `ws.documents.tags`.

### Workspace with no documents at all

If no tables use `.withDocument()`, `ws.documents` is an empty object `{}`. The property still exists on the client (not conditionally absent like the old `.docs` was): it's just empty. No autocomplete properties.

### Library code receiving a table helper

`createYjsFileSystem` currently takes `FilesTableWithDocs` (a hand-rolled intersection type). After this change, it takes two separate args:

```typescript
// Before
function createYjsFileSystem(filesTable: FilesTableWithDocs) {
	const content = createContentHelpers(filesTable.docs.content);
}

// After: separate args, narrow types, no intersection
function createYjsFileSystem(
	filesTable: TableHelper<FileRow>,
	contentBinding: DocumentBinding<FileRow>,
) {
	const content = createContentHelpers(contentBinding);
}
```

Call sites update from:

```typescript
createYjsFileSystem(ws.tables.files);
```

To:

```typescript
createYjsFileSystem(ws.tables.files, ws.documents.files.content);
```

### createDocument() internals

`createDocument()` doesn't change. It still receives a `tableHelper` ref for `updatedAt` observer wiring. The only change is where the returned `DocumentBinding` gets attached: on `documentsNamespace[tableName]` instead of via `Object.defineProperty` on the table helper.

### define-table.test.ts: definition-level `.docs`

The `defineTable().withDocument()` tests check the definition object's `.docs` property (e.g., `files.docs.content.guid`). These are testing the schema definition, not the workspace client. They stay unchanged. The definition-level `docs` record is internal plumbing, only the runtime surface changes.

## Open Questions

1. **Should `StringKeysOf` / `NumberKeysOf` be unexported?**
   - Only consumed internally by `define-table.ts`. No external package imports them.
   - **Recommendation**: Unexport. Less public API surface is better. Re-export later if needed.

2. **Should we rename the internal `docs` property on `TableDefinition`?**
   - `defineTable().withDocument()` accumulates into a `docs` record on the definition object. It's read by the workspace builder, not by consumers.
   - **Recommendation**: Leave as-is. Internal plumbing. Renaming adds churn with no user-facing benefit.

3. **Should old specs get full rewrites or just a superseded note?**
   - Three specs reference the old access pattern heavily.
   - **Recommendation**: One-line note at the top. Don't rewrite historical specs: they're useful as a record of how the design evolved.

## Success Criteria

- [ ] `ws.documents.files.content.open(row)` works with full type safety
- [ ] `ws.documents.tags` is a TypeScript error (tags table has no documents)
- [ ] `ws.tables.files.docs` is a TypeScript error (tables no longer have .docs)
- [ ] `TablesHelper` type is a plain mapped type: no intersection with anything
- [ ] `DocsPropertyOf` type does not exist anywhere in the codebase (outside specs)
- [ ] `FilesTableWithDocs` type does not exist anywhere in the codebase
- [ ] `TableWithDocs` test helper does not exist anywhere in the codebase
- [ ] All existing tests pass after migration
- [ ] `bun check` passes (no new type errors)
- [ ] Zero new `any` casts or `@ts-ignore` introduced

## Exhaustive Impact Map

Every file that changes, and what changes in it:

| File                                                        | Change                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/epicenter/src/workspace/types.ts`                 | Add `DocumentsHelper`, `HasDocs`, `DocumentsOf`. Remove `DocsPropertyOf`. Simplify `TablesHelper`. Add `documents` to `WorkspaceClient` and `WorkspaceClientBuilder`. Update JSDoc. |
| `packages/epicenter/src/workspace/create-workspace.ts`      | Build `documentsNamespace` object. Remove `Object.defineProperty(..., 'docs', ...)`. Pass `documents` to client builder.                                                            |
| `packages/epicenter/src/workspace/index.ts`                 | Remove `DocsPropertyOf` export. Add `DocumentsHelper` export. Remove `StringKeysOf`/`NumberKeysOf` exports.                                                                         |
| `packages/epicenter/src/index.ts`                           | Same export changes as above.                                                                                                                                                       |
| `packages/epicenter/src/workspace/define-table.ts`          | Update JSDoc referencing `.docs` → `.documents`.                                                                                                                                    |
| `packages/epicenter/src/workspace/create-document.ts`       | Update JSDoc if it references `.docs.content`.                                                                                                                                      |
| `packages/epicenter/src/workspace/create-workspace.test.ts` | Delete `TableWithDocs` type. Rewrite 7 `.docs` access sites → `client.documents`.                                                                                                   |
| `packages/epicenter/src/workspace/define-table.test.ts`     | No changes: tests definition-level `docs`, not client-level.                                                                                                                       |
| `packages/filesystem/src/yjs-file-system.ts`                | Delete `FilesTableWithDocs`. Change `createYjsFileSystem` signature to 2 args.                                                                                                      |
| `packages/filesystem/src/yjs-file-system.test.ts`           | Update `setup()` and 8 binding reference sites.                                                                                                                                     |
| `packages/filesystem/src/markdown-helpers.test.ts`          | Update `setup()` call.                                                                                                                                                              |
| `packages/filesystem/src/content-helpers.ts`                | Update JSDoc example.                                                                                                                                                               |
| `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`            | Update `createYjsFileSystem` call. Update 2 `.docs.content` accesses.                                                                                                               |
| `packages/epicenter/README.md`                              | Search-and-replace `.docs.` patterns in code examples.                                                                                                                              |
| `packages/epicenter/src/workspace/README.md`                | Update any `.docs.` references in code examples.                                                                                                                                    |
| 3 historical specs                                          | Add one-line superseded note at top.                                                                                                                                                |

## References

- `packages/epicenter/src/workspace/types.ts`: `DocsPropertyOf` (line 345), `TablesHelper` (line 701), `DocumentBinding` (line 303), `WorkspaceClient` (line 1055)
- `packages/epicenter/src/workspace/create-workspace.ts`: Runtime `.docs` attachment (lines 130-170)
- `packages/epicenter/src/workspace/define-table.ts`: `withDocument()` builder
- `packages/epicenter/src/workspace/create-document.ts`: `createDocument()` factory (internals unchanged)
- `packages/filesystem/src/yjs-file-system.ts`: `FilesTableWithDocs` type (line 16), `createYjsFileSystem` (line 48)
- `packages/filesystem/src/content-helpers.ts`: Receives `DocumentBinding` directly
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: UI-layer usage (lines 40, 237, 253)
- `packages/epicenter/src/workspace/create-workspace.test.ts`: `TableWithDocs` helper (line 23), 7 `.docs` access sites
- `specs/20260217T094400-table-level-document-api.md`: Original document API spec (to be marked superseded)
- `specs/20260220T195900-document-handle-api.md`: Document handle spec (to be marked superseded)
- `specs/20260219T094400-migrate-filesystem-to-document-binding.md`: Filesystem migration spec (to be marked superseded)
- `specs/20260221T204300-remove-document-binding-dead-code.md`: Recent dead code cleanup (completed, context only)

## Review

### Summary of Changes

Moved document bindings from `client.tables.{table}.docs.{docName}` to `client.documents.{table}.{docName}` across the entire codebase. This is a breaking API change that separates CRUD operations from Y.Doc lifecycle management.

### What Changed

**Types** (`types.ts`):

- Added `DocumentsHelper`, `HasDocs`, `DocumentsOf` mapped types for the new `client.documents` namespace
- Removed `DocsPropertyOf` intersection type (was bolted onto `TablesHelper`)
- Simplified `TablesHelper` to a plain mapped type (no more conditional `.docs` attachment)
- Added `documents` property to both `WorkspaceClient` and `ExtensionContext`

**Runtime** (`create-workspace.ts`):

- Built `documentsNamespace` object eagerly during workspace creation
- Replaced `Object.defineProperty(tableHelper, 'docs', ...)` with namespace population
- Cast `documentsNamespace` to `DocumentsHelper<TTableDefinitions>` at the two usage sites (client object and extension context)

**Exports** (`workspace/index.ts`, `src/index.ts`):

- Removed `DocsPropertyOf`, `StringKeysOf`, `NumberKeysOf` from public API
- Added `DocumentsHelper` to public API

**Filesystem package** (`yjs-file-system.ts`):

- Deleted `FilesTableWithDocs` hand-rolled type
- Changed `createYjsFileSystem` to accept 2 args: `(filesTable, contentBinding)` instead of a typed table-with-docs

**App layer** (`fs-state.svelte.ts`):

- Updated `createYjsFileSystem` call to pass `client.documents.files.content` as second arg
- Changed all `.docs.content` accesses to use `client.documents.files.content`

**Tests**:

- Deleted `TableWithDocs` helper type from `create-workspace.test.ts`
- Rewrote all `.docs` access sites to `client.documents`
- Updated filesystem test setup functions

**Docs**:

- Updated JSDoc on `DocumentBinding`, `.withDocument()`, and `content-helpers.ts`
- Added superseded notes to 3 historical specs

### Verification

- **Tests**: 813 pass, 0 fail, 2 skip (pre-existing)
- **Typecheck**: 0 new errors. 8 pre-existing errors in `packages/filesystem/src/validation.test.ts` (`_v: number` vs `_v: 1` literal)
- **Grep sweep**: Zero hits for `DocsPropertyOf`, `FilesTableWithDocs`, `TableWithDocs` in `.ts` files
- **`describe-workspace.ts`**: No `.tables.*.docs` access: reads from `client.definitions` only
- **`AnyWorkspaceClient`**: Inherits `documents` from `WorkspaceClient` automatically
