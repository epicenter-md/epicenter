# Move `client.documents` Under `client.tables`

**Date**: 2026-04-20
**Status**: Implemented
**Author**: AI-assisted
**Branch**: braden-w/document-primitive

## Overview

Relocate the per-table document managers from the top-level `client.documents.<tableName>.<docName>` namespace to live underneath the table they belong to, as `client.tables.<tableName>.documents.<docName>`. This is a breaking API change across apps, tests, and docs.

## Motivation

### Current State

Today, the workspace client exposes two parallel top-level namespaces:

```ts
client.tables.files                             // Table<FileRow>
client.documents.files.content.read(fileId)     // Documents<FileRow, Timeline>
```

The declaration site says documents belong *to* their table:

```ts
defineTable(fileSchema)
  .withDocument('content', { guid: 'id', onUpdate: () => ({ updatedAt: now() }) })
```

But the access path puts them in an unrelated sibling namespace.

This creates problems:

1. **Declaration and access paths don't match.** `.withDocument()` reads as "add this doc to the table", but `client.documents.x.y` reads as "documents live next to tables." A reader has to hold the cross-reference in their head.
2. **The relationship is invisible at the call site.** `client.documents.files.content.read(id)` doesn't communicate that the document is bound to the `files` table; the relationship is only visible in the schema.
3. **Documents are 1:1 with rows by construction** (`guidKey` is a column of the row, enforced by `ClaimedDocumentColumns` at `types.ts:185-187`). The flat top-level namespace hides this coupling.

### Desired State

```ts
// Row CRUD
client.tables.files.findById(id)

// Content access: clearly bound to the table
client.tables.files.documents.content.read(id)
client.tables.notes.documents.body.get(noteId)
```

One extra hop; relationship becomes syntactic.

## Research Findings

### Call site audit

Exhaustive scan across `.ts`, `.tsx`, `.svelte`, `.svelte.ts`, `.md` files. 40+ hits grouped by category below.

**Production code (11 call sites, 7 files):**

| File | Lines | Nature |
| --- | --- | --- |
| `packages/skills/src/workspace.ts` | 95, 118, 123 | `client.documents.skills.instructions.read`, `client.documents.references.content.read` |
| `packages/skills/src/node.ts` | 135, 165, 196, 211 | `.write` / `.read` across skills+references |
| `packages/filesystem/src/extensions/sqlite-index/index.ts` | 147 | `context.documents.files.content` (inside extension: note: `context` here is a workspace client, same shape) |
| `apps/opensidian/src/lib/client.ts` | 230 | passed as arg to `createYjsFileSystem` |
| `apps/opensidian/src/lib/components/editor/ContentEditor.svelte` | 27 | `.get(fileId)`: reactive |
| `apps/skills/src/lib/components/editor/InstructionsEditor.svelte` | 7 | `.get(skillId)` |
| `apps/skills/src/lib/components/editor/ReferencesPanel.svelte` | 13 | `.get(expandedRefId)` |
| `apps/honeycrisp/src/routes/+page.svelte` | 13 | `.get(viewState.selectedNoteId)` |

**Workspace package source (types + runtime + JSDoc):**

| File | Lines | Nature |
| --- | --- | --- |
| `packages/workspace/src/workspace/types.ts` | 336-391, 399-403, 441-453, 470-478, 615 | type definitions (`Documents`, `HasDocuments`, `DocumentsOf`, `DocumentsHelper`, `WorkspaceClient.documents`) |
| `packages/workspace/src/workspace/types.ts` | 288, 313, 397, 464, 467 | JSDoc examples |
| `packages/workspace/src/workspace/create-workspace.ts` | 208, 212, 215-244, 247, 302 | construction loop, typed cast, client assembly |
| `packages/workspace/src/workspace/define-table.ts` | 79, 85 | JSDoc referring to `client.documents.{tableName}[name]` |
| `packages/workspace/src/workspace/create-documents.ts` | 21, 37, 190-197 | JSDoc examples |

**Tests (8 files):**

