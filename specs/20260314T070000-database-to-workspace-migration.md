# Database to Workspace Migration

**Date**: 2026-03-14
**Status**: Implemented
**Parent**: [20260312T170000-whispering-workspace-polish-and-migration.md](./20260312T170000-whispering-workspace-polish-and-migration.md) (Wave 3, tasks 3.1-3.3)
**Prerequisite**: Wave 1 (schema), Wave 2 (settings separation), defineKv defaults: all complete

## Overview

One-time migration that reads existing recordings and transformations from the old storage layer (Dexie IndexedDB + filesystem via DbService) and writes them into workspace tables (Yjs CRDT). After migration, workspace tables are the single source of truth. Old data stays on disk untouched.

**What migrates:**
- Recordings → `workspace.tables.recordings`
- Transformations → `workspace.tables.transformations` + `workspace.tables.transformationSteps`

**What does NOT migrate (and why):**
- **Transformation runs**: Historical execution logs. Potentially thousands of rows with nested step runs. Low value: users don't revisit old runs. High cost: denormalization + status transform. The app generates new runs going forward via workspace tables.
- **Audio blobs**: On desktop, BlobStore already reads from the same `recordings/` directory where audio files live (`{id}.webm`). On web, audio stays in Dexie until the user clears it. No copying needed.
- **Settings**: Already migrated by the settings-data-migration spec (implemented).

## Platform-specific data sources

### Desktop (Tauri)

Files live in the platform-specific app data directory:
- macOS: `~/Library/Application Support/com.bradenwong.whispering/`
- Windows: `%APPDATA%/com.bradenwong.whispering/`
- Linux: `~/.config/com.bradenwong.whispering/`

```
{appDataDir}/
  recordings/{id}.md       ← YAML frontmatter + transcribed text
  recordings/{id}.webm     ← Audio (BlobStore already reads these)
  transformations/{id}.md  ← Transformation config with nested steps[]
  transformation-runs/     ← SKIPPED (not migrated)
```

The existing `DbServiceLive` (from `db/index.ts`) creates a desktop service that merges IndexedDB + filesystem with FS taking precedence. We read from this service. It handles the dual-read merge for us.

**Audio handling**: `createFileSystemBlobStore(basePath)` uses `findMatchingFiles(basePath, id)` which scans for `{id}.*`. The `recordings/` directory is both the old audio location AND the BlobStore location. **Zero audio copying needed on desktop.**

### Web (Browser)

All data lives in Dexie (IndexedDB), database name `RecordingDB`, version 0.6:

```
recordings:         &id, timestamp, createdAt, updatedAt  (+ serializedAudio inline)
transformations:    &id, createdAt, updatedAt             (+ nested steps[])
transformationRuns: &id, transformationId, recordingId    (SKIPPED)
```

Audio is stored as `serializedAudio: { arrayBuffer: ArrayBuffer, blobType: string }` inline in each recording row. For now, audio stays in Dexie: web users access it via the existing `DbServiceLive` which converts it to Blob on read. No BlobStore migration needed for web v1.

## Migration state machine

Two states in `localStorage['whispering:db-migration']`:

```
(absent)     → check for old data → found? set 'pending' : set 'done'
'pending'    → show dialog → user clicks Migrate → success → set 'done'
                                                 → failure → stays 'pending'
'done'       → skip everything forever
```

**Why a separate key from settings migration?** Settings migration (`whispering:settings-migration`) was automatic and silent. Database migration is dialog-driven because it's heavier and the user should see progress.

**Old data stays.** No deletion. No cleanup UI for v1. Old files sit harmlessly on disk. They can be cleaned up in a future release.

## Data transforms

### 1. Recordings (1:1 field copy)

```
SOURCE: DbServiceLive.recordings.getAll() → Recording[]

Recording {
  id: string
  title: string
  subtitle: string
  timestamp: string
  createdAt: string
  updatedAt: string
  transcribedText: string
  transcriptionStatus: 'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'
}

TARGET: workspace.tables.recordings

{
  id: string            ← same
  title: string         ← same
  subtitle: string      ← same
  timestamp: string     ← same
  createdAt: string     ← same
  updatedAt: string     ← same
  transcribedText: string  ← same
  transcriptionStatus: '...'  ← same, but 'TRANSCRIBING' → 'FAILED' (auto-fail stale)
  _v: 1                 ← add
}
```

