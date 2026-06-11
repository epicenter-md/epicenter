# Collapse the document framework: delete `.withDocument`, unify `.withExtension`

**Date**: 2026-04-20
**Status**: Draft
**Author**: AI-assisted (Braden + Claude)
**Branch**: `braden-w/document-primitive`
**Follows**: `specs/20260420T220000-simplify-definedocument-primitive.md`
**Followed by**: `specs/20260420T230200-workspace-as-definedocument.md`

## TL;DR

Three workspace-builder concepts: `.withDocument(slot, config)` on tables, `.withDocumentExtension(key, factory)` on the workspace builder, and `.withWorkspaceExtension(key, factory)` on the workspace builder: all exist because the framework used to own Y.Doc construction for content docs. They were the registry users couldn't reach by hand. Now that `defineDocument` lets apps own content-doc construction directly (see `specs/20260420T220000-simplify-definedocument-primitive.md`, Implemented), those concepts lose their reason to exist.

This spec deletes `.withDocument` and `.withDocumentExtension`, renames/collapses the extension surface to a single `.withExtension`, deletes `packages/workspace/src/workspace/create-documents.ts` (493 LOC of parallel lifecycle), deletes `packages/workspace/src/workspace/strategies.ts`, and migrates the 5 `.withDocument` call sites to app-owned `buildContentDoc` functions wrapped in `defineDocument`. Apps own the `onLocalUpdate` listeners that bump parent-row `updatedAt`: no more framework config. Net delta: ~900 LOC deleted, ~150 LOC added across 5 apps.

## Motivation

### Current state

**Table-level document declaration** (`.withDocument`): 5 call sites, all identical shape:

```ts
// apps/fuji/src/lib/workspace.ts:110
.withDocument('content', {
  content: richText,
  guid: 'id',
  onUpdate: () => ({ updatedAt: DateTimeString.now() }),
});

// apps/honeycrisp/src/lib/workspace/definition.ts:107
.withDocument('body', { content: richText, guid: 'id', onUpdate: () => ({ updatedAt: DateTimeString.now() }) });

// packages/filesystem/src/table.ts:21
.withDocument('content', { content: timeline, guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }) });

// packages/skills/src/tables.ts:61
.withDocument('instructions', { content: plainText, guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }) });

// packages/skills/src/tables.ts:96
.withDocument('content', { content: plainText, guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }) });
```

**Workspace-level extension registration**: three overlapping methods on the builder (see `packages/workspace/src/workspace/types.ts:808-875`):

```ts
.withExtension(key, factory)              // registers factory for BOTH workspace AND document scope
.withWorkspaceExtension(key, factory)     // workspace-scope only (has full awareness/tables/kv context)
.withDocumentExtension(key, factory)      // document-scope only (gets per-document context: tableName, guidKey, etc.)
```

**Parallel lifecycle implementation**: `packages/workspace/src/workspace/create-documents.ts` (493 LOC) is a full reimplementation of the `defineDocument` cache: keyed `openDocuments: Map<string, DocEntry>`, `bindCount`, `disconnectTimer`, `disposed`, `whenLoaded`/`whenDisposed` aggregation. It does not use `defineDocument`. It exists because `.withDocument` needs a cache but the workspace framework predates the user-owned primitive.

**Strategy wrapping**: `packages/workspace/src/workspace/strategies.ts` wraps each `content: <strategy>` with encryption and framework hooks. Only exists because the framework constructs the Y.Doc for the user.

### Problems