| File | Lines |
| --- | --- |
| `packages/filesystem/src/file-system.test.ts` | 20, 395, 405, 417, 436, 451 |
| `packages/filesystem/src/formats/markdown.test.ts` | 158 |
| `packages/workspace/src/workspace/create-workspace.test.ts` | 498, 510, 511, 538, 577, 615, 640, 681-684 |
| `playground/opensidian-e2e/epicenter.config.ts` | 63 |
| `playground/opensidian-e2e/push-from-markdown.ts` | 90 |
| `playground/opensidian-e2e/epicenter.config.test.ts` | 106, 111, 198, 216, 231, 278, 285 |

**Code-in-string (UI-displayed examples):**

| File | Lines |
| --- | --- |
| `apps/opensidian/src/routes/about/+page.svelte` | 76, 105 |

**JSDoc in other packages:**

| File | Lines |
| --- | --- |
| `packages/filesystem/src/file-system.ts` | 35 |
| `packages/skills/src/tables.ts` | 39, 43, 84 |

**READMEs:**

| File | Lines |
| --- | --- |
| `packages/workspace/README.md` | 321, 323, 325-330, 336, 522, 529-530, 1460 |
| `packages/filesystem/README.md` | 28 |
| `docs/architecture.md` | 110, 262 |

**Articles (prose):**

| File | Lines |
| --- | --- |
| `docs/articles/your-data-is-probably-a-table-not-a-file.md` | 61 |

**Specs (not migrated: historical records of past decisions):** 15 spec files under `specs/` contain references, but these are point-in-time artifacts. We do NOT edit them; they document the state at the time they were written.

### Deliberately excluded from migration

- `packages/workspace/src/workspace/define-table.test.ts:259-313`: accesses `tableDefinition.documents` (the config map on the definition object, not the runtime namespace). Unrelated: stays as-is.
- `specs/*.md` references: historical artifacts. Not migrated.
- `.withDocument` and `.withDocumentExtension` builder names: these keep their names because they build/register under the table, which is consistent with the new access path.

### Key structural constraint

`Tables<TTableDefinitions>` is defined in `packages/document/src/types.ts:252-254` as a plain mapped-type alias, NOT an interface. It cannot be augmented via declaration merging.

```ts
// packages/document/src/types.ts:252-254
export type Tables<TTableDefinitions extends TableDefinitions> = {
  [K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};
```

This forces a choice: modify the `Tables` source (couples document package to workspace concerns) or define a richer workspace-local `WorkspaceTables<...>` type that intersects per-table. See Design Decisions.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| New access path | `client.tables.<name>.documents.<docName>` | Access mirrors declaration; no collision surface with Table methods; documents clearly scoped to their table. |
| Top-level `client.documents` | **Remove entirely** | Clean break. User has confirmed willingness to migrate ~20 call sites. Keeping an alias doubles the type surface and invites drift. |
| How to type `client.tables.<name>` with documents | Define workspace-local `WorkspaceTables<TTableDefinitions>` that maps each table to `Table<TRow>` (pass-through) OR `Table<TRow> & { documents: DocumentsOf<...> }` when the table has `.withDocument()` declarations | Keeps `packages/document` pure (no workspace concerns leak in). Workspace overlays the richer type at the boundary it owns. |
| Filter tables without documents | No `documents` key at all on those entries | Matches current `HasDocuments` filter in `DocumentsHelper`. Using `.documents` on a table without docs should be a compile-time error. |
| Runtime merge strategy | After building `tables` and per-table documents maps, merge in place: `tables[name].documents = perTableDocs[name]` | One additional assignment per table with documents. Simple. Avoids rebuilding the tables object. |
| Internal naming in `create-workspace.ts` | Keep `documentsNamespace` as the intermediate accumulator; rename the final cast to reflect merging | Minimal diff inside the builder. |
| Test assertion `Object.keys(client.documents)` | Rewrite to inspect `client.tables.<name>.documents` existence | Preserves the intent of the assertion (which tables have documents). |
| Code-string examples (about page) | Update to match new API | Ships as documentation UX. |
| Article prose | Update to new API | Articles reflect the current API, not historical. |

## Architecture

### Before

```
WorkspaceClient
├── tables              Tables<TTableDefinitions>
│   ├── files           Table<FileRow>
│   └── notes           Table<NoteRow>
├── documents           DocumentsHelper<TTableDefinitions>
│   ├── files
│   │   └── content     Documents<FileRow, Timeline>
│   └── notes
│       └── body        Documents<NoteRow, RichText>
├── kv
├── awareness
└── ...
```

