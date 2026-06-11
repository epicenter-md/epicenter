# Recording Architecture. Remaining Phases

**Date**: 2026-04-15
**Status**: Partially complete
**Depends on**: `fix/materializer-review-fixes` branch (merged)

## Overview

Follow-up work from the recording schema migration and materializer implementation. Each phase is independently shippable.

---

## Phase B+C: Slim DB service to audio-only ✅

**Merged**: PR #1679

The `DbService.recordings` namespace was stripped down to an audio-only blob store and renamed to `DbService.audio`. The workspace CRDT is now the sole source of truth for recording metadata.

### What was done
- Deleted `DbRecording` type, `models/recordings.ts`, frontmatter validators, markdown helpers
- Renamed `recordings` → `audio` namespace on `DbService`
- Shortened methods: `saveAudio` → `save`, `getAudioBlob` → `getBlob`, `ensureAudioPlaybackUrl` → `ensurePlaybackUrl`, `revokeAudioUrl` → `revokeUrl`
- Removed `cleanupExpired` (was just `delete` + empty-array guard)
- Removed dead `DbError.MigrationFailed` variant
- Moved `NoValidFiles` out of `DbError` into `ImportError` in `actions.ts`
- Renamed `RecordingStoredInIndexedDB` → `AudioStoredInIndexedDB`, `RecordingsDbSchemaV5` → `AudioDbSchemaV5`
- Renamed `createFileSystemDb` → `createFileSystemDbService`
- Fixed retention cleanup to delete workspace rows AND audio blobs
- Added `recordings.bulkDelete(ids)` to state module for O(n) batch operations

### Convention established: prefer bulkDelete for batch operations

When deleting multiple workspace rows, always use `bulkDelete(ids)` instead of looping `delete(id)`:

```typescript
// GOOD: O(n) single scan
await workspace.tables.recordings.bulkDelete(ids);
// or via state module:
recordings.bulkDelete(ids);

// BAD: O(n²): scans the array per delete call
for (const id of ids) {
    recordings.delete(id);
}
```

The workspace table API's `bulkDelete` collects all matching entries in a single scan and removes them in batch. For 10K deletions this is ~10x faster. For small batches (< 100 rows), individual deletes in a `workspace.batch()` are acceptable but `bulkDelete` is still preferred for clarity.

---

## Phase D: Materializer polish

**Goal**: Small follow-ups from the code review that improve robustness.

### D.1: Toast on first materializer failure
Replace `console.warn` with a single toast on first failure:
```typescript
let hasWarnedUser = false;
.catch((error) => {
    console.warn('[recording-materializer] write failed:', error);
    if (!hasWarnedUser) {
        hasWarnedUser = true;
        toast.warning("Recording files couldn't be saved to disk. Your recordings are safe. This only affects the markdown export.");
    }
});
```

### D.2: Initial flush optimization (deferred until needed)
When recording count exceeds ~1000, the initial flush sends all recordings in one invoke call. Consider:
- Skip unchanged recordings (compare `updatedAt` with file mtime)
- Chunk into batches of 100

### D.3: Error recovery with full reconcile (deferred)
After any observer failure, schedule a full reconcile that re-syncs all recordings vs files on disk. This handles the case where a failed batch leaves stale `.md` files.

---

## Phase E: Codebase-wide `isTauri()` migration

**Goal**: Replace all 29 occurrences of `window.__TAURI_INTERNALS__` with `isTauri()` from `@tauri-apps/api/core`.

### Scope
- 1 type declaration in `app.d.ts`: keep the `Window` interface augmentation, change runtime checks only
- ~9 platform gate service files (`analytics`, `notifications`, `sound`, `text`, `os`, `db`, `http`, `download`, `tauri-fetch`)
- ~19 runtime guards in components/pages

### Approach
- Add `import { isTauri } from '@tauri-apps/api/core'` to each file
- Replace `window.__TAURI_INTERNALS__` with `isTauri()` in runtime checks
- Replace `!window.__TAURI_INTERNALS__` with `!isTauri()`
- Leave the `app.d.ts` type declaration intact
- Verify each file with LSP diagnostics

### Risk
Low: `isTauri()` is a drop-in replacement. It returns `false` on web, `true` on desktop. Same behavior as `!!window.__TAURI_INTERNALS__`.

---

## Phase F: BlobStore API (future)

**Goal**: Once transformations and runs migrate to workspace (same trajectory as recordings), rename `DbService` → `BlobStore` and design a pluggable blob interface.

**Blocked by**: Transformations/runs must first migrate their metadata to workspace tables. Until then, `DbService` still needs full CRUD for those sections.

### Target interface
```typescript
type BlobStore = {
  save(key: string, blob: Blob): Promise<Result<void, BlobError>>;
  getBlob(key: string): Promise<Result<Blob, BlobError>>;
  delete(key: string | string[]): Promise<Result<void, BlobError>>;
  ensurePlaybackUrl(key: string): Promise<Result<string, BlobError>>;
  revokeUrl(key: string): void;
  clear(): Promise<Result<void, BlobError>>;
};
```

Namespaced by content type (`audio`, `attachments`, `thumbnails`) at the consumer level. One blob store interface, platform-specific implementations (filesystem, IndexedDB, S3, etc.).