1. **Three extension concepts where one suffices.** `.withExtension` already supports both scopes (per types.ts:547: "registers the same factory for both scopes"). `.withWorkspaceExtension` and `.withDocumentExtension` are narrower variants whose distinction only matters because `.withDocumentExtension` gets per-document context (`tableName`, `documentName`, `guidKey`): context that vanishes when users construct docs themselves.
2. **Duplicated lifecycle machinery.** `create-documents.ts` reimplements the refcount+grace+aggregation that `defineDocument` now owns. Two copies, two chances for bugs, two places to fix them.
3. **Framework smell: users can't reach their own construction site.** To inject a custom provider into a content doc, you call `.withDocumentExtension('myProvider', factory)` and hope the factory's context is enough. If you want to compose two attachments in a specific order, or skip one for a specific doc type, the registry model doesn't let you.
4. **`strategies.ts` wraps content strategies with encryption and hooks.** Its existence is entirely a consequence of "the framework owns Y.Doc construction." Delete the framework ownership and the wrapping layer has nothing to do.
5. **`onUpdate` is a framework configuration for a user-owned concern.** Bumping `updatedAt` when a content doc changes is application logic. Encoding it as a config shape (`onUpdate: () => ({ updatedAt: ... })`) is indirection: the user writes a function that returns a patch object that the framework applies to the parent row. Replace with a direct `onLocalUpdate(ydoc, () => table.update(rowId, { updatedAt: now() }))` in the user's builder.
6. **Tight coupling between tables and documents.** A table with `.withDocument('content')` auto-gets a `tables.foo.documents.content` namespace. That's magic the user didn't opt into. If you want a document without a table row (e.g., a shared collaborative canvas), the coupling fights you.

### Desired state

Apps own their content-doc construction directly:

```ts
// apps/fuji/src/lib/entry-content-doc.ts
import { attachIndexedDb, attachRichText, attachSync, onLocalUpdate, defineDocument } from '@epicenter/document';
import * as Y from 'yjs';
import type { EntryId } from './ids.js';
import { fujiWorkspace } from './workspace.js';

function buildEntryContentDoc(rowId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,
  });
  const content = attachRichText(ydoc);
  const idb     = attachIndexedDb(ydoc);
  const sync    = attachSync(ydoc, { url: ... });

  // User owns the updatedAt writeback: no framework config.
  onLocalUpdate(ydoc, () => {
    fujiWorkspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() });
  });

  return {
    ydoc, content, idb, sync,
    whenReady:    Promise.all([idb.whenLoaded, sync.whenSynced]).then(() => {}),
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

export const entryContentDocs = defineDocument(buildEntryContentDoc, { gcTime: 30_000 });
```

Workspace builder has a single extension method:

```ts
const client = createWorkspace({ id: 'my-app', tables: { entries } })
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }));
```

No `.withDocument`. No `.withDocumentExtension`. No `.withWorkspaceExtension`. No `create-documents.ts`. No `strategies.ts`.

## Research Findings

### Blast radius: 5 call sites, same shape

| File | Slot | Strategy | Update field |
|---|---|---|---|
| `apps/fuji/src/lib/workspace.ts:110` | `content` | `richText` | `updatedAt: DateTimeString.now()` |
| `apps/honeycrisp/src/lib/workspace/definition.ts:107` | `body` | `richText` | `updatedAt: DateTimeString.now()` |
| `packages/filesystem/src/table.ts:21` | `content` | `timeline` | `updatedAt: Date.now()` |
| `packages/skills/src/tables.ts:61` | `instructions` | `plainText` | `updatedAt: Date.now()` |
| `packages/skills/src/tables.ts:96` | `content` | `plainText` | `updatedAt: Date.now()` |

All five use `guid: 'id'` (the `id` column is the guid source). Every one is a mechanical migration.

### `.withDocumentExtension` production usage: zero

Grep confirms: only defined at `packages/workspace/src/workspace/types.ts:851` and referenced in `create-workspace.test.ts`. No app code calls it. Pure deletion.

### `.withExtension` already subsumes the scope distinction

`packages/workspace/src/workspace/types.ts:547` explicitly states the semantics: `.withExtension` "registers the same factory for both scopes." So `.withWorkspaceExtension` is just `.withExtension` minus document-scope, and `.withDocumentExtension` is `.withExtension` minus workspace-scope. Once documents are user-owned, both scoped variants lose meaning and fold back into `.withExtension`.

### Deletion scope estimate

