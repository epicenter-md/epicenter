# Execution Prompts for Recording Phases

Copy-paste these prompts to execute each phase in a new session.

---

## Phase B: Slim DB service to audio-only

```
Read specs/20260415T190000-recording-remaining-phases.md, Phase B section.

Execute Phase B on a new branch `refactor/whispering-audio-only-db-service` based on `fix/materializer-review-fixes`.

The workspace is now the sole source of truth for recording metadata. The DB service should become an audio-only blob store.

Key changes:
1. Remove metadata-only methods from DbService.recordings interface (getAll, getLatest, getById, getTranscribingIds, getCount, update)
2. Rename create → saveAudio(recordingId: string, audio: Blob)
3. Simplify delete to accept string | string[] (IDs, not full DbRecording objects)
4. Delete the DbRecording type entirely (models/recordings.ts)
5. Remove markdown serialization functions from file-system.ts (recordingToMarkdown, markdownToRecording, RecordingFrontMatter, etc.): the materializer in client.ts handles this now
6. Update all callers (especially actions.ts and cleanupExpired)

Load skills: workspace-api, services-layer, typescript, error-handling, refactoring

Verify with LSP diagnostics on every changed file. Make surgical, incremental commits.
```

---

## Phase C: Clean up web IndexedDB path

```
Read specs/20260415T190000-recording-remaining-phases.md, Phase C section.

Execute Phase C on the same branch as Phase B (or a new branch based on it).

Simplify the web IndexedDB recording storage to audio-only:
1. RecordingStoredInIndexedDB → { id: string; serializedAudio: SerializedAudio }
2. Remove RecordingStoredInIndexedDbLegacy type
3. Web create drops metadata from IndexedDB row
4. Web delete accepts IDs only

Load skills: typescript, refactoring

Verify with LSP diagnostics.
```

---

## Phase D.1: Toast on first materializer failure

```
In apps/whispering/src/lib/client.ts, replace the console.warn in the materializer's .catch with a pattern that shows a single toast on the first failure:

1. Add a let hasWarnedUser = false; alongside the unsub and syncQueue declarations
2. In the .catch, keep the console.warn, but also check if (!hasWarnedUser) and if so, set it to true and call toast.warning with a user-friendly message explaining their recordings are safe but the markdown export failed
3. Import toast from whatever toast utility this codebase uses (check existing toast imports in the app)

This is a one-file, 5-line change. Quick category.
```

---

## Phase E: Codebase-wide isTauri() migration

```
Read specs/20260415T190000-recording-remaining-phases.md, Phase E section.

Replace all 29 occurrences of window.__TAURI_INTERNALS__ with isTauri() from @tauri-apps/api/core across the Whispering app.

Rules:
- Add import { isTauri } from '@tauri-apps/api/core' to each file
- Replace window.__TAURI_INTERNALS__ → isTauri() in runtime checks
- Replace !window.__TAURI_INTERNALS__ → !isTauri()
- Leave the app.d.ts Window interface augmentation intact (type declaration, not runtime)
- Verify each file with LSP diagnostics after changes

This touches ~29 files. Use AST grep or manual grep to find all occurrences. Work through them systematically. Commit in batches (services, components, pages).

Load skills: typescript, svelte, tauri
```

---
