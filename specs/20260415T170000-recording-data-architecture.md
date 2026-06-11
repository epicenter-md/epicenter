# Recording Data Architecture. Where Should Files Live?

**Date**: 2026-04-15
**Status**: Draft
**Author**: AI-assisted
**Supersedes**: `20260415T160000-recording-materializer.md` (narrower scope, explored and abandoned approaches)

## Overview

After migrating the recording schema to V2 and exploring four different approaches to filesystem materialization, we arrived at a fundamental question: should the Whispering desktop app write `.md` files at all? This spec documents the full exploration, the HN-effect concern, and the recommended architecture.

## Journey. How We Got Here

### Phase 1: Schema cleanup (implemented ✓)

Renamed columns (`timestamp` → `recordedAt`, `transcribedText` → `transcript`), dropped redundant fields (`subtitle`, `createdAt`), added `duration`. Workspace `.migrate()` handles V1 → V2 on read. Extracted `Recording` type via `InferTableRow`. Renamed DB service's `Recording` to `DbRecording` to disambiguate.

**Status**: Committed on `refactor/whispering-recording-schema-v2`.

### Phase 2: JS materializer in Tauri (explored, abandoned)

Attempted to wire `createMarkdownMaterializer` into the Tauri desktop app:

1. **DI on the materializer**: Added `io?` and `yaml?` adapters to `createMarkdownMaterializer` so it could run in Bun, Node, or Tauri. Good general improvement, committed to the workspace package.

2. **Tauri IO adapter**: Created `tauriIO` and `tauriYaml` adapters using `@tauri-apps/plugin-fs` and `js-yaml`. Worked, but added a file and an indirection layer.

3. **Async factory problem**: Tauri path APIs are async (`appDataDir()` returns a Promise). The `withWorkspaceExtension` factory must be sync. Attempted to make the factory async. Resulted in hacky code: mutable `let` closures, type lies (`[key]: {}`), duplicate code paths. Reverted.

4. **Lazy dir**: Widened the materializer's `dir` config to accept `string | (() => MaybePromise<string>)`. Resolved inside `whenReady`. Clean, minimal change. This approach worked.

5. **Inlined the serializer**: The 44-line `recording-serializer.ts` had one caller and one export. Inlined the 8-line serialize function into `client.ts`. Net -31 lines.

**Finding**: The JS materializer approach works but adds significant wiring for what's essentially "observe table, write files." Every piece (IO adapter, YAML adapter, lazy dir, serialize function) was individually reasonable but collectively heavy for one table.

### Phase 3: Rust-side materializer (explored, viable)

Explored using Tauri Rust commands instead of JS filesystem operations:

- JS serializes the markdown string (8 lines, already working)
- Rust receives `{ filename, content }` pairs and does atomic writes
- Existing `markdown_reader.rs` already has `read_markdown_files` and `bulk_delete_files`
- Adding `write_markdown_files` completes the read/write/delete surface

**Finding**: Dramatically simpler. No IO adapter, no YAML adapter, no materializer framework. Just an observer that invokes a Rust command. But still raises the question: should the files exist at all?

### Phase 4: Do we need `.md` files? (current question)

The `.md` files in `appDataDir/recordings/` were the source of truth when the DB service owned recording metadata. Now the workspace (Yjs + IndexedDB) is the source of truth. The files are a derived shadow copy.

## Research Findings

### What the `.md` files are used for today

| Use case | Still valid? | Notes |
|---|---|---|
| Source of truth for metadata | **No** | Workspace is the source of truth since the Yjs migration |
| Bulk delete by clearing folder | **Broken** | Deleting the folder doesn't delete workspace data. A materializer would re-create the files on next launch. |
| Human readability / grep | **Marginal** | Files are in `~/Library/Application Support/com.bradenwong.whispering/recordings/`. Not a directory people browse. |
| Debugging | **Marginal** | Occasionally useful during development. Not a user-facing need. |
| Portability / backup | **No** | The workspace (IndexedDB) is the actual data. Backing up `.md` files without the workspace gives you metadata without audio. |
| External tool integration | **No** | No known tools read these files. |

### The HN effect: "I want to own my data as files"

The Hacker News audience values local-first, file-based data ownership. "Your data is just markdown files" is a powerful selling point. But there's a critical distinction:

**What HN users actually want:**

1. Data stored in a human-readable, version-controllable format
2. Ability to read/edit recordings outside the app
3. No vendor lock-in. Data accessible without the app running
4. Files in a directory THEY choose, not buried in `~/Library/Application Support/`