| File | Action | LOC delta |
|---|---|---|
| `packages/workspace/src/workspace/create-documents.ts` | Delete | -493 |
| `packages/workspace/src/workspace/create-documents.test.ts` | Delete | -varies |
| `packages/workspace/src/workspace/strategies.ts` | Delete | -~150 |
| `packages/workspace/src/workspace/create-workspace.ts` | Shrink (remove document plumbing + two scoped extension methods) | -~200 |
| `packages/workspace/src/workspace/types.ts` | Shrink (remove document-related types) | -~100 |
| `packages/document/src/attach-table.ts` | Remove `.withDocument(slot, config)` chain method | -~30 |
| `apps/fuji/src/lib/entry-content-doc.ts` (new) | New file per app | +~40 |
| `apps/honeycrisp/src/lib/note-body-doc.ts` (new) | New file per app | +~40 |
| `packages/filesystem/src/file-content-doc.ts` (new) | New file | +~40 |
| `packages/skills/src/skill-instructions-doc.ts` (new) | New file | +~40 |
| `packages/skills/src/reference-content-doc.ts` (new) | New file | +~40 |
| Table definition files | Remove `.withDocument(...)` chain call | -5 call sites |
| **Net**                | | **~-800 to -1000 LOC** |

## Design Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | `.withDocument(slot, config)` | **Delete.** Users write `defineDocument(buildFn)` per doc type. | The registry only existed because framework owned Y.Doc construction. Spec 20260420T220000 inverted that; registry is now dead weight. |
| 2 | `.withDocumentExtension` | **Delete.** | Zero production usage. Pure scaffolding. |
| 3 | `.withWorkspaceExtension` | **Delete.** Collapse into `.withExtension`. | Distinction only matters in a world with document scope. |
| 4 | `.withExtension` | **Keep.** Single extension method on the workspace builder. | Already does the right thing; just drop the scoped variants. |
| 5 | `create-documents.ts` | **Delete.** Apps call `defineDocument(buildFn)` directly. | Parallel lifecycle is the largest concrete win. |
| 6 | `strategies.ts` | **Delete.** Users compose attachments directly. | Wrapping layer only existed because framework constructed. |
| 7 | `onUpdate` config | **Delete.** Users call `onLocalUpdate(ydoc, () => table.update(rowId, {...}))`. | Direct code beats config schema. Filter semantics already live in `@epicenter/document`. |
| 8 | `tables.foo.documents.content` namespace | **Delete.** Each app exports its own `xxxContentDocs` factory. | The auto-namespace was only a convenience for `.withDocument`. |
| 9 | `content` strategies (`richText`, `plainText`, `timeline`) | **Keep.** Users pass them as attachments (`attachRichText(ydoc)`). | Strategies themselves are fine; only the framework wrapping is the smell. |
| 10 | Encryption of content docs | **User composes it.** `attachEncryption(ydoc, {...})` at the app level, same as workspace (see Spec C). | Same pattern as workspace; no special-casing. |
| 11 | Migration strategy | **Big-bang PR.** 5 call sites migrate in one PR. | Small number of sites; interim state (two APIs) would be worse than the PR size. |
| 12 | Barrel exports | **Update `packages/workspace/src/index.ts`.** Remove `createDocuments` export. |: |
| 13 | `lifecycle.ts` | **Keep** (`defineExtension`, `disposeLifo`, `startDisposeLifo`). Still used by remaining extensions and the workspace disposer. | Spec C revisits this; for Spec B, extensions still need LIFO teardown. |
| 14 | `createDocuments` advanced-user public API | **Remove.** | Advanced users now use `defineDocument` directly. |
| 15 | Tests touching deleted concepts | **Delete** (not migrate). | The concepts don't exist; tests for them are noise. |

## Architecture

### Before

