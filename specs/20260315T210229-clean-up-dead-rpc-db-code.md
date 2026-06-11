# Clean Up Dead rpc.db Code After Workspace Migration

## Context

We migrated recordings, transformations, transformation steps, and transformation runs from TanStack Query + DbService to reactive SvelteMap state modules backed by Yjs workspace tables. The data flow is now:

```
Workspace (Yjs) → SvelteMap state modules → Components
```

Instead of:

```
DbService → TanStack Query cache → Components
```

The state modules live in `apps/whispering/src/lib/state/workspace-*.svelte.ts`. The old query layer in `lib/query/db.ts` is almost entirely dead. Only `getAudioPlaybackUrl` survives because audio blobs are too large for Yjs CRDTs.

## Investigation Summary

### db.ts (345 lines → ~25 lines)

**Exported symbols:**
- `dbKeys`: Query key registry with `recordings.*`, `transformations.*`, `runs.*`
- `db`: Object with `recordings`, `transformations`, `runs` namespaces

**Alive:**
- `db.recordings.getAudioPlaybackUrl` (lines 78-82): Used in 3 consumer sites
- `dbKeys.recordings.audioPlaybackUrl` (lines 20-21): Key for the above query

**Dead (confirmed zero external consumers):**
- `db.recordings.getAll`, `getLatest`, `getById`, `create`, `update`, `delete`
- `db.transformations.getAll`, `getById`, `create`, `update`, `delete`
- `db.runs.getByTransformationId`, `getByRecordingId`, `getLatestByRecordingId`, `delete`
- All `dbKeys` entries except `recordings.audioPlaybackUrl`

### transformer.ts: 5 dead invalidateQueries calls

All use `dbKeys.runs.*` or `dbKeys.transformations.*`. No component subscribes to these keys anymore.

| Line | Key | Status |
|------|-----|--------|
| 110-112 | `dbKeys.runs.byTransformationId(transformation.id)` | DEAD |
| 113-115 | `dbKeys.transformations.byId(transformation.id)` | DEAD |
| 159-161 | `dbKeys.runs.byRecordingId(recordingId)` | DEAD |
| 162-164 | `dbKeys.runs.byTransformationId(transformation.id)` | DEAD |
| 165-167 | `dbKeys.transformations.byId(transformation.id)` | DEAD |

Also imports `dbKeys` from `./db`: must update after rename.

### Consumer call sites (exactly 3)

| File | Line | Pattern |
|------|------|---------|
| `routes/(app)/+page.svelte` | 51 | `rpc.db.recordings.getAudioPlaybackUrl(() => latestRecording?.id ?? '')` |
| `routes/(app)/(config)/recordings/RenderAudioUrl.svelte` | 11 | `rpc.db.recordings.getAudioPlaybackUrl(() => id)` |
| `routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte` | 70 | `rpc.db.recordings.getAudioPlaybackUrl(() => recording.id)` |

### Still-alive imports from $lib/services/db

| File | Import | Status |
|------|--------|--------|
| `query/actions.ts` | `DbError` | KEEP: used at line 443: `DbError.NoValidFiles()` |
| `query/transformer.ts` | `TransformationRunCompleted`, `TransformationRunFailed`, `TransformationRunRunning` | KEEP: run lifecycle still goes through DbService |
| `migration/` files | Various | KEEP: reads old format intentionally |

### Non-db invalidateQueries (KEEP)

| File | Key | Purpose |
|------|-----|---------|
| `query/recorder.ts` line 28 | `recorderKeys.recorderState` | Hardware state |
| `query/desktop/autostart.ts` line 14 | `autostartKeys.isEnabled` | Desktop feature state |

## Plan

### Task 1: Gut db.ts → audio.ts

Rewrite `lib/query/db.ts` to contain only the audio playback URL query. Rename the file to `audio.ts` and rename the export from `db` to `audio`.

**Before (345 lines):**
```typescript
export const dbKeys = { recordings: { all, latest, byId, audioPlaybackUrl }, transformations: {...}, runs: {...} };
export const db = { recordings: { getAll, getLatest, getById, getAudioPlaybackUrl, create, update, delete }, transformations: {...}, runs: {...} };
```

**After (~25 lines):**
```typescript
import type { Accessor } from '@tanstack/svelte-query';
import { defineQuery } from '$lib/query/client';
import { services } from '$lib/services';

const audioKeys = {
  playbackUrl: (id: string) => ['audio', 'playbackUrl', id] as const,
};

export const audio = {
  /**
   * Get audio playback URL for a recording by ID.
   * Audio blobs are too large for Yjs CRDTs, so they're still served
   * from Dexie (web) / filesystem (desktop) via DbService.
   */
  getPlaybackUrl: (id: Accessor<string>) =>
    defineQuery({
      queryKey: audioKeys.playbackUrl(id()),
      queryFn: () => services.db.recordings.ensureAudioPlaybackUrl(id()),
    }),
};
```

**Removed imports:** `Err`, `Ok`, `queryClient`, `Recording`, `Transformation`, `TransformationRun`, `workspaceSettings`.

- [x] Done

### Task 2: Remove dead invalidateQueries from transformer.ts