**Transform rules:**
- Copy all fields as-is
- Add `_v: 1`
- Any recording with `transcriptionStatus: 'TRANSCRIBING'` → set to `'FAILED'` (stale transcription that was interrupted by upgrade)
- Skip if `workspace.tables.recordings.get(id)` already exists (idempotent)

### 2. Transformations (strip steps, copy metadata)

```
SOURCE: DbServiceLive.transformations.getAll() → Transformation[]

Transformation {
  id: string
  title: string
  description: string
  createdAt: string
  updatedAt: string
  steps: TransformationStepV2[]     ← STRIP, handled separately
}

TARGET: workspace.tables.transformations

{
  id: string            ← same
  title: string         ← same
  description: string   ← same
  createdAt: string     ← same
  updatedAt: string     ← same
  _v: 1                 ← add
}
```

**Transform rules:**
- Copy id, title, description, createdAt, updatedAt
- Add `_v: 1`
- Strip `steps[]` (migrated into transformationSteps table below)
- Skip if already exists in workspace

### 3. Transformation steps (denormalize + field rename)

```
SOURCE: Each transformation.steps[i]

TransformationStepV2 {
  id: string
  version: 2
  type: 'prompt_transform' | 'find_replace'
  'prompt_transform.inference.provider': InferenceProviderId
  'prompt_transform.inference.provider.OpenAI.model': string
  'prompt_transform.inference.provider.Groq.model': string
  'prompt_transform.inference.provider.Anthropic.model': string
  'prompt_transform.inference.provider.Google.model': string
  'prompt_transform.inference.provider.OpenRouter.model': string
  'prompt_transform.inference.provider.Custom.model': string
  'prompt_transform.inference.provider.Custom.baseUrl': string
  'prompt_transform.systemPromptTemplate': string
  'prompt_transform.userPromptTemplate': string
  'find_replace.findText': string
  'find_replace.replaceText': string
  'find_replace.useRegex': boolean
}

TARGET: workspace.tables.transformationSteps

{
  id: string                    ← same
  transformationId: string      ← parent transformation's id
  order: number                 ← array index
  type: '...'                   ← same
  inferenceProvider: '...'      ← from 'prompt_transform.inference.provider'
  openaiModel: string           ← from 'prompt_transform.inference.provider.OpenAI.model'
  groqModel: string             ← from 'prompt_transform.inference.provider.Groq.model'
  anthropicModel: string        ← from 'prompt_transform.inference.provider.Anthropic.model'
  googleModel: string           ← from 'prompt_transform.inference.provider.Google.model'
  openrouterModel: string       ← from 'prompt_transform.inference.provider.OpenRouter.model'
  customModel: string           ← from 'prompt_transform.inference.provider.Custom.model'
  customBaseUrl: string         ← from 'prompt_transform.inference.provider.Custom.baseUrl'
  systemPromptTemplate: string  ← from 'prompt_transform.systemPromptTemplate'
  userPromptTemplate: string    ← from 'prompt_transform.userPromptTemplate'
  findText: string              ← from 'find_replace.findText'
  replaceText: string           ← from 'find_replace.replaceText'
  useRegex: boolean             ← from 'find_replace.useRegex'
  _v: 1                         ← add
}
```

**Field rename mapping (static data structure):**

```typescript
const STEP_FIELD_MAP = {
  'prompt_transform.inference.provider': 'inferenceProvider',
  'prompt_transform.inference.provider.OpenAI.model': 'openaiModel',
  'prompt_transform.inference.provider.Groq.model': 'groqModel',
  'prompt_transform.inference.provider.Anthropic.model': 'anthropicModel',
  'prompt_transform.inference.provider.Google.model': 'googleModel',
  'prompt_transform.inference.provider.OpenRouter.model': 'openrouterModel',
  'prompt_transform.inference.provider.Custom.model': 'customModel',
  'prompt_transform.inference.provider.Custom.baseUrl': 'customBaseUrl',
  'prompt_transform.systemPromptTemplate': 'systemPromptTemplate',
  'prompt_transform.userPromptTemplate': 'userPromptTemplate',
  'find_replace.findText': 'findText',
  'find_replace.replaceText': 'replaceText',
  'find_replace.useRegex': 'useRegex',
} as const;
```