```text
  ┌──────────────────────────────────────────────────────────────┐
  │  Workspace builder                                           │
  │    .withExtension(k, f)               ← unified              │
  │    .withWorkspaceExtension(k, f)      ← workspace-only       │
  │    .withDocumentExtension(k, f)       ← document-only        │
  │    .withActions(fn)                                          │
  │                                                              │
  │  Table builder                                               │
  │    .withDocument(slot, { content, guid, onUpdate })          │
  │         │                                                    │
  │         ▼                                                    │
  │  createDocuments({...}) ────┐                                │
  │    parallel DocEntry,       │                                │
  │    bindCount,               │                                │
  │    disconnectTimer,         │                                │
  │    disposed,                │                                │
  │    whenLoaded aggregation   │                                │
  │                             ▼                                │
  │                       strategies.ts                          │
  │                       encryption + hooks                     │
  └──────────────────────────────────────────────────────────────┘
```

### After

```text
  ┌──────────────────────────────────────────────────────────────┐
  │  Workspace builder                                           │
  │    .withExtension(k, f)     ← only one extension method      │
  │    .withActions(fn)                                          │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────┐
  │  App-side per doc type:                                      │
  │                                                              │
  │    function buildFooContentDoc(rowId) {                      │
  │      const ydoc = new Y.Doc({ guid: ... });                  │
  │      const content = attachRichText(ydoc);                   │
  │      const idb  = attachIndexedDb(ydoc);                     │
  │      const sync = attachSync(ydoc, { ... });                 │
  │      onLocalUpdate(ydoc, () => workspace.tables.foo.update(  │
  │        rowId, { updatedAt: now() }));                        │
  │      return { ydoc, content, idb, sync,                      │
  │        whenReady, whenDisposed, [Symbol.dispose] };          │
  │    }                                                         │
  │                                                              │
  │    export const fooContentDocs = defineDocument(             │
  │      buildFooContentDoc, { gcTime: 30_000 });                │
  └──────────────────────────────────────────────────────────────┘
```

### Migration: one end-to-end example (fuji)

**Before** (`apps/fuji/src/lib/workspace.ts:110`):

```ts
export const entriesTable = defineTable(...)
  .migrate(...)
  .withDocument('content', {
    content: richText,
    guid: 'id',
    onUpdate: () => ({ updatedAt: DateTimeString.now() }),
  });

// usage (today, framework-wired):
ws.tables.entries.documents.content.get(rowId)  // returns handle with .bind(), .read(), .write()
```

**After**:

```ts
// apps/fuji/src/lib/workspace.ts
export const entriesTable = defineTable(...)
  .migrate(...); // no .withDocument

// apps/fuji/src/lib/entry-content-doc.ts (new file)
import { attachIndexedDb, attachRichText, attachSync, onLocalUpdate, defineDocument } from '@epicenter/document';
import * as Y from 'yjs';
import { fujiWorkspace } from './workspace.js';
import type { EntryId } from './ids.js';

function buildEntryContentDoc(rowId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,
  });
  const content = attachRichText(ydoc);
  const idb     = attachIndexedDb(ydoc);
  const sync    = attachSync(ydoc, {
    url: (docId) => websocketUrl(`${APP_URLS.API}/docs/${docId}`),
    getToken: () => auth.token,
    waitFor: idb.whenLoaded,
  });

  onLocalUpdate(ydoc, () => {
    fujiWorkspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() });
  });

  return {
    ydoc, content, idb, sync,
    whenReady:    Promise.all([idb.whenLoaded, sync.whenConnected]).then(() => {}),
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

export const entryContentDocs = defineDocument(buildEntryContentDoc, { gcTime: 30_000 });

// usage:
using h = entryContentDocs.open(rowId);
await h.whenReady;
h.content.write('hello');
```

Four more sites (`honeycrisp/note-body-doc`, `filesystem/file-content-doc`, `skills/skill-instructions-doc`, `skills/reference-content-doc`) follow the identical template: change attachment (`attachRichText` / `attachPlainText` / `attachTimeline`), change guid prefix, change `workspace.tables.X.update(...)` target. Otherwise mechanical.

