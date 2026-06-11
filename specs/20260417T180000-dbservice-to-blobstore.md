# DbService → BlobStore Migration

**Date**: 2026-04-17
**Status**: Implemented
**Branch**: `refactor/whispering-bulkdelete-and-blobstore`

## Overview

Remove the `transformations` and `runs` sections from `DbService`, leaving only the `audio` blob store. Then rename `DbService` → `BlobStore` with a pluggable interface.

## Motivation

### Current State

After the Phase B+C refactor (PR #1679), `DbService` looks like this:

```typescript
type DbService = {
  audio: { save, delete, clear, getBlob, ensurePlaybackUrl, revokeUrl };  // ← blob store
  transformations: { getAll, getById, create, update, delete, clear, getCount };  // ← dead weight
  runs: { getAll, getById, getByTransformationId, getByRecordingId, create, addStep, failStep, completeStep, complete, delete, clear, getCount };  // ← 1 caller
};
```

Problems:

1. **`transformations:` has zero app-level callers.** Transformation CRUD is already workspace-backed via `lib/state/transformations.svelte.ts`. The only consumers are the migration script (one-time) and the dual-source wrapper (reads for merge, but nobody reads from `DbService.transformations` in app code).
2. **`runs:` has exactly one caller**: `lib/query/transformer.ts`. The UI already reads runs from workspace via `lib/state/transformation-runs.svelte.ts`. The write path in `transformer.ts` still goes through DbService because it predates the workspace migration.
3. **The name `DbService` is stale.** Two-thirds of the interface is dead. The only section that does real work is `audio`, which is a blob store.

### Desired State

```typescript
type BlobStore = {
  audio: { save, delete, clear, getBlob, ensurePlaybackUrl, revokeUrl };
};
```

All transformation/run CRUD goes through workspace tables + state modules. `BlobStore` is a clean, pluggable interface for binary asset storage.

## Research Findings

### What's already migrated

| Entity | Workspace table | State module | DbService callers | Status |
|--------|----------------|--------------|-------------------|--------|
| Recordings | `recordings` | `recordings.svelte.ts` | 0 (audio-only) | ✅ Done |
| Transformations | `transformations` | `transformations.svelte.ts` | 0 | ✅ Done (just remove dead DbService code) |
| Transformation Steps | `transformationSteps` | `transformation-steps.svelte.ts` | 0 | ✅ Done |
| Transformation Runs | `transformationRuns` | `transformation-runs.svelte.ts` | 1 (`transformer.ts` writes) | 🟡 Write path needs migration |
| Transformation Step Runs | `transformationStepRuns` | ❌ None | 0 (embedded in run in DbService) | 🟡 Need state module or inline writes |

### Schema mismatch: DbService runs vs workspace runs

DbService embeds step runs inside the run:
```typescript
// DbService shape (models/transformation-runs.ts)
type TransformationRun = {
  id, transformationId, recordingId, startedAt, completedAt, status, input,
  stepRuns: TransformationStepRun[]  // ← embedded array
};
```

Workspace normalizes them into separate tables:
```
transformationRuns:     { id, transformationId, recordingId, startedAt, completedAt, status, ... }
transformationStepRuns: { id, runId, stepId, startedAt, completedAt, status, input, output, ... }
```

This is cleaner. The `transformer.ts` rewrite should write to both tables directly.

### `transformer.ts`: the one remaining caller

5 methods called on `services.db.runs`:

| DbService method | What it does | Workspace equivalent |
|------------------|-------------|---------------------|
| `create(run)` | Insert run header | `workspace.tables.transformationRuns.set(run)` |
| `addStep(run, step)` | Create step-run (nanoid, startedAt), append to run | `workspace.tables.transformationStepRuns.set(stepRun)` |
| `failStep(run, stepRunId, error)` | Mark step + run failed with timestamps | Update both step-run and run rows |
| `completeStep(run, stepRunId, output)` | Mark step completed | Update step-run row |
| `complete(run, output)` | Mark run completed | Update run row |

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remove `transformations:` from DbService | Just delete | Zero callers. Dead code. |
| Rewrite transformer.ts runs | Write to workspace tables | Only 1 caller, workspace schema already exists |
| Step-run writes | Inline in transformer.ts | Only one call site. No need for a state module wrapper. Transformer.ts is the only writer. |
| Run lifecycle methods (addStep, etc.) | Inline in transformer.ts as helper functions | These are execution-specific logic, not general CRUD. They don't belong on a state module. |
| Migration of old runs from DbService → workspace | Skip | Same rationale as recording migration. Migration already ran for existing users. Old runs in IndexedDB/filesystem are read-only history. |
| BlobStore naming | `BlobStore` over `AssetStore` | More precise. It stores blobs, not generic assets. |
| Error type | `BlobError` | Replaces `DbError` which no longer describes the scope. |
| Keep dual-source audio reads | Yes | Desktop users may still have audio in IndexedDB from pre-migration. Dual-read fallback must remain. |

## Implementation Plan

### Wave 1: Remove dead `transformations:` section

- [ ] **1.1** Remove `transformations:` from `DbService` interface (`types.ts`)
- [ ] **1.2** Remove `transformations:` from `file-system.ts`
- [ ] **1.3** Remove `transformations:` from `web/index.ts`
- [ ] **1.4** Remove `transformations:` from `desktop.ts`
- [ ] **1.5** Delete transformation model types that are only used by DbService (`models/transformations.ts`, `models/transformation-steps.ts`)
- [ ] **1.6** Update `models/index.ts` barrel
- [ ] **1.7** Clean up imports, verify diagnostics

### Wave 2: Migrate `transformer.ts` run writes to workspace

- [ ] **2.1** Read `lib/query/transformer.ts` and map each `services.db.runs.*` call to workspace equivalent
- [ ] **2.2** Implement helper functions for run lifecycle (create, addStep, failStep, completeStep, complete) using workspace tables
- [ ] **2.3** Replace all `services.db.runs.*` calls in transformer.ts
- [ ] **2.4** Remove `services.db` import from transformer.ts (verify no remaining DbService usage)

### Wave 3: Remove dead `runs:` section

- [ ] **3.1** Remove `runs:` from `DbService` interface
- [ ] **3.2** Remove `runs:` from `file-system.ts`
- [ ] **3.3** Remove `runs:` from `web/index.ts`
- [ ] **3.4** Remove `runs:` from `desktop.ts`
- [ ] **3.5** Delete run model types (`models/transformation-runs.ts`)
- [ ] **3.6** Update `models/index.ts`: likely empty, consider deleting the directory

### Wave 4: Rename DbService → BlobStore

- [ ] **4.1** Rename `DbService` → `BlobStore` in `types.ts`
- [ ] **4.2** Rename `DbError` → `BlobError`
- [ ] **4.3** Rename `createDbServiceDesktop` → `createBlobStoreDesktop`
- [ ] **4.4** Rename `createDbServiceWeb` → `createBlobStoreWeb`
- [ ] **4.5** Rename file `services/db/` → `services/blob-store/` (or keep `db/` and just rename types)
- [ ] **4.6** Update all callers of `services.db.*` → `services.blobStore.*` (or `services.blobs.*`)
- [ ] **4.7** Update barrel exports

### Wave 5: Cleanup

- [ ] **5.1** Straggler sweep: grep for dead refs
- [ ] **5.2** Update spec with completion notes
- [ ] **5.3** Verify typecheck passes

## Edge Cases

### Old runs in IndexedDB/filesystem
Users who ran transformations before this migration have run data in the old storage. The workspace reads won't find them. This is acceptable. Old run history is read-only and will gradually be replaced by new runs written to workspace.

### Migration script still references DbService
`migrate-database.ts` uses `dbService.transformations.getAll()` and `dbService.transformations.getCount()`. After removing `transformations:` from DbService, the migration needs updating (same approach as recordings. Simplify or skip).

### Desktop dual-source reads for runs
The desktop wrapper merges runs from filesystem + IndexedDB. After migration, new runs go to workspace. Old runs stay in filesystem/IndexedDB but are no longer queried (UI reads from workspace). The dual-source audio pattern remains for audio blobs only.

## Open Questions

1. **Directory rename: `services/db/` → `services/blob-store/`?**
   - Renaming the directory is cleaner but touches every import path
   - **Recommendation**: Rename. The import paths are `$lib/services/db` which is misleading. `$lib/services/blob-store` is accurate.

2. **Property name on services: `services.db` → `services.blobStore`?**
   - **Recommendation**: `services.blobs`: short, accurate, plural matches the namespace pattern

3. **Keep Dexie `transformations` and `transformationRuns` tables?**
   - The Dexie database still has these tables. Removing them requires a Dexie schema migration.
   - **Recommendation**: Leave them. Dexie ignores unused tables. Zero user impact.

## Success Criteria

- [ ] Zero `services.db.transformations.*` callers (already true. Just remove the dead code)
- [ ] Zero `services.db.runs.*` callers (transformer.ts migrated to workspace)
- [ ] `DbService` renamed to `BlobStore` with only `audio:` section
- [ ] `bun typecheck` passes
- [ ] LSP diagnostics clean on all changed files
- [ ] No remaining `DbService`, `DbError`, or `services.db` references outside blob-store directory

## References

- `apps/whispering/src/lib/services/db/types.ts`: current interface to gut
- `apps/whispering/src/lib/query/transformer.ts`: the one remaining runs caller
- `apps/whispering/src/lib/state/transformation-runs.svelte.ts`: workspace-backed run reads
- `apps/whispering/src/lib/workspace/definition.ts`: workspace table schemas for runs/step-runs
- `specs/20260415T190000-recording-remaining-phases.md`: parent spec (updated with B+C completion)
- `specs/20260417T120000-phase-bc-audio-only-db.md`: Phase B+C execution spec (completed)
