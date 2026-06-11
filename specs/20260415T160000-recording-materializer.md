# Recording Markdown Materializer

**Date**: 2026-04-15
**Status**: Draft
**Branch**: refactor/whispering-recording-schema-v2

## Overview

Replace the desktop file-system DB service's recording metadata writes with a workspace extension that materializes recording rows to `.md` files on change. The workspace becomes the sole source of truth; markdown files become a derived, human-readable view.

## Motivation

### Current State

Two parallel systems store recording metadata:

```
processRecordingPipeline()
├── recordings.set(recording)           ← workspace (source of truth)
└── services.db.recordings.create({     ← DB service (parallel copy)
      recording, audio: blob
    })
```

The DB service writes a `{id}.md` with YAML frontmatter (metadata) + body (transcript) alongside a `{id}.webm` (audio). The workspace writes the same metadata to Yjs. Both store identical data in different formats with different types (`Recording` vs `DbRecording`).

Problems:

1. **Two writes, one source of truth.** Metadata updates via `recordings.update()` only go to the workspace. The `.md` file on disk gets stale the moment the user edits a transcript or transcription completes.
2. **Dead write path.** `services.db.recordings.update()` and `services.db.recordings.delete()` are never called from app code. The file-system's metadata layer is write-once, then abandoned.
3. **Unnecessary middleman type.** `DbRecording` exists solely to bridge the DB service's storage format to the workspace type.

### Desired State

```
processRecordingPipeline()
├── recordings.set(recording)           ← workspace (sole source of truth)
└── audioBlobs.save(id, blob)           ← audio-only storage (simple)

workspace extension (materializer)
└── recordings.observe() → write {id}.md on every change
```

Markdown files stay in sync because they're derived from workspace observations. Audio blob storage is a simple id→blob service. No `DbRecording` type needed.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Materializer runtime | Tauri-specific extension using `@tauri-apps/plugin-fs` | Existing `createMarkdownMaterializer` uses `Bun.write`: browser WebView can't use Bun APIs |
| Scope | Recordings table only (Phase 3) | Transformations/runs still use DB service for CRUD; tackle later |
| Audio handling | Separate from materializer | Audio is a one-time write at recording time, not a derived view. Materializer only handles metadata→markdown. |
| `.md` format | Same YAML frontmatter + transcript body | Backward compatible with existing files. Users can read/grep their recordings. |
| Delete behavior | Materializer deletes `{id}.md` when row is removed from workspace | Matches current behavior. Audio cleanup stays separate. |
| Backward compat | Old `.md` files left on disk | Migration reads from workspace (already migrated). Old files are harmless and get overwritten on first workspace change. |

## Architecture

```
┌───────────────────────────────────┐
│   Workspace (Yjs)                 │
│   recordings table                │
│   SOLE source of truth            │
└──────────┬────────────────────────┘
           │ table.observe(changedIds)
           ▼
┌───────────────────────────────────┐
│   Recording materializer          │
│   (workspace extension)           │
│                                   │
│   on set/update → write {id}.md   │
│   on delete     → unlink {id}.md  │
│   uses @tauri-apps/plugin-fs      │
└──────────┬────────────────────────┘
           │ writeTextFile / remove
           ▼
┌───────────────────────────────────┐
│   {appDataDir}/recordings/        │
│   ├── {id}.md   (derived view)    │
│   └── {id}.webm (audio, separate) │
└───────────────────────────────────┘
```

Audio flow (unchanged, just simplified):
```
processRecordingPipeline()
└── audioBlobs.save(recordingId, blob)
    └── tauriWriteFile(PATHS.DB.RECORDING_AUDIO(id, ext), bytes)
```

## Implementation Plan

### Phase 3a: Create the materializer extension

- [ ] **3a.1** Create `src/lib/workspace/extensions/recording-materializer.ts`
  - Workspace extension factory that returns `{ whenReady, dispose }`
  - On `whenReady`: initial flush of all recordings to `.md` files
  - Observe recordings table: on change, serialize row → write `{id}.md`; on delete, unlink `{id}.md`
  - Uses Tauri `writeTextFile` + `remove` from `@tauri-apps/plugin-fs`
  - Reuses existing `stringifyFrontmatter` from `services/db/frontmatter.ts` for identical `.md` format
  - Atomic writes: write to `{id}.md.tmp`, then `rename` to `{id}.md`
- [ ] **3a.2** Wire into `src/lib/client.ts` via `.withWorkspaceExtension('materializer', ...)`
  - Only on desktop (guard with `window.__TAURI_INTERNALS__`)
- [ ] **3a.3** Remove metadata write from `services.db.recordings.create()`
  - `create()` becomes audio-only: just writes `{id}.webm`
  - Remove `recordingToMarkdown` call from create path
- [ ] **3a.4** Remove `services.db.recordings.update()` method
  - Never called from app code (confirmed by exploration)
- [ ] **3a.5** Verify: recordings table changes → `.md` files update on disk