## Implementation Plan

### Phase 1: New `.withExtension` API surface

- [ ] **1.1** In `packages/workspace/src/workspace/types.ts`, remove the type declarations for `withWorkspaceExtension` and `withDocumentExtension` on `WorkspaceClientBuilder`. Keep `withExtension` as the sole extension chainable.
- [ ] **1.2** Remove the `DocumentExtensionRegistration`, `DocumentConfig`, `DocumentContext`, related helper types that exist only for the deleted features.
- [ ] **1.3** Update the "Extension context" JSDoc on `ExtensionContext`: it should no longer mention document-scope.

### Phase 2: Delete `.withDocument` from the table builder

- [ ] **2.1** Remove `.withDocument(slot, config)` chain method from `packages/document/src/attach-table.ts` (or wherever `defineTable` returns its builder).
- [ ] **2.2** Remove the `documents` sub-namespace auto-population in the `Tables<...>` type (`packages/workspace/src/workspace/types.ts`).
- [ ] **2.3** Grep for `.withDocument(`: zero results in `packages/` + `apps/` after Phase 5.

### Phase 3: Delete `.withDocumentExtension` and `.withWorkspaceExtension`

- [ ] **3.1** Remove the methods' implementations from `packages/workspace/src/workspace/create-workspace.ts`. They're in the `buildClient()` closure (~line 300-450 area, alongside `withExtension`).
- [ ] **3.2** In `create-workspace.test.ts`, delete any test suite exercising `withDocumentExtension` or `withWorkspaceExtension`. Migrate tests that exercise `withExtension` for document-scope behavior to simply use `withExtension`.

### Phase 4: Delete `create-documents.ts` and `strategies.ts`

- [ ] **4.1** Delete `packages/workspace/src/workspace/create-documents.ts` (493 LOC).
- [ ] **4.2** Delete `packages/workspace/src/workspace/create-documents.test.ts`.
- [ ] **4.3** Delete `packages/workspace/src/workspace/strategies.ts`.
- [ ] **4.4** Remove `createDocuments` import + usage from `create-workspace.ts`.
- [ ] **4.5** Remove `createDocuments` export from `packages/workspace/src/index.ts` (if exported).

### Phase 5: Migrate 5 call sites

Each migration follows the same pattern. For each:

1. Remove `.withDocument(...)` from the `defineTable` chain.
2. Create a new file `<domain>-<slot>-doc.ts` colocated with the table.
3. Define `build<Domain><Slot>Doc(rowId)` returning `{ ydoc, content, idb, sync, whenReady, whenDisposed, [Symbol.dispose] }`.
4. Export `<domain><Slot>Docs = defineDocument(build..., { gcTime: 30_000 })`.
5. Update all call sites that used `ws.tables.<table>.documents.<slot>.get(id)` to `<table><Slot>Docs.open(id)`.

- [ ] **5.1** `apps/fuji/src/lib/workspace.ts:110` → `apps/fuji/src/lib/entry-content-doc.ts`.
- [ ] **5.2** `apps/honeycrisp/src/lib/workspace/definition.ts:107` → `apps/honeycrisp/src/lib/note-body-doc.ts`.
- [ ] **5.3** `packages/filesystem/src/table.ts:21` → `packages/filesystem/src/file-content-doc.ts`.
- [ ] **5.4** `packages/skills/src/tables.ts:61` → `packages/skills/src/skill-instructions-doc.ts`.
- [ ] **5.5** `packages/skills/src/tables.ts:96` → `packages/skills/src/reference-content-doc.ts`.
- [ ] **5.6** For each migrated doc, grep every downstream caller (components, queries, mutations) and update to the new factory.open() API.

### Phase 6: Verification

