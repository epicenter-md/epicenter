# Inline Content-Doc Factories

**Date**: 2026-04-21
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive

## Overview

Delete the three per-row content-doc factories (`createFileContentDocs`, `createSkillInstructionsDocs`, `createReferenceContentDocs`) and the shared `buildPerRowDoc` helper. Inline their bodies directly into each `defineDocument` call site. `docPersistence.ts` has already been collapsed into `build-per-row-doc.ts`; this spec finishes the reduction by deleting that layer too.

## Motivation

### Current State

Three factories sit between `defineDocument` and the consumer. Each one is a thin wrapper:

```ts
// packages/filesystem/src/file-content-docs.ts
export function createFileContentDocs({ workspaceId, filesTable, attach }) {
  return defineDocument((fileId: FileId) => {
    const base = buildPerRowDoc({
      workspaceId,
      collection: 'files',
      field: 'content',
      id: fileId,
      onUpdate: () => filesTable.update(fileId, { updatedAt: Date.now() }),
      attach,
    });
    return { ...base, content: attachTimeline(base.ydoc) };
  });
}
```

`buildPerRowDoc` itself is ~30 lines of plumbing (Y.Doc, guid, onLocalUpdate, persistence fallback, dispose):

```ts
// packages/document/src/build-per-row-doc.ts
export function buildPerRowDoc({ workspaceId, collection, field, id, onUpdate, attach }) {
  const ydoc = new Y.Doc({
    guid: docGuid({ workspaceId, collection, rowId: id, field }),
    gc: false,
  });
  onLocalUpdate(ydoc, onUpdate);
  const persistence = attach?.(ydoc) ?? NO_PERSISTENCE;
  return {
    ydoc,
    whenReady: persistence.whenLoaded,
    whenDisposed: persistence.whenDisposed,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

Consumers call the factory and immediately destructure. The wrapper adds no domain value:

```ts
// apps/opensidian/src/lib/client.ts
const fileContentDocs = createFileContentDocs({
  workspaceId: id,
  filesTable: tables.files,
  attach: (doc) => attachIndexedDb(doc),
});
```

This creates problems:

1. **Indirection without payoff**: Each factory forwards its args to `buildPerRowDoc` unchanged and adds one `attach*` call. Reading a call site requires chasing two files.
2. **Premature abstraction**: Three callers with two variations (`attachTimeline` vs `attachPlainText`) doesn't justify a shared primitive. The 30 lines of `buildPerRowDoc` are now effectively boilerplate to read: not to write.
3. **Contract surface leaks**: `DocPersistence` and `PerRowDocBase` are exported from `packages/document` solely to type the factory seam. Inlining collapses both into local structural shapes.

### Desired State

Each call site owns its `defineDocument` directly. No wrapper factories, no shared builder:

```ts
// apps/opensidian/src/lib/client.ts (after)
const fileContentDocs = defineDocument((fileId: FileId) => {
  const ydoc = new Y.Doc({
    guid: docGuid({ workspaceId: id, collection: 'files', rowId: fileId, field: 'content' }),
    gc: false,
  });
  onLocalUpdate(ydoc, () => tables.files.update(fileId, { updatedAt: Date.now() }));
  const persistence = attachIndexedDb(ydoc);
  return {
    ydoc,
    content: attachTimeline(ydoc),
    whenReady: persistence.whenLoaded,
    whenDisposed: persistence.whenDisposed,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});
```

Reading the call site tells you everything: the guid shape, the writeback hook, the persistence choice, the content attachment, and the disposal contract. No hops.

## Scope Correction

The task description said "3 call sites." Actual count is **7**, across 3 factories:

| Factory                          | Call sites                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `createFileContentDocs`          | `apps/opensidian/src/lib/client.ts`, `playground/opensidian-e2e/epicenter.config.ts`, `.../epicenter.config.test.ts` |
| `createSkillInstructionsDocs`    | `packages/skills/src/index.ts`, `packages/skills/src/node.ts`                                                |
| `createReferenceContentDocs`     | `packages/skills/src/index.ts`, `packages/skills/src/node.ts`                                                |

All 7 must be inlined. If duplication across the browser/node pair in `packages/skills` turns out to be painful, the implementer can factor the common body back out. But into the same file, not a shared primitive.

## Design Decisions

| Decision                                     | Choice                                                          | Rationale                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Keep `defineDocument`?                       | Yes                                                             | It provides caching, ref-counting, grace-period GC: real value. Not a wrapper.                       |
| Keep `docGuid`?                              | Yes                                                             | Deterministic guid derivation is shared logic worth centralizing; it's a pure helper, not a wrapper. |
| Keep `onLocalUpdate`?                        | Yes                                                             | Encapsulates the origin-filter subtlety (non-trivial); not a factory.                                |
| Fate of `NO_PERSISTENCE` fallback            | Inline per call site, or drop entirely if every call site attaches | Two `packages/skills/src/node.ts` sites omit `attach` today: they'll need an explicit inline fallback. |
| Export surface for `DocPersistence`          | Delete                                                          | Only used by the factory seam. No external consumers after inlining.                                 |
| Export surface for `PerRowDocBase`           | Delete                                                          | Same.                                                                                                |
| Export surface for `buildPerRowDoc`          | Delete                                                          | File itself is deleted.                                                                              |
| Duplication across 7 sites                   | Accept                                                          | Three similar blocks beat a premature abstraction. If painful, co-locate per package, not globally.  |

## Architecture

### Before

```
call site
   │
   ▼
createFileContentDocs / createSkillInstructionsDocs / createReferenceContentDocs
   │   (packages/filesystem, packages/skills)
   ▼
buildPerRowDoc
   │   (packages/document)
   ▼
Y.Doc + docGuid + onLocalUpdate + persistence plumbing
```

### After

```
call site
   │
   ▼
defineDocument((id) => {
  ydoc + docGuid + onLocalUpdate + attach + domain attachment
})
```

Each call site is self-contained. `packages/document` still exports `defineDocument`, `docGuid`, `onLocalUpdate`, and the `attach*` helpers, everything call sites compose.

## Implementation Plan

### Phase 1: Inline the 7 call sites

- [ ] **1.1** Inline `createFileContentDocs` body into `apps/opensidian/src/lib/client.ts`. Use `attachIndexedDb(ydoc)`.
- [ ] **1.2** Inline into `playground/opensidian-e2e/epicenter.config.ts`. Use `attachSqlite(ydoc, { filePath })`.
- [ ] **1.3** Inline into `playground/opensidian-e2e/epicenter.config.test.ts`. Use `attachSqlite(ydoc, { filePath })`.
- [ ] **1.4** Inline `createSkillInstructionsDocs` body into `packages/skills/src/index.ts`. Uses `attachIndexedDb`, `attachPlainText`.
- [ ] **1.5** Inline into `packages/skills/src/node.ts`. No persistence attach; inline the `NO_PERSISTENCE`-equivalent (`whenReady: Promise.resolve()`, `whenDisposed: Promise.resolve()`).
- [ ] **1.6** Inline `createReferenceContentDocs` body into `packages/skills/src/index.ts`. Uses `attachIndexedDb`, `attachPlainText`.
- [ ] **1.7** Inline into `packages/skills/src/node.ts`. No-persistence variant.

### Phase 2: Delete dead code

- [ ] **2.1** Delete `packages/filesystem/src/file-content-docs.ts`.
- [ ] **2.2** Delete `packages/skills/src/skill-instructions-docs.ts`.
- [ ] **2.3** Delete `packages/skills/src/reference-content-docs.ts`.
- [ ] **2.4** Delete `packages/document/src/build-per-row-doc.ts`.
- [ ] **2.5** Remove `buildPerRowDoc`, `DocPersistence`, `PerRowDocBase` exports from `packages/document/src/index.ts` (lines 66-70).
- [ ] **2.6** Remove re-exports of the deleted factories from `packages/filesystem/src/index.ts` and `packages/skills/src/index.ts` (grep for `file-content-docs`, `skill-instructions-docs`, `reference-content-docs`).
- [ ] **2.7** Check for `FileContentDocs` type export and any other `ReturnType<typeof create...>` exports; delete or replace with structural types at the consumer.

### Phase 3: Verify

- [ ] **3.1** `bun run typecheck` at repo root (or equivalent per package).
- [ ] **3.2** `bun test` for `packages/document`, `packages/skills`, `packages/filesystem`, `playground/opensidian-e2e`.
- [ ] **3.3** Grep for any stragglers: `rg "createFileContentDocs|createSkillInstructionsDocs|createReferenceContentDocs|buildPerRowDoc|DocPersistence|PerRowDocBase|NO_PERSISTENCE"`: should return zero hits outside `specs/` and `docs/`.
- [ ] **3.4** Spot-check one call site end-to-end (e.g., opensidian app) to confirm document open/close still works.

## Edge Cases

### node.ts sites have no `attach`

`packages/skills/src/node.ts` currently calls the factories without `attach`, relying on the `NO_PERSISTENCE` fallback inside `buildPerRowDoc`. After inlining, each call site must inline the fallback explicitly:

```ts
const ydoc = new Y.Doc({ guid: docGuid({...}), gc: false });
onLocalUpdate(ydoc, () => tables.skills.update(skillId, { updatedAt: Date.now() }));
return {
  ydoc,
  instructions: attachPlainText(ydoc),
  whenReady: Promise.resolve(),
  whenDisposed: Promise.resolve(),
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

### Downstream `FileContentDocs` type consumers

`createFileContentDocs` exports `type FileContentDocs = ReturnType<typeof createFileContentDocs>`. Grep for usage before deletion: any consumer typing against it needs to switch to `ReturnType<typeof defineDocument<...>>` or a local type alias at the call site.

### Spec docs referencing the removed primitives

`specs/20260420T152026-definedocument-primitive.md` and `specs/20260420T220000-simplify-definedocument-primitive.md` mention `buildPerRowDoc`. Don't edit historical specs. They're point-in-time records.

## Open Questions

1. **Should `NO_PERSISTENCE` stay as a named export from `packages/document`?**
   - Options: (a) delete entirely: each call site writes `Promise.resolve()` inline, (b) keep as a tiny exported constant for the no-attach case.
   - **Recommendation**: (a) delete. Two literals per no-persistence call site is clearer than an import.

2. **Should the two `packages/skills` pairs (index.ts + node.ts) share a private helper inside `packages/skills/src/`?**
   - The node and browser variants differ only in `attach`. After inlining, they're ~20 duplicate lines × 2 collections = 40 lines of duplication across two files.
   - **Recommendation**: Inline first, look at the diff, decide after. If the duplication reads cleanly (it likely will: only `attach` differs), leave it. Co-locating a shared helper inside `packages/skills` would recreate the thing we just deleted, one layer shallower.

3. **Does `docGuid` warrant inlining too?**
   - It's a pure helper exported from `packages/document`. Has real callers beyond these factories.
   - **Recommendation**: No. It's a shared pure function, not a wrapper.

## Success Criteria

- [ ] All 7 call sites use `defineDocument` directly, with no factory wrapper in between.
- [ ] `build-per-row-doc.ts`, `file-content-docs.ts`, `skill-instructions-docs.ts`, `reference-content-docs.ts` all deleted.
- [ ] `DocPersistence`, `PerRowDocBase`, `buildPerRowDoc` no longer exported from `packages/document`.
- [ ] Typecheck passes.
- [ ] Tests pass.
- [ ] Grep for the deleted symbol names returns zero hits outside `specs/`.

## References

- `packages/document/src/build-per-row-doc.ts`: primitive being deleted (contains `DocPersistence`, `NO_PERSISTENCE`, `PerRowDocBase`, `buildPerRowDoc`).
- `packages/document/src/index.ts:66-70`: exports to remove.
- `packages/document/src/define-document.ts`: retained primitive; inlined call sites call this directly.
- `packages/document/src/doc-guid.ts`: retained helper.
- `packages/document/src/on-local-update.ts`: retained helper.
- `packages/filesystem/src/file-content-docs.ts`: factory to delete.
- `packages/skills/src/skill-instructions-docs.ts`: factory to delete.
- `packages/skills/src/reference-content-docs.ts`: factory to delete.
- Call sites: `apps/opensidian/src/lib/client.ts`, `playground/opensidian-e2e/epicenter.config.ts`, `playground/opensidian-e2e/epicenter.config.test.ts`, `packages/skills/src/index.ts`, `packages/skills/src/node.ts`.
- Prior commit `6ac9f59bc` (inline `docPersistence` → `buildPerRowDoc`): this spec extends that cleanup one layer further.