**Transform rules:**
- For each transformation, iterate `steps[]` with index
- Create one workspace row per step
- Add `transformationId` (parent transformation's id)
- Add `order` (array index)
- Rename dot-notation fields → camelCase per STEP_FIELD_MAP
- Add `_v: 1`
- Drop `version` field (old step versioning, not needed in workspace)
- Skip if already exists in workspace

## Implementation plan

### Task 1: Migration function

**File:** `apps/whispering/src/lib/state/migrate-database.ts`

Create `migrateDatabaseToWorkspace()`:

```typescript
export async function migrateDatabaseToWorkspace({
  dbService,
  workspace,
  onProgress,
}: {
  dbService: DbService;
  workspace: WhisperingWorkspace;
  onProgress: (message: string) => void;
}): Promise<MigrationResult>
```

**Steps:**
1. **Await `workspace.whenReady`**: IndexedDB persistence loads async. Without this, the idempotency check (does this recording already exist?) would see an empty Yjs doc and re-migrate everything. Same pattern as `migrate-settings.ts`.
2. Read all recordings from `dbService.recordings.getAll()`
3. Read all transformations from `dbService.transformations.getAll()`
4. For each recording: transform → `workspace.tables.recordings.set(row)` (skip if exists)
5. For each transformation: transform metadata → `workspace.tables.transformations.set(row)` (skip if exists)
6. For each transformation.steps[i]: transform → `workspace.tables.transformationSteps.set(row)` (skip if exists)
7. Return counts: { recordings: { total, migrated, skipped, failed }, transformations: { ... }, steps: { ... } }

**Batch processing:** Process in batches of 100 (same pattern as existing MigrationDialog).

**Error handling:** Per-item try/catch. If one recording fails, log it and continue. Don't abort the whole migration.

**Idempotency:** Check if `workspace.tables.X.get(id)` already exists before writing. Skip if it does.

**Acceptance:**
- [x] Awaits `workspace.whenReady` before any table reads/writes
- [x] Pure function, no imports from Svelte state
- [ ] Returns Result type
  > **Note**: Returns `MigrationResult` directly (not wrapped in Result). Per-item try/catch handles failures internally; the function never throws.
- [x] Handles empty data (no recordings, no transformations)
- [x] Handles per-item failures without aborting
- [x] Logs progress via onProgress callback
---

### Task 2: Migration state check

**File:** `apps/whispering/src/lib/state/migrate-database.ts`

Add `getDatabaseMigrationState()` and `setDatabaseMigrationState()`:

```typescript
const MIGRATION_KEY = 'whispering:db-migration';

type DbMigrationState = 'pending' | 'done';

export function getDatabaseMigrationState(): DbMigrationState | null {
  return localStorage.getItem(MIGRATION_KEY) as DbMigrationState | null;
}

export function setDatabaseMigrationState(state: DbMigrationState): void {
  localStorage.setItem(MIGRATION_KEY, state);
}
```

Add `probeForOldData()`:

```typescript
export async function probeForOldData(dbService: DbService): Promise<boolean> {
  const { data: recordings } = await dbService.recordings.getCount();
  const { data: transformations } = await dbService.transformations.getCount();
  return (recordings ?? 0) > 0 || (transformations ?? 0) > 0;
}
```

**Acceptance:**
- [x] Reads/writes `localStorage['whispering:db-migration']`
- [x] `probeForOldData` returns true only if there's actual data to migrate

---

### Task 3: Adapt migration dialog

**File:** `apps/whispering/src/lib/components/MigrationDialog.svelte`

The existing dialog migrates Dexie → filesystem (within the old storage system). This spec adds a new migration path: DbService → workspace tables.

**The old IDB→FS migration becomes unnecessary.** The new workspace migration reads from `DbServiceLive`, which already merges IDB + FS on desktop. Once data is in workspace tables, the old IDB→FS path serves no purpose. The existing dialog can be repurposed for workspace migration, with the old IDB→FS code deprecated or removed.

**Changes:**
- Replace or extend the dialog factory with `startWorkspaceMigration()` method
- Show "Migrate to Workspace" button when `whispering:db-migration` is `'pending'`
- Call `migrateDatabaseToWorkspace()` with progress logging
- On success: set state to `'done'`, show summary
- On failure: stay `'pending'`, show error + retry

**Acceptance:**
- [x] Dialog shows workspace migration option when state is 'pending'
- [x] Progress logs visible during migration
- [x] Summary shows counts after completion
- [x] Retry works after failure
---

### Task 4: Boot integration

**File:** `apps/whispering/src/routes/(app)/+layout.svelte` (or `_layout-utils/`)

On app mount:
1. Check `localStorage['whispering:db-migration']`
2. If absent: create a `DbService` instance (import `DbServiceLive` from `$lib/services/db`) and call `probeForOldData(dbService)` → set `'pending'` or `'done'`
3. If `'pending'`: show migration dialog (or toast with "Migrate" button)
4. If `'done'`: skip

**Note:** `DbServiceLive` is already a module-level singleton that auto-detects platform (desktop vs web). Importing it for the probe is lightweight: it doesn't read data, just checks counts.

**Acceptance:**
- [x] Fresh install \u2192 no dialog, state set to 'done'
- [x] Existing user with data \u2192 dialog shown
- [x] After successful migration \u2192 no dialog on next boot
---

### Task 5: Verify and test

**Manual testing:**
1. Desktop with existing recordings + transformations on filesystem
2. Web with existing data in Dexie
3. Verify recordings appear in workspace tables after migration
4. Verify transformation steps are properly denormalized (check field names, order, FK)
5. Verify stale 'TRANSCRIBING' recordings are set to 'FAILED'
6. Verify idempotency: run migration twice, no duplicates
7. Verify old data is untouched after migration

**Acceptance:**
- [x] `bun typecheck` in `apps/whispering` passes (7 pre-existing errors in packages/ui and packages/workspace, none in changed files)
- [ ] Desktop migration works (filesystem \u2192 workspace) \u2014 requires manual testing
- [ ] Web migration works (Dexie \u2192 workspace) \u2014 requires manual testing
- [ ] Idempotent (re-running produces same result) \u2014 requires manual testing
- [ ] Old data preserved \u2014 requires manual testing

## Execution order

```
Task 1 (migration function) ──► Task 2 (state check)
                                     │
Task 3 (dialog adaptation)  ◄───────┘
                                     │
Task 4 (boot integration)  ◄────────┘
                                     │
Task 5 (verification)      ◄────────┘
```

Tasks 1 and 2 can be done together (same file). Task 3 depends on 1+2. Task 4 depends on 2+3.

## Edge cases

### User has no old data (fresh install)
1. `probeForOldData()` returns false
2. State set to `'done'` immediately
3. No dialog ever shown

### Migration crashes mid-way
1. State stays `'pending'` (only set to `'done'` after full success)
2. On next boot: dialog shown again
3. Idempotent: already-migrated records are skipped

### Transformation has zero steps
1. Transformation metadata still migrates
2. No transformationSteps rows created
3. This is valid: user created an empty transformation

### V1 transformation steps (no Custom provider fields)
1. The `DbServiceLive` already uses the migrating validator (`TransformationStep` type) which pipes V1 → V2
2. By the time we read steps, they're always V2
3. No special handling needed in migration

### Recording with 'TRANSCRIBING' status
1. The upgrade interrupted a live transcription
2. Set status to `'FAILED'`: the transcription cannot resume after storage migration
3. User can re-transcribe from the recording detail page

### Web: Recording has no serializedAudio
1. Some recordings may have `serializedAudio: undefined` (audio was deleted or never recorded)
2. Recording metadata still migrates
3. Audio is simply not available: same behavior as before migration

## Why we don't migrate runs

Transformation runs are execution logs. They record that "at 3:47pm, transformation X was applied to recording Y with result Z." They're useful for history but:

1. **Volume**: A user with 100 transformations and 500 recordings could have thousands of runs, each with nested stepRuns. Migrating this is the most data-heavy part.
2. **Denormalization cost**: Each run's `stepRuns[]` array must be broken into `transformationStepRuns` rows with `transformationRunId`, `order`, and status transforms. Significant code and risk.
3. **Low value**: Users rarely revisit old transformation runs. The app generates new runs going forward.
4. **Status complexity**: Runs have `running/completed/failed` discriminated unions. Step runs also have discriminated unions. Mapping all combinations correctly is error-prone.
5. **No sync benefit**: Old runs are historical. Syncing them across devices provides near-zero value.

Old runs stay in the old storage (Dexie/filesystem). The app can continue reading them via `DbServiceLive` for historical display if needed, or we can simply stop showing them.

## Future work

### Query layer switch (separate spec)

This spec copies data into workspace tables, but the app's read/write path (`$lib/query/db.ts`, `$lib/query/transcription.ts`) still reads from `DbServiceLive`. A separate spec is needed to switch the query layer from DbService → workspace tables. Until that happens, workspace tables hold the data but aren't actively read by the UI.

### Markdown materializer extension

A separate spec will cover a Yjs persistence extension that materializes workspace data back to human-readable markdown files on disk (desktop only). When that extension runs, it will naturally overwrite the old `.md` files with workspace data: effectively cleaning up old files without explicit deletion logic.

## References

- `apps/whispering/src/lib/services/db/web.ts`: Dexie DB definition, version 0.6
- `apps/whispering/src/lib/services/db/desktop.ts`: Desktop dual-read facade
- `apps/whispering/src/lib/services/db/models/`: Old model types (Recording, Transformation, TransformationStep V1/V2, TransformationRun)
- `apps/whispering/src/lib/services/blob-store/`: BlobStore interface + FS/IDB implementations (already exist)
- `apps/whispering/src/lib/workspace.ts`: Target workspace table schemas
- `apps/whispering/src/lib/components/MigrationDialog.svelte`: Existing migration dialog (IDB→FS, being repurposed)
- `apps/whispering/src/lib/constants/paths.ts`: Desktop file paths (appDataDir)
- `apps/whispering/src/lib/state/migrate-settings.ts`: Settings migration (pattern reference, especially `workspace.whenReady` usage)
- `specs/20260313T163000-settings-data-migration.md`: Settings migration spec (implemented)

## Review

**Completed**: 2026-03-14

### Summary

Implemented a one-time migration from the old DbService storage layer (Dexie IndexedDB + filesystem) into Yjs workspace tables. The migration function reads from `DbServiceLive` (which auto-merges IDB+FS on desktop), transforms and writes data into workspace tables, and marks the migration as done in localStorage.

### Files Changed

- **`apps/whispering/src/lib/state/migrate-database.ts`** (NEW): Core migration function (`migrateDatabaseToWorkspace`), localStorage state helpers (`getDatabaseMigrationState`, `setDatabaseMigrationState`), probe function (`probeForOldData`), and explicit step field rename mapping
- **`apps/whispering/src/lib/components/MigrationDialog.svelte`**: Replaced 1418-line IDB→FS dialog with ~410-line workspace migration dialog. Removed old `_migrateRecordings`/`_migrateTransformations`/`_migrateTransformationRuns` internals. New dialog delegates to `migrateDatabaseToWorkspace()` via `startWorkspaceMigration()`. Dev tools (seed/clear) retained.
- **`apps/whispering/src/routes/(app)/+layout.svelte`**: Added async boot check: on first launch, probes for old data via `probeForOldData(DbServiceLive)` and sets migration state to 'pending' or 'done'. Initializes `migrationDialog.isPending` reactively.

### Deviations from Spec

- **Return type**: `migrateDatabaseToWorkspace` returns `MigrationResult` directly instead of `Result<MigrationResult, E>`. Per-item errors are caught internally and counted in the result. The dialog wraps the call in `tryAsync` for unexpected errors.
- **Boot location**: Migration check runs as an async IIFE in `+layout.svelte` (alongside existing `migrateOldSettings()` call) rather than a separate utility file.
- **Dialog initialization**: `isPending` initializes from localStorage synchronously in the factory, with the async probe handling the null (first boot) case from the layout.

### Follow-up Work

- Query layer switch (separate spec): switch UI reads from DbService → workspace tables
- Manual testing on desktop (filesystem data) and web (Dexie data)
- Idempotency verification with real data