- [ ] **6.1** `bun test` in `packages/workspace`, `packages/document`, `packages/filesystem`, `packages/skills`. All pass.
- [ ] **6.2** `bun run build` at repo root. Clean.
- [ ] **6.3** `bun run typecheck` in `apps/fuji`, `apps/honeycrisp`. Clean.
- [ ] **6.4** Grep zero results: `.withDocument(`, `.withDocumentExtension(`, `.withWorkspaceExtension(`, `createDocuments(`, `DocumentExtensionRegistration`, `DocumentConfig`, `strategies.ts`.
- [ ] **6.5** Manually smoke-test fuji: create an entry, type into content, reload, verify persistence. Open two tabs, verify sync.

## Edge Cases

### Downstream callers using `ws.tables.foo.documents.bar.read(id)`

Old call: `await ws.tables.entries.documents.content.read(rowId)` (framework-wired sugar).
New call: `using h = entryContentDocs.open(rowId); await h.whenReady; return h.content.read();`.

Callers doing just a read (no mount/unmount) are shorter with a helper: expose a `readEntryContent(rowId)` that opens, awaits, reads, disposes.

### Row deletion → orphaned content doc

Before: `createDocuments` had a `close(rowOrGuid)` method callers had to invoke on row delete. Same contract still applies, just on the new factory: call `entryContentDocs.close(rowId)` when the row is deleted. Document this in the per-doc-type file's JSDoc.

### Workspace disposal → content docs

Before: workspace dispose called `closeAll()` on every documents manager. After: each app's content-doc factory is app-scoped; apps call `await entryContentDocs.closeAll()` in their own teardown paths (or rely on process exit). Document in per-app README.

### Encryption for content docs

Before: `strategies.ts` wrapped each Y.Text/Y.XmlFragment with encryption and the framework activated keys via `applyEncryptionKeys`. After: content docs use the same `attachEncryption(ydoc, { stores })` pattern as workspace (see Spec C). Apps compose it into their builder.

### Schema migration on persisted content

Content Y.Docs don't have versioned rows; they're Y.Text / Y.XmlFragment / timeline. No migration needed at this layer. Row-level migration (the `_v` column on parent tables) is unchanged: still handled by `defineTable(...).migrate()`.

### `onUpdate` edge case: transport-origin filtering

Before: framework filtered out transport-origin updates when deciding whether to fire `onUpdate` (prevents timestamp ping-pong across tabs). After: user calls `onLocalUpdate(ydoc, ...)`: the filter lives in `@epicenter/document/on-local-update.ts` and is now explicitly user-visible. Make sure migration snippets use `onLocalUpdate`, not raw `ydoc.on('updateV2', ...)`.

### Factory declaration + workspace circular import

`buildEntryContentDoc` reads from `fujiWorkspace.tables.entries` in its `onLocalUpdate` callback. The factory file imports the workspace module, which (in some setups) may import the table definition back. Resolve with lazy access inside the callback (which already happens. The lambda captures the reference at call time, not module-init time).

## Open Questions

1. **Do we keep `createDocuments` as an internal helper for `.withDocument` legacy support?**
   - **Recommendation**: No. Full deletion. The primitive (`defineDocument`) is the replacement.

2. **Migration strategy: per-app PR or big-bang PR?**
   - Options: (a) migrate one app at a time over several PRs, keeping `.withDocument` live during transition; (b) single PR that deletes the framework and migrates all five sites.
   - **Recommendation**: (b) big-bang. Only 5 sites. Transitional state is confusing.

3. **Do we keep the `.documents` sub-namespace on `Tables<...>` type as a helper (`ws.tables.entries.documents`) for some sugar?**
   - **Recommendation**: No. Direct factory export (`entryContentDocs.open(rowId)`) is clearer and doesn't require the workspace builder to know about content docs.

4. **What's the naming convention for per-doc-type files?**
   - Recommendation: `<domain>-<slot>-doc.ts` in the same directory as the table. Export `build<Domain><Slot>Doc` (builder) and `<domain><Slot>Docs` (factory).

5. **Encryption for content docs: does it ship in this spec or the next?**
   - **Recommendation**: Stub in this spec (apps compose `attachEncryption` if they need it). Full migration of encryption architecture lives in Spec C (where workspace itself moves to `defineDocument`).