**What the current `.md` files provide:**

1. ✅ Human-readable format
2. ❌ Editing doesn't sync back (workspace is source of truth)
3. ❌ Buried in platform-specific appdata directory
4. ❌ User doesn't choose the location
5. ❌ Incomplete without audio files (which are separate)

**The appdata `.md` files fail the HN test.** They look like "your data as files" but are actually a stale shadow copy in a hidden directory. A user who discovers them and edits one would be confused when changes don't appear in the app.

### What WOULD satisfy the HN audience

Files that are:
- In a user-chosen directory (e.g., `~/Documents/Whispering/` or a git repo)
- The actual source of truth, OR clearly labeled as an export
- Complete (metadata + transcript + link to audio)
- Editable with round-trip sync, OR explicitly read-only exports

The `epicenter.config.ts` + CLI approach handles this properly:
```typescript
// epicenter.config.ts: user chooses the directory
export default defineConfig(
  createWhisperingWorkspace()
    .withExtension('persistence', filesystemPersistence({ filePath: './workspace.db' }))
    .withWorkspaceExtension('materializer', (ctx) =>
      createMarkdownMaterializer(ctx, { dir: './recordings' })
        .table('recordings', { serialize: recordingSerializer })
    )
);
```

The user runs `epicenter serve` or `epicenter push`. Files appear where they chose. The Bun materializer handles it natively. No Tauri adapter needed.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App writes `.md` to appdata? | **No** | Shadow copies in a hidden directory fail both the practical test (nobody reads them) and the HN test (not real ownership). |
| Audio files in appdata? | **Yes** | Audio blobs are too large for Yjs. Desktop needs them on the filesystem for playback (`convertFileSrc`). This is a storage concern, not a data ownership concern. |
| User-facing `.md` export? | **Via `epicenter.config.ts` + CLI** | The established pattern. User chooses directory. Bun materializer works natively. Proper export, not a hidden copy. |
| Two-way sync (file edits → workspace)? | **Not now** | Massive complexity (file watcher, conflict resolution, loop prevention, YAML parse validation). Not worth it for Whispering's use case. The app UI is the editing interface. |
| Remove existing `.md` write path? | **Yes, incrementally** | Phase 3b slims the DB service. Old files on disk are harmless. They just stop being updated. |

## Architecture

### Current (two parallel write paths)

```
processRecordingPipeline()
├── workspace.tables.recordings.set(row)   ← Yjs (source of truth)
└── services.db.recordings.create({        ← DB service (parallel copy)
      recording, audio                         writes {id}.md + {id}.webm
    })
```

### Target (single source of truth + audio-only storage)

```
processRecordingPipeline()
├── workspace.tables.recordings.set(row)   ← Yjs (sole source of truth)
└── audioBlobs.save(id, blob)              ← audio-only ({id}.webm)

Optional export (via CLI, not the app):
epicenter push → createMarkdownMaterializer → user-chosen directory
```

```
{appDataDir}/recordings/
├── {id}.webm     ← audio (kept, needed for playback)
├── {id}.wav      ← audio from native recorder (kept)
└── (no .md)      ← workspace has the metadata
```

## Implementation Plan

### Phase A: Remove `.md` writes from the desktop app

- [ ] **A.1** Remove `recordingToMarkdown` call from `services.db.recordings.create()` in `file-system.ts`: create only writes audio
- [ ] **A.2** Remove `services.db.recordings.update()` method (never called from app code)
- [ ] **A.3** Remove `recordingToMarkdown`, `markdownToRecording`, `RecordingFrontMatter`, `RecordingFrontMatterRaw`, `normalizeRecordingFrontMatter` from `file-system.ts`
- [ ] **A.4** Remove `stringifyFrontmatter` from `frontmatter.ts` if only used by recording writes (check transformation usage first)
- [ ] **A.5** Revert materializer wiring from `client.ts`: back to the simple `createWorkspace(def).withExtension('persistence', indexeddb)` form
- [ ] **A.6** Delete `tauri-materializer-io.ts` (no longer needed)

### Phase B: Slim the DB service to audio-only

(Unchanged from previous spec. Phase 3b)