### After

```
WorkspaceClient
├── tables              WorkspaceTables<TTableDefinitions>
│   ├── files           Table<FileRow> & { documents: { content: Documents<FileRow, Timeline> } }
│   │   ├── findById, update, insert, ...   (Table methods)
│   │   └── documents
│   │       └── content Documents<FileRow, Timeline>
│   └── notes           Table<NoteRow> & { documents: { body: Documents<NoteRow, RichText> } }
│       ├── findById, update, insert, ...
│       └── documents
│           └── body    Documents<NoteRow, RichText>
├── kv
├── awareness
└── ...
```

Tables without `.withDocument()` declarations keep the plain `Table<TRow>` shape (no `.documents` key).

### Type construction

```
STEP 1: Keep DocumentsOf<T> unchanged
────────────────────────────────────
  DocumentsOf<TTableDef> yields { [docName]: Documents<TRow, TBinding> }

STEP 2: New WorkspaceTables<TTableDefinitions>
────────────────────────────────────
  For each K in TTableDefinitions:
    if HasDocuments<TTableDefinitions[K]>:
      Table<TRow> & { documents: DocumentsOf<TTableDefinitions[K]> }
    else:
      Table<TRow>

STEP 3: WorkspaceClient.tables: WorkspaceTables<TTableDefinitions>
──────────────────────────────────────────
  DocumentsHelper and WorkspaceClient.documents are deleted.
```

### Runtime construction

```
STEP 1: Build tables (unchanged)
────────────────────────────────
  tables = { files: tableHelper, notes: tableHelper, ... }

STEP 2: Build per-table documents (unchanged loop)
────────────────────────────────
  for each [tableName, tableDef]:
    for each [docName, rawConfig]:
      perTableDocs[docName] = createDocuments({ tableHelper: tables[tableName], ... })

STEP 3: Merge (NEW)
────────────────────────────────
  for each [tableName, docs] in perTableDocs:
    (tables[tableName] as any).documents = docs
  // cast result as WorkspaceTables<TTableDefinitions>

STEP 4: Client assembly
────────────────────────────────
  const client = { tables, kv, awareness, ... }  // NO `documents` key
```

## Implementation Plan

### Phase 1: Types (foundational; nothing compiles until done)

- [ ] **1.1** In `packages/workspace/src/workspace/types.ts`, define `WorkspaceTables<TTableDefinitions>` (conditional mapped type: intersects `Table<TRow>` with `{ documents: DocumentsOf<T> }` when `HasDocuments<T>` is true, else plain `Table<TRow>`).
- [ ] **1.2** Change `WorkspaceClient.tables` from `Tables<TTableDefinitions>` to `WorkspaceTables<TTableDefinitions>` (~`types.ts:613`).
- [ ] **1.3** Delete `WorkspaceClient.documents` field (~`types.ts:615`).
- [ ] **1.4** Delete `DocumentsHelper<TTableDefinitions>` (~`types.ts:470-478`). `Documents`, `DocumentsOf`, `HasDocuments` are still used by `WorkspaceTables`: keep them.
- [ ] **1.5** Update JSDoc comments in `types.ts` (lines 288, 313, 397, 464, 467) to show the new access path.

### Phase 2: Runtime construction

- [ ] **2.1** In `create-workspace.ts` (~lines 215-244), after the existing `documentsNamespace` build loop, merge each `documentsNamespace[tableName]` onto `tables[tableName].documents`.
- [ ] **2.2** Remove the `typedDocuments` cast (~line 246-247) and the `documents: typedDocuments` assignment in `buildClient` (~line 302).
- [ ] **2.3** Cast the merged tables object as `WorkspaceTables<TTableDefinitions>` where the flat `Tables<>` cast exists today.
- [ ] **2.4** Update JSDoc comments in `create-documents.ts` (~lines 21, 37, 190-197) and `define-table.ts` (~lines 79, 85) to show new access path.

### Phase 3: Production consumers (in parallel, isolated per-file)