6. **What happens to `packages/workspace/src/workspace/lifecycle.ts` (`defineExtension`, `disposeLifo`)?**
   - **Recommendation**: Keep. Extensions still exist and still need LIFO teardown. Spec C revisits.

## Success Criteria

- [ ] Grep for `.withDocument(` returns zero results in non-archived files.
- [ ] Grep for `.withDocumentExtension(` returns zero results.
- [ ] Grep for `.withWorkspaceExtension(` returns zero results.
- [ ] `packages/workspace/src/workspace/create-documents.ts` deleted.
- [ ] `packages/workspace/src/workspace/strategies.ts` deleted.
- [ ] Five new `build<Domain><Slot>Doc` + factory exports exist, one per migrated call site.
- [ ] `bun test` passes in `packages/workspace`, `packages/document`, `packages/filesystem`, `packages/skills`.
- [ ] `bun run build` passes at repo root.
- [ ] `bun run typecheck` passes in `apps/fuji`, `apps/honeycrisp`.
- [ ] Fuji smoke test: create entry, type content, reload, verify persistence + sync.
- [ ] Net LOC delta: ~800-1000 lines deleted.

## Non-Goals

- **Workspace-as-defineDocument.** That's Spec C (`specs/20260420T230200-workspace-as-definedocument.md`). This spec keeps `createWorkspace` as-is except for removing the three deleted builder methods.
- **y-websocket teardown audit.** That's Spec A (`specs/20260420T230000-y-websocket-teardown-fix.md`). Independent; ships in parallel or before.
- **Changes to `defineDocument` primitive.** It's already shipped (Implemented spec from 20260420T220000).
- **Changes to `@epicenter/sync` or crypto primitives.** This spec is about workspace framework collapse only.
- **Migration of existing persisted data.** Guid prefixes used for content docs should match whatever `.withDocument('content', { guid: 'id' })` produced (typically `<workspaceId>.<tableName>.<rowId>.<slot>`). Preserve the guid string exactly to keep persisted Y.Docs aligned.

## References

### Files modified

- `packages/workspace/src/workspace/create-workspace.ts`: remove `withWorkspaceExtension` and `withDocumentExtension` implementations; remove `createDocuments` wiring; shrink to ~400 LOC.
- `packages/workspace/src/workspace/types.ts`: remove document-related types; keep `WorkspaceClientBuilder.withExtension` and `.withActions` only.
- `packages/workspace/src/index.ts`: barrel updates.
- `packages/document/src/attach-table.ts`: remove `.withDocument(slot, config)` chain.
- Per-app table files: remove `.withDocument(...)` chain invocations (5 sites).

### Files deleted

- `packages/workspace/src/workspace/create-documents.ts` (493 LOC)
- `packages/workspace/src/workspace/create-documents.test.ts`
- `packages/workspace/src/workspace/strategies.ts`
- `packages/workspace/src/workspace/strategies.test.ts` (if exists)

### Files created

- `apps/fuji/src/lib/entry-content-doc.ts`
- `apps/honeycrisp/src/lib/note-body-doc.ts`
- `packages/filesystem/src/file-content-doc.ts`
- `packages/skills/src/skill-instructions-doc.ts`
- `packages/skills/src/reference-content-doc.ts`

### Prior art

- `specs/20260420T152026-definedocument-primitive.md`: original design with full `.withDocument` inventory
- `specs/20260420T220000-simplify-definedocument-primitive.md`: the primitive that enabled this collapse
- `specs/20260420T230000-y-websocket-teardown-fix.md`: parallel correctness fix
- `specs/20260420T230200-workspace-as-definedocument.md`: follow-up that unifies workspace lifecycle too

### Naming conventions

- `build<Domain><Slot>Doc(rowId)`: per-doc builder function
- `<domain><Slot>Docs`: factory export (e.g., `entryContentDocs`)
- `.withExtension(key, factory)`: the single remaining workspace extension method
