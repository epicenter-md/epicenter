# Query Layer Switch: DbService → Workspace Tables

**Date**: 2026-03-15
**Status**: Partially Implemented
**Prerequisite**: [20260314T070000-database-to-workspace-migration.md](./20260314T070000-database-to-workspace-migration.md) (Implemented: data is in workspace tables)

## Overview

Replace the TanStack Query + DbService read/write path with reactive state modules backed by Yjs workspace tables. After the database migration (already implemented) copies data into workspace tables, this spec wires the app to read and write from those tables directly. Eliminating the stale-while-revalidate polling pattern in favor of live CRDT reactivity.

## Motivation

### Current State

Data flows through three layers before reaching a component:

```
Component → TanStack Query → DbService → Dexie/filesystem
                ↑
   queryClient.invalidateQueries() after every mutation
```

The query layer (`$lib/query/db.ts`) wraps every DbService call in `defineQuery`/`defineMutation`:

```typescript
// 12 query/mutation definitions for recordings, transformations, and runs
recordings.getAll:   defineQuery  → services.db.recordings.getAll()
recordings.getLatest: defineQuery → services.db.recordings.getLatest()
recordings.getById:  defineQuery  → services.db.recordings.getById(id)
recordings.create:   defineMutation → services.db.recordings.create() + invalidate 3 queries
recordings.update:   defineMutation → services.db.recordings.update() + invalidate 1 query
recordings.delete:   defineMutation → services.db.recordings.delete() + invalidate 2 queries
transformations.getAll: defineQuery → services.db.transformations.getAll()
transformations.getById: defineQuery → services.db.transformations.getById(id)
transformations.create:  defineMutation → create + optimistic update + invalidate
transformations.update:  defineMutation → update + optimistic update
transformations.delete:  defineMutation → delete + optimistic update + clear selectedId
runs.getByTransformationId: defineQuery → services.db.runs.getByTransformationId(id)
runs.getByRecordingId:      defineQuery → services.db.runs.getByRecordingId(id)
runs.delete:                defineMutation → delete + invalidate per FK
```

Every mutation must manually invalidate the right queries. Miss one and the UI shows stale data. Add a new mutation and you have to figure out which queries to invalidate. This is a solved problem. Yjs solves it at the CRDT layer.

### What's Already In Place

The workspace migration (implemented) has already:
- Defined 5 Yjs tables in `workspace.ts` (recordings, transformations, transformationSteps, transformationRuns, transformationStepRuns)
- Copied all data from Dexie/filesystem into workspace tables
- Verified idempotency

Settings already use the target pattern (`workspace-settings.svelte.ts`):

```typescript
// SvelteMap + Yjs observer = live reactive state, no TanStack Query
const map = new SvelteMap<string, unknown>();
workspace.kv.observeAll((changes) => {
    for (const [key, change] of changes) {
        map.set(key, change.value);
    }
});
```

### Desired State

```
Component → reactive state module (.svelte.ts) → workspace.tables.X
                                                        ↑
                                        Yjs observe() fires automatically
```

No manual invalidation. No stale-while-revalidate. No polling. Writes go to `workspace.tables.X.set()` → Yjs fires observers → SvelteMap updates → components re-render. Same write triggers sync to other devices via CRDT replication when sync extensions are added.

## Research Findings

### Workspace Table API Surface

The `TableHelper` from `packages/workspace/src/workspace/table-helper.ts` provides:

| Category | Methods | Notes |
|---|---|---|
| Write | `set(row)`, `update(id, partial)` | `set` replaces entire row atomically |
| Read | `get(id)`, `getAll()`, `getAllValid()`, `getAllInvalid()` | `getAll` returns `RowResult[]` (valid or invalid), `getAllValid` filters to valid rows only |
| Query | `filter(predicate)`, `find(predicate)` | In-memory scan over valid rows |
| Delete | `delete(id)`, `clear()` | Per-ID or bulk |
| Metadata | `count()`, `has(id)` | |
| Observe | `observe(callback)` | Callback receives `Set<string>` of changed IDs + transaction. Returns unsubscribe function. |