- [ ] **3.1** `packages/skills/src/workspace.ts`: rewrite 3 call sites (L95, 118, 123).
- [ ] **3.2** `packages/skills/src/node.ts`: rewrite 4 call sites (L135, 165, 196, 211).
- [ ] **3.3** `packages/skills/src/tables.ts`: update JSDoc (L39, 43, 84).
- [ ] **3.4** `packages/filesystem/src/extensions/sqlite-index/index.ts`: rewrite L147 (`context.documents.files.content` → `context.tables.files.documents.content`).
- [ ] **3.5** `packages/filesystem/src/file-system.ts`: update JSDoc (L35).
- [ ] **3.6** `apps/opensidian/src/lib/client.ts`: rewrite L230.
- [ ] **3.7** `apps/opensidian/src/lib/components/editor/ContentEditor.svelte`: rewrite L27.
- [ ] **3.8** `apps/skills/src/lib/components/editor/InstructionsEditor.svelte`: rewrite L7.
- [ ] **3.9** `apps/skills/src/lib/components/editor/ReferencesPanel.svelte`: rewrite L13.
- [ ] **3.10** `apps/honeycrisp/src/routes/+page.svelte`: rewrite L13.
- [ ] **3.11** `apps/opensidian/src/routes/about/+page.svelte`: rewrite the code strings on L76, L105 (displayed examples).

### Phase 4: Tests

- [ ] **4.1** `packages/filesystem/src/file-system.test.ts`: rewrite 6 call sites.
- [ ] **4.2** `packages/filesystem/src/formats/markdown.test.ts`: rewrite L158.
- [ ] **4.3** `packages/workspace/src/workspace/create-workspace.test.ts`: rewrite 8 call sites, including the `Object.keys(client.documents)` assertions at L510-511 (rewrite to assert `.documents` presence on specific table entries).
- [ ] **4.4** `playground/opensidian-e2e/epicenter.config.ts`: rewrite L63.
- [ ] **4.5** `playground/opensidian-e2e/push-from-markdown.ts`: rewrite L90.
- [ ] **4.6** `playground/opensidian-e2e/epicenter.config.test.ts`: rewrite 4 direct call sites (L106, 111, 216, 285) plus 3 object-forwarding sites (L198, 231, 278). The forwarding sites likely need the ctx type adjusted: see Edge Cases.

### Phase 5: Docs

- [ ] **5.1** `packages/workspace/README.md`: rewrite API examples (L321-330, 336, 522, 529-530, 1460).
- [ ] **5.2** `packages/filesystem/README.md`: rewrite L28.
- [ ] **5.3** `docs/architecture.md`: rewrite L110, L262.
- [ ] **5.4** `docs/articles/your-data-is-probably-a-table-not-a-file.md`: rewrite L61.

### Phase 6: Verify

- [ ] **6.1** `bun run check` passes across the workspace (type errors = caught migrations we missed).
- [ ] **6.2** `bun test` passes in every package.
- [ ] **6.3** Grep for `\.documents\.` across non-spec files: should yield zero matches to the old pattern outside the workspace internal types and the `.withDocument(` / `.withDocumentExtension(` builder methods.
- [ ] **6.4** Grep for `WorkspaceClient.documents` type references: should yield zero matches.
- [ ] **6.5** Manually smoke-test opensidian editor and honeycrisp page (Svelte reactive bindings).

## Edge Cases

### `playground/opensidian-e2e/epicenter.config.test.ts` object forwarding

Lines 198, 231, 278 have `documents: client.documents`: forwarding the whole documents namespace as a property on some config/context object. With the new shape there is no single aggregate `documents` object to forward.

1. Investigate what shape the downstream consumer expects.
2. If it expects `client.documents.<table>.<doc>` style access, either (a) change the downstream consumer to accept `tables` instead, or (b) build a derived object `Object.fromEntries(Object.entries(client.tables).map(([k, v]) => [k, v.documents]).filter(Boolean))` as a shim.
3. Recommendation: (a): update the downstream consumer. No compatibility shims.

### `Object.keys(client.documents)` assertion pattern

`create-workspace.test.ts:510-511` asserts which tables expose documents by reading `Object.keys(client.documents)`. Rewrite to:

```ts
const tablesWithDocs = Object.keys(client.tables).filter(
  (name) => 'documents' in client.tables[name],
);
expect(tablesWithDocs).toEqual([...]);
```

### Extension context `.documents` access

`sqlite-index/index.ts:147` uses `context.documents.files.content`. Verify whether `context` is a `WorkspaceClient` (inherits the new shape automatically) or a different type that also needs updating. If `DocumentContext` (the per-doc extension setup context) has its own `.documents` field, that's a separate migration: flag it.

### Table with no `.withDocument()` calls

Accessing `.documents` on such a table should be a compile-time error (no `documents` key on the intersection). Verify by adding a negative type test: `// @ts-expect-error` against `client.tables.<tableWithoutDocs>.documents`.

### Forward compatibility: adding docs later

If a user calls `.withDocument()` later in the builder chain, the `WorkspaceTables` type should pick it up automatically because `HasDocuments` checks the final `TDocuments` value. Verify with a type-only test.

## Open Questions

1. **Should we keep a deprecated `client.documents` alias for one release?**
   - Options: (a) clean break, (b) keep as `@deprecated` alias pointing to the same underlying objects.
   - **Recommendation**: (a) clean break. Epicenter is pre-1.0, the call-site count is small, and aliases rot unnoticed. User has already signed off on the migration cost.

2. **Should `WorkspaceTables` live in `packages/document` or stay in `packages/workspace`?**
   - Options: (a) workspace-only, (b) move into document package.
   - **Recommendation**: (a). Document package stays pure: it has no concept of `Documents<TRow>` runtime managers or the `.withDocument()` builder. Workspace overlays the richer shape.

3. **Internal runtime naming: keep `documentsNamespace` or rename to `perTableDocuments`?**
   - Nomenclature churn vs. accuracy.
   - **Recommendation**: rename to `perTableDocuments`: it's a transient accumulator, not a "namespace" anymore.

4. **Do we update historical spec files in `specs/`?**
   - **Recommendation**: no. They are point-in-time artifacts.

## Success Criteria

- [ ] Zero references to `client.documents.` / `workspace.documents.` / `ctx.documents.` / `ws.documents.` / `context.documents.` remain in non-spec production and test code.
- [ ] `WorkspaceClient.documents` field removed from the type.
- [ ] `DocumentsHelper<...>` type removed.
- [ ] `WorkspaceTables<TTableDefinitions>` type added and used on `WorkspaceClient.tables`.
- [ ] All packages typecheck (`bun run check`).
- [ ] All tests pass (`bun test`).
- [ ] JSDoc examples across packages/workspace, packages/skills, packages/filesystem show the new access path.
- [ ] READMEs and `docs/articles/your-data-is-probably-a-table-not-a-file.md` show the new access path.
- [ ] Opensidian editor, honeycrisp page, and skills editor visually smoke-test clean.

## References

### Core types
- `packages/workspace/src/workspace/types.ts:336-391, 397-403, 441-453, 470-478, 595-748`: all type definitions related to documents + WorkspaceClient
- `packages/document/src/types.ts:252-254`: `Tables<TTableDefinitions>` (leave alone)

### Runtime
- `packages/workspace/src/workspace/create-workspace.ts:145-162, 215-244, 246-247, 297-377`: table + documents construction and client assembly
- `packages/workspace/src/workspace/create-documents.ts`: unchanged internally
- `packages/workspace/src/workspace/define-table.ts:112-139, 242-271`: `.withDocument` builder (unchanged)

### Consumers (see Implementation Plan for full list)
- `packages/skills/src/{workspace,node,tables}.ts`
- `packages/filesystem/src/{file-system.ts,extensions/sqlite-index/index.ts}`
- `apps/{opensidian,skills,honeycrisp}/...`
- `playground/opensidian-e2e/...`

### Tests
- `packages/workspace/src/workspace/create-workspace.test.ts`: primary coverage of namespace shape
- `packages/filesystem/src/file-system.test.ts`: consumer-side usage
- `playground/opensidian-e2e/epicenter.config.test.ts`: full-stack

### Docs
- `packages/workspace/README.md`
- `packages/filesystem/README.md`
- `docs/architecture.md`
- `docs/articles/your-data-is-probably-a-table-not-a-file.md`