- [ ] **B.1** Remove metadata-only methods: `getAll`, `getLatest`, `getById`, `getTranscribingIds`, `getCount`
- [ ] **B.2** Rename `create` → `saveAudio` with signature `(recordingId: string, audio: Blob)`
- [ ] **B.3** Simplify `delete` to accept `string | string[]` (IDs, not full objects)
- [ ] **B.4** Remove `DbRecording` type entirely
- [ ] **B.5** Remove `storedRecordingToRecording` from `web/index.ts`
- [ ] **B.6** Update `cleanupExpired` to read from workspace, not DB service

### Phase C: Clean up web (IndexedDB) path

(Unchanged)

- [ ] **C.1** Web `create` becomes audio-only
- [ ] **C.2** Web `delete` accepts IDs only
- [ ] **C.3** Simplify `RecordingStoredInIndexedDB` to `{ id: string; serializedAudio: SerializedAudio }`

### Phase D: CLI export (future, when needed)

- [ ] **D.1** Create `epicenter.config.ts` for Whispering workspace
- [ ] **D.2** Configure the markdown materializer for recordings table
- [ ] **D.3** Document the `epicenter push` workflow for exporting recordings to a user-chosen directory

## Edge Cases

### Existing `.md` files on disk after upgrade

1. User upgrades to the new version
2. App stops writing `.md` files
3. Old `.md` files remain on disk, getting stale
4. Expected: harmless. Files become a frozen snapshot. Users who relied on them can still read them. `read_markdown_files` Rust command still works for migration.

### User expects "delete folder = delete data"

1. User deletes `recordings/` folder
2. Audio files are gone (playback breaks)
3. Recording metadata is still in workspace
4. Expected: recordings appear in the app without audio. User needs to delete via app UI for a clean removal. Document this in migration notes.

### Dexie→workspace migration still needs to read `.md` files

1. `migrate-database.ts` reads from the legacy DB service
2. The legacy read path (`read_markdown_files`, `parseFrontmatter`) must remain functional
3. Expected: migration code stays intact, just no longer writes new `.md` files

## Open Questions

1. **Should old `.md` files be cleaned up on upgrade?**
   - Options: (a) leave them, (b) delete them, (c) move them to a `recordings-archive/` folder
   - **Recommendation**: (a) Leave them. They're harmless. Users who want them gone can delete the folder. Proactively deleting user files feels hostile.

2. **Should the Rust `read_markdown_files` command be removed?**
   - It's currently used for migration and the old desktop DB service read path.
   - **Recommendation**: Keep it until migration is no longer needed (a few versions). Then remove.

3. **Is the `epicenter.config.ts` export path worth building now?**
   - It's the "right" answer for HN-style data ownership, but no user has asked for it yet.
   - **Recommendation**: Defer to Phase D. Build it when there's demand. The materializer infrastructure (DI, lazy dir) is already in place from this work.

## What We Keep From This Exploration

| Change | Status | Keep? |
|---|---|---|
| Schema V2 migration (definition.ts) | Committed | ✅ Yes |
| `InferTableRow` for Recording type | Committed | ✅ Yes |
| `DbRecording` rename | Committed | ✅ Yes |
| Materializer DI (`io?`, `yaml?` config) | Committed | ✅ Yes. Good for CLI/Bun consumers |
| Materializer lazy `dir` (`string \| () => MaybePromise<string>`) | Committed | ✅ Yes. Good general improvement |
| `tauri-materializer-io.ts` | On branch | ❌ Delete. No in-app materializer |
| Materializer wiring in `client.ts` | On branch | ❌ Revert. No in-app materializer |
| Async factory support in `withWorkspaceExtension` | Reverted | ❌ Already reverted (was hacky) |

## Success Criteria

- [ ] Desktop app no longer writes `.md` files to appdata
- [ ] Audio files still work (playback, download, deletion)
- [ ] DB service `recordings` interface is audio-only
- [ ] `DbRecording` type removed
- [ ] Migration from Dexie still works
- [ ] Web platform unaffected
- [ ] No type errors, diagnostics clean

## References

- `apps/whispering/src/lib/services/db/file-system.ts`: Current write path (to be slimmed)
- `apps/whispering/src/lib/services/db/frontmatter.ts`: YAML helpers (may be removable)
- `apps/whispering/src/lib/workspace/definition.ts`: Recording V2 schema
- `apps/whispering/src/lib/client.ts`: Workspace client (revert to simple form)
- `packages/workspace/src/extensions/materializer/markdown/materializer.ts`: Bun materializer (kept for CLI)
- `playground/tab-manager-e2e/epicenter.config.ts`: Example CLI materializer config
- `apps/whispering/src-tauri/src/markdown_reader.rs`: Rust read/delete commands (keep for migration)