### Yjs Observation Model (from Y.Map/Y.Array docs)

- `observe()` fires after the Y.Transaction completes: bulk operations fire **one** callback
- Changes are batched per transaction, reducing unnecessary re-renders
- The `transaction` object enables origin checks (local vs remote changes)
- `unobserve()` cleanup prevents memory leaks

### Svelte 5 SvelteMap Reactivity (from sveltejs/svelte DeepWiki)

- `SvelteMap` uses internal `$state` signals: `set()`, `delete()`, `clear()` trigger re-renders
- Fine-grained: only components reading a specific key re-render when that key changes
- Values are **not deeply reactive**: but workspace table rows are plain JSON objects (not nested state), so this is fine
- Module-level `SvelteMap` in `.svelte.ts` files creates singletons: exactly the pattern we need

### Proven Pattern: workspace-settings.svelte.ts

The settings module already does exactly what we need for tables:

```typescript
function createWorkspaceSettings() {
    const map = new SvelteMap<string, unknown>();

    // 1. Initialize from current state
    for (const key of Object.keys(KV_DEFINITIONS)) {
        map.set(key, workspace.kv.get(key));
    }

    // 2. Observe all changes (local or remote)
    workspace.kv.observeAll((changes) => {
        for (const [key, change] of changes) {
            if (change.type === 'set') map.set(key, change.value);
            else if (change.type === 'delete') map.set(key, workspace.kv.get(key));
        }
    });

    // 3. Expose typed get/set
    return {
        get(key) { return map.get(key); },
        set(key, value) { workspace.kv.set(key, value); },
    };
}
```

Tables follow the same pattern but with `SvelteMap<id, Row>` instead of `SvelteMap<key, value>`.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reactive primitive | `SvelteMap<string, Row>` per table | Proven pattern from `workspace-settings.svelte.ts`. Per-key reactivity means updating one recording doesn't re-render the entire list. |
| Module location | `$lib/state/workspace-recordings.svelte.ts`, etc. | Follows existing `$lib/state/` convention. The state README already documents this pattern. |
| TanStack Query for tables | Remove entirely for recordings/transformations | Stale-while-revalidate is the wrong model for live CRDT data. Keep TanStack Query for non-workspace concerns (HTTP fetches, transcription service calls). |
| Audio blob handling | Keep existing `DbService.recordings.getAudioBlob()` and `ensureAudioPlaybackUrl()` | Audio blobs are NOT in Yjs tables (too large for CRDTs). Desktop reads from filesystem; web reads from Dexie's `serializedAudio`. This path stays as-is. |
| Transformation runs | Defer to workspace tables for new runs, keep DbService for historical reads | Old runs weren't migrated (by design). New runs write to workspace tables. Old runs can be read from DbService until we decide to drop them. |
| `db.ts` query layer | Phase out incrementally | Don't delete `db.ts` in one shot. Move tables one at a time. Keep `db.ts` for audio URLs and historical runs until those are addressed. |
| DbService deletion | Defer | DbService still serves audio blobs and historical runs. Delete it in a future spec when those are migrated. |

## Architecture

```
BEFORE (TanStack Query + DbService):
┌──────────┐    ┌─────────────┐    ┌───────────┐    ┌──────────────┐
│Component │───▶│TanStack Query│───▶│ DbService │───▶│ Dexie / FS   │
│          │    │(poll/cache)  │    │           │    │              │
│          │◀───│ stale data?  │    │           │    │              │
│          │    │invalidate!   │◀───│           │    │              │
└──────────┘    └─────────────┘    └───────────┘    └──────────────┘

AFTER (Yjs CRDT reactive state):
┌──────────┐    ┌──────────────────┐    ┌──────────────┐    ┌───────────┐
│Component │───▶│ workspace-       │───▶│ workspace    │───▶│ Yjs Y.Doc │
│          │    │ recordings       │    │ .tables      │    │           │
│          │◀───│ .svelte.ts       │    │ .recordings  │    │ persisted │
│ (reads   │    │ (SvelteMap)      │◀───│ .observe()   │    │ IndexedDB │
│  map.get)│    │                  │    │              │    │           │
└──────────┘    └──────────────────┘    └──────────────┘    └───────────┘
                        │
                        │ writes: workspace.tables.recordings.set(row)
                        │ → Yjs fires observer → SvelteMap updates → components re-render
                        │ → IndexedDB persistence auto-syncs
                        │ → future: remote CRDT sync
```