### Phase 3b: Slim the DB service interface

- [ ] **3b.1** Remove metadata-only methods from `DbService.recordings`: `getAll`, `getLatest`, `getById`, `getTranscribingIds`, `getCount`, `update`
- [ ] **3b.2** Rename `create` → `saveAudio` with signature `(recordingId: string, audio: Blob)`
- [ ] **3b.3** Simplify `delete` to accept `string | string[]` (IDs, not full objects)
- [ ] **3b.4** Remove `DbRecording` type entirely
- [ ] **3b.5** Remove `RecordingFrontMatter`, `RecordingFrontMatterRaw`, `normalizeRecordingFrontMatter`, `recordingToMarkdown`, `markdownToRecording` from `file-system.ts`
- [ ] **3b.6** Remove `storedRecordingToRecording` from `web/index.ts`
- [ ] **3b.7** Update `cleanupExpired` to work with recording IDs from workspace, not from DB service `getAll()`

### Phase 3c: Clean up web (IndexedDB) path

- [ ] **3c.1** Web `create` becomes audio-only (drop metadata from IndexedDB row)
- [ ] **3c.2** Web `delete` accepts IDs only
- [ ] **3c.3** Simplify `RecordingStoredInIndexedDB` to `{ id: string; serializedAudio: SerializedAudio }`
- [ ] **3c.4** Remove `RecordingStoredInIndexedDbLegacy` type (no longer needed after migration)

## Edge Cases

### Initial flush on first launch after migration

1. User has existing recordings in workspace (migrated from Dexie)
2. Materializer starts, calls `table.getAllValid()`, flushes all to `.md`
3. Old `.md` files with V1 field names get overwritten with V2 field names
4. Expected: clean migration, no data loss

### Recording created while materializer is initializing

1. `processRecordingPipeline` runs before `whenReady` resolves
2. Recording is written to workspace immediately
3. Materializer's initial flush picks it up. No gap
4. Expected: `.md` file appears after `whenReady`, not lost

### Audio save fails but metadata succeeds

1. Workspace write succeeds (instant, local)
2. Audio `tauriWriteFile` fails (disk full, permission error)
3. Materializer writes `.md` (metadata is in workspace)
4. Expected: `.md` exists, audio doesn't. User sees recording without audio. Already handled by current error flow.

### Web platform (no Tauri)

1. Materializer is guarded by `window.__TAURI_INTERNALS__`
2. Web platform skips materializer entirely
3. IndexedDB stores audio blobs only
4. Expected: no change in behavior for web users

## Open Questions

1. **Should the materializer delete audio files too, or keep that in a separate cleanup?**
   - Options: (a) materializer handles both `.md` and audio deletion, (b) audio cleanup stays in DB service
   - **Recommendation**: (b) Keep audio cleanup separate. The materializer's job is metadata→markdown. Audio lifecycle is a different concern.

2. **Should `cleanupExpired` move to a workspace action instead of DB service?**
   - It currently reads all recordings from DB, sorts, and deletes excess. With workspace as source of truth, it should read from workspace.
   - **Recommendation**: Move to a workspace action in Phase 3b. It reads `recordings.sorted`, takes IDs of expired ones, deletes from workspace (materializer handles `.md` cleanup) + calls audio delete.

3. **Should the materializer be generalized for reuse by other apps?**
   - The existing `createMarkdownMaterializer` is Bun-specific. A Tauri-compatible version could live in a shared package.
   - **Recommendation**: Build it app-local first (`src/lib/workspace/extensions/`). Extract to `@epicenter/tauri` if a second app needs it.

## Success Criteria

- [ ] Recording metadata changes (title, transcript, transcriptionStatus) → `.md` file updates on disk within seconds
- [ ] New recordings → `.md` + `.webm` both appear in recordings directory
- [ ] Deleted recordings → `.md` removed (audio removal via separate path)
- [ ] `DbRecording` type no longer exists
- [ ] DB service `recordings` interface is audio-only: `saveAudio`, `getAudioBlob`, `ensureAudioPlaybackUrl`, `revokeUrl`, `deleteAudio`
- [ ] No type errors, diagnostics clean
- [ ] Web platform unaffected

## References

- `packages/workspace/src/extensions/materializer/markdown/materializer.ts`: Bun materializer (pattern to follow, not the runtime)
- `apps/whispering/src/lib/services/db/file-system.ts`: Current desktop write path (to be replaced)
- `apps/whispering/src/lib/services/db/frontmatter.ts`: YAML serialization (reuse)
- `apps/whispering/src/lib/workspace/definition.ts`: Recording V2 schema
- `apps/whispering/src/lib/client.ts`: Where to chain `.withWorkspaceExtension()`
- `apps/whispering/src/lib/constants/paths.ts`: `PATHS.DB.RECORDINGS()`, `PATHS.DB.RECORDING_MD(id)`
- `playground/tab-manager-e2e/epicenter.config.ts`: Example materializer usage