Remove all 5 `queryClient.invalidateQueries` calls and the `import { dbKeys } from './db'` line. Also remove the unused `import { queryClient } from '$lib/query/client'` import (verify `queryClient` isn't used elsewhere in the file first. It's imported on line 8 but only used for invalidation).

**Lines to remove:**
- Line 8: `queryClient` from the `defineMutation` import (keep `defineMutation`)
- Line 26: `import { dbKeys } from './db';`
- Lines 110-115: Both invalidateQueries in `transformInput`
- Lines 159-167: All three invalidateQueries in `transformRecording`

- [x] Done

### Task 3: Update index.ts rpc export

Change `db` → `audio` in the rpc namespace.

**Before:**
```typescript
import { db } from './db';
export const rpc = { ..., db, ... };
```

**After:**
```typescript
import { audio } from './audio';
export const rpc = { ..., audio, ... };
```

- [x] Done

### Task 4: Update 3 consumer .svelte files

Update all call sites from `rpc.db.recordings.getAudioPlaybackUrl(...)` → `rpc.audio.getPlaybackUrl(...)`.

| File | Before | After |
|------|--------|-------|
| `+page.svelte:51` | `rpc.db.recordings.getAudioPlaybackUrl(() => ...)` | `rpc.audio.getPlaybackUrl(() => ...)` |
| `RenderAudioUrl.svelte:11` | `rpc.db.recordings.getAudioPlaybackUrl(() => id)` | `rpc.audio.getPlaybackUrl(() => id)` |
| `EditRecordingModal.svelte:70` | `rpc.db.recordings.getAudioPlaybackUrl(() => recording.id)` | `rpc.audio.getPlaybackUrl(() => recording.id)` |

- [x] Done

### Task 5: Update README.md

The README (1117 lines) references the old architecture extensively. Update:

1. Remove references to `rpc.db.recordings.*` examples
2. Update "Query Layer vs State" table. Remove `rpc.db.recordings.getAll` example, replace with `rpc.audio.getPlaybackUrl`
3. Add note explaining workspace state modules handle CRUD, TanStack Query only for: external APIs (transcription, LLM completions), hardware state (recorder, devices), and audio blob access
4. Update "The Three Layers" section to reflect the new architecture

- [x] Done

## What NOT to Touch

- `lib/services/db/`: Frozen DbService types and implementations. Still needed for audio blob access, run lifecycle, and migration.
- `lib/migration/`: Reads old format intentionally.
- `lib/state/workspace-*.svelte.ts`: Correct and complete.
- `query/actions.ts`: `DbError` import is still alive.
- `query/transformer.ts` types: `TransformationRunCompleted/Failed/Running` imports still alive.
- Any `createQuery` for non-db data (recorder, devices, ffmpeg, clipboard, autostart).
- `query/recorder.ts` and `query/desktop/autostart.ts`: their `invalidateQueries` calls are for non-db keys.

## Review

**Completed**: 2026-03-15

### Summary

Removed ~320 lines of dead query layer code (CRUD queries, mutations, cache management, query keys) after the Yjs workspace state migration. Only `getAudioPlaybackUrl` survived. Audio blobs are too large for CRDTs.

### Execution Order

Tasks were reordered from the spec for buildability:

1. **Task 2 first** (commit `d3bec52`): Removed transformer.ts's dependency on `./db` (5 dead `invalidateQueries` + unused `queryClient`/`dbKeys` imports). This unblocked the rename.
2. **Tasks 1+3+4 together** (commit `eb027a2`): Gutted db.ts → audio.ts, updated index.ts barrel export, and updated all 3 consumer call sites. These formed one atomic rename. Can't rename a module without updating all references simultaneously.
3. **Task 5** (commit `1563dd4`): Updated README "The Three Layers" and "Query Layer vs State" sections to document the new architecture.

### Deviations from Spec

- Tasks 1, 3, and 4 were combined into a single commit instead of three separate commits. Renaming `db.ts` → `audio.ts` while changing the export name from `db` to `audio` would leave the build broken between Task 1 and Task 3 (index.ts still importing from `./db`). Atomic rename is the correct git practice here.

### Typecheck Results

Zero new errors introduced. 12 pre-existing errors remain in `packages/ui/`, `packages/workspace/`, `Runs.svelte`, `actions.ts`, and `transform-clipboard/+page.svelte`: all unrelated to this cleanup.

### Additional Cleanup (2026-03-15 audit)

**ARCHITECTURE.md**: Replaced stale "Optimistic Updates" section (lines 86-110) that showed the dead `createRecording` mutation with `queryClient.setQueryData(['recordings'], ...)`. Replaced with "Workspace State" section documenting the current architecture: domain data in Yjs CRDTs, query layer narrowed to external APIs/hardware/audio blobs. Also updated line 140 `rpc.recordings.getAllRecordings` → `rpc.audio.*`, `rpc.transcription.*`, `rpc.recorder.*`.

**Remaining known staleness (flagged, not fixed):** The query/README.md contains ~35 `rpc.recordings.*` references in teaching examples that illustrate general TanStack Query patterns (defineQuery, defineMutation, reactive/imperative interfaces). These reference non-existent APIs but the patterns they teach are still conceptually valid. A full README rewrite is needed to replace these with current API examples: out of scope for this minimal cleanup.