### Reactive State Module Pattern

```typescript
// workspace-recordings.svelte.ts
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';
import type { Recording } from './types';

function createWorkspaceRecordings() {
    const map = new SvelteMap<string, Recording>();

    // Initialize from current workspace state
    for (const row of workspace.tables.recordings.getAllValid()) {
        map.set(row.id, row);
    }

    // Observe changes (local writes, remote CRDT sync, migration)
    workspace.tables.recordings.observe((changedIds) => {
        for (const id of changedIds) {
            const result = workspace.tables.recordings.get(id);
            if (result.status === 'valid') {
                map.set(id, result.row);
            } else if (result.status === 'not_found') {
                map.delete(id);
            }
            // 'invalid' rows are silently skipped (logged elsewhere)
        }
    });

    return {
        /** All recordings as an iterable map. Components reading this re-render on change. */
        get all() { return map; },

        /** Get a recording by ID. Returns undefined if not found. */
        get(id: string) { return map.get(id); },

        /** All recordings as a sorted array (newest first). */
        get sorted() {
            return Array.from(map.values()).sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
        },

        /** Create or update a recording. Writes to Yjs → observer updates SvelteMap. */
        set(recording: Recording) {
            workspace.tables.recordings.set(recording);
        },

        /** Delete a recording by ID. */
        delete(id: string) {
            workspace.tables.recordings.delete(id);
        },

        /** Total count. */
        get count() { return map.size; },
    };
}

export const workspaceRecordings = createWorkspaceRecordings();
```

## Implementation Plan

### Phase 1: Reactive state modules for recordings and transformations

- [x] **1.1** Create `$lib/state/workspace-recordings.svelte.ts`: SvelteMap backed by `workspace.tables.recordings`, with `observe()` for live updates
- [x] **1.2** Create `$lib/state/workspace-transformations.svelte.ts`: same pattern for transformations
- [x] **1.3** Create `$lib/state/workspace-transformation-steps.svelte.ts`: same pattern, with helper to get steps by transformationId

### Phase 2: Switch component reads from TanStack Query to reactive state

- [x] **2.1** Find all imports of `db.recordings.getAll` / `db.recordings.getById` / `db.recordings.getLatest` and replace with `workspaceRecordings.all` / `.get(id)` / `.sorted[0]`
  > Switched: recordings/+page.svelte, RecordingRowActions.svelte, home +page.svelte
- [x] **2.2** Find all imports of `db.transformations.getAll` / `db.transformations.getById` and replace with `workspaceTransformations`
  > Switched: transformations/+page.svelte, TransformationSelector.svelte. Deferred TransformationRowActions and TransformationPickerBody (depend on `.steps` restructuring in Phase 3).
- [x] **2.3** Update the recordings data table to read from `workspaceRecordings.sorted` instead of the TanStack Query

### Phase 3: Switch component writes from TanStack mutations to direct workspace writes

- [x] **3.1** Replace `db.recordings.create.mutate()` calls with `workspaceRecordings.set(recording)`: no invalidation needed
  > processRecordingPipeline: metadata to workspace, audio blob still saved to DbService
- [x] **3.2** Replace `db.recordings.update.mutate()` with `workspaceRecordings.update()`: same write, observer handles UI update
  > transcription.ts: all 3 update calls switched to workspaceRecordings.update()
- [x] **3.3** Replace `db.recordings.delete.mutate()` with `workspaceRecordings.delete(id)`: add audio URL cleanup before delete
  > recording-actions.ts, recordings page, home page: sync delete + revokeAudioUrl
- [x] **3.4** Same for transformation create/update/delete
  > COMPLETED: Editor refactored to flat workspace field names. Create/update now use workspace.batch() for atomic writes.
- [x] **3.5** Same for transformation step create/update/delete (these were previously nested in transformation objects: now they're their own table)
  > COMPLETED: Configuration.svelte refactored from dot-notation to flat field names. Steps passed as separate `steps` prop. Editor, Test, Create, Edit all use workspace types and workspace.batch() for saves.

### Phase 4: Handle transformation runs (incremental)

- [x] **4.1** Create `$lib/state/workspace-transformation-runs.svelte.ts` for new runs
  > Created with getByTransformationId(), getByRecordingId(), getLatestByRecordingId() helpers
- [ ] **4.2** Wire new transformation run creation to workspace tables
  > Deferred: the run lifecycle (create → addStep → completeStep/failStep → complete) is deeply coupled to DbService. Requires refactoring `runTransformation()` in transformer.ts.
- [x] **4.3** Keep `db.runs.getByTransformationId` / `db.runs.getByRecordingId` as fallback for historical runs not in workspace tables
  > Kept. Also switched recording read in transformer.ts from DbService to workspaceRecordings.get().

### Phase 5: Cleanup

- [ ] **5.1** Remove recordings/transformations queries and mutations from `$lib/query/db.ts`
  > Deferred: transformation create/update mutations are still in use (Editor uses old type). Recording queries (getAll, getLatest, getById) are no longer used in components. Can remove recording queries but must keep transformation queries for now.
- [ ] **5.2** Remove `dbKeys.recordings.*` and `dbKeys.transformations.*` from query key registry
  > Deferred: same reason as 5.1. Some query keys still referenced by transformation mutations and the transformer's invalidateQueries calls.
- [x] **5.3** Keep `db.recordings.getAudioPlaybackUrl` (audio blobs aren't in Yjs)
- [ ] **5.4** Update `$lib/query/README.md` to document the new architecture
  > Deferred: the README documents the full query layer pattern. Updating it requires documenting the new workspace state pattern and when to use each. This is a writing task for after the transition completes.
- [x] **5.5** Update `$lib/state/README.md` to document the new state modules
  > Added documentation for all 4 new workspace state modules.

## Edge Cases

### Workspace not ready on first render

The workspace IndexedDB persistence loads asynchronously. `workspace.tables.recordings.getAllValid()` returns empty until `workspace.whenReady` resolves. The state module should either:
1. Initialize empty and let the `observe()` callback populate rows as persistence loads
2. Or await `workspace.whenReady` before initializing (blocks first render)

Option 1 is better. The UI shows empty briefly, then populates as data loads. This is the same behavior users see today with TanStack Query's loading state.

### Audio blob access after migration

Audio blobs are NOT in workspace tables. The recording's metadata is in Yjs, but the audio lives in Dexie (web) or filesystem (desktop). The existing `DbService.recordings.getAudioBlob()` and `ensureAudioPlaybackUrl()` must remain for audio access. These can be called directly from services without going through the query layer.

### Component reads a recording that was just deleted

The `observe()` callback fires `map.delete(id)`. Any component using `workspaceRecordings.get(id)` will get `undefined` on the next render cycle. Components should handle `undefined` gracefully (which they already do for TanStack Query's `undefined` during loading).

### Concurrent writes from multiple tabs

Yjs CRDTs handle this automatically: last-writer-wins at the row level. Both tabs' SvelteMap observers fire, and both converge to the same state. No conflict resolution needed in the app layer.

### Transformation steps are a separate table now

The old model had `transformation.steps[]` as a nested array. The workspace model has `transformationSteps` as a separate table with `transformationId` FK. The reactive state module for steps should expose a `getByTransformationId(id)` helper that filters and sorts by `order`.

## Open Questions

1. **Should we await `workspace.whenReady` in the state modules?**
   - Option A: Initialize empty, let `observe()` populate (faster first render, brief empty state)
   - Option B: Block on `whenReady` before creating the SvelteMap (no empty flash, slower startup)
   - **Recommendation**: Option A: matches how TanStack Query works today (loading → data). The brief empty state is already handled by existing UI loading patterns.

2. **What about the transcription query (`$lib/query/transcription.ts`)?**
   - This isn't a DbService read: it calls external APIs (OpenAI, Groq, etc.). TanStack Query's mutation tracking is useful here for loading state.
   - **Recommendation**: Keep TanStack Query for transcription. Only remove it for workspace table reads/writes.

3. **Should `workspaceRecordings.sorted` use `$derived` or recompute on access?**
   - `$derived` caches the sorted array and only recomputes when the SvelteMap changes
   - Recomputing on access is simpler but sorts on every read
   - **Recommendation**: Start with recompute-on-access (getter). Optimize with `$derived` only if profiling shows sorting as a bottleneck. Most tables are small (<1000 rows).

4. **How do we handle the transition period where some components still use TanStack Query?**
   - During incremental migration, both systems will be active
   - **Recommendation**: That's fine. They read from different sources but the data is the same. Don't try to sync them: just migrate component by component.

## Success Criteria

- [ ] Recordings table reads from `workspaceRecordings` (not TanStack Query)
- [ ] Transformations table reads from `workspaceTransformations`
- [ ] Creating/updating/deleting recordings updates the UI without manual invalidation
- [ ] Audio playback still works (reads from DbService blob path)
- [ ] `svelte-check` and `bun typecheck` pass
- [ ] No `queryClient.invalidateQueries` calls remain for recordings or transformations

## References

- `apps/whispering/src/lib/state/workspace-settings.svelte.ts`: THE reference pattern (SvelteMap + Yjs KV observers)
- `apps/whispering/src/lib/state/device-config.svelte.ts`: reference for per-key localStorage + SvelteMap
- `apps/whispering/src/lib/state/README.md`: documents when to use state vs query layer
- `apps/whispering/src/lib/query/db.ts`: the query layer being replaced (12 queries/mutations)
- `apps/whispering/src/lib/workspace.ts`: workspace table definitions (target)
- `packages/workspace/src/workspace/table-helper.ts`: table API (set, get, getAll, observe, etc.)
- `specs/20260314T070000-database-to-workspace-migration.md`: prerequisite (data is already in workspace tables)
- `specs/20260312T170000-whispering-workspace-polish-and-migration.md`: parent spec

## Review

**Completed**: 2026-03-15

### Summary

Replaced TanStack Query + DbService read/write path with reactive SvelteMap state modules backed by Yjs workspace tables for recordings. The recordings data flow is now fully workspace-backed: components read from SvelteMap, writes go directly to workspace tables, Yjs observers keep the SvelteMap in sync. Transformations are partially migrated. Reads and deletes use workspace state, but create/update still go through TanStack Query mutations because the Editor component uses the old dot-notation field schema.

### Deviations from Spec

- **Transformation step schema mismatch**: The old `TransformationStepV2` uses dot-notation field names (e.g., `'prompt_transform.inference.provider'`), while the workspace table uses flat field names (e.g., `inferenceProvider`). This means the Editor component can't directly write to workspace tables without a field-name mapping layer or a full refactor. Transformation create/update mutations remain on TanStack Query during this transition.
- **Phase 5 partial**: Recording queries can be removed from db.ts, but transformation queries must stay. The query/README.md update was deferred since the architecture is still transitional.
- **Phase 4 partial**: Transformation runs state module was created, but the full run lifecycle (create → addStep → completeStep → complete) remains on DbService due to its complex multi-step execution pattern.

### Follow-up Work

1. **Editor flat field refactor**: Migrate `Configuration.svelte` and `Test.svelte` from dot-notation step fields to flat workspace table fields. This unblocks transformation create/update migration.
2. **Full db.ts cleanup**: Once all transformation mutations are on workspace, remove remaining query/mutation definitions from db.ts.
3. **Transformation run lifecycle**: Refactor `runTransformation()` in transformer.ts to write run/step-run records to workspace tables instead of DbService.
4. **TransformationPickerBody type alignment**: The `onSelect` callback passes workspace Transformation (no steps) to consumers. Consumers that need steps should get them from `workspaceTransformationSteps.getByTransformationId()`.
