# Database Service Architecture

## Overview

The database service provides a unified interface for storing and retrieving recordings across different platforms (web and desktop). Each platform uses its own optimal storage format, but both expose the same intermediate representation to the UI layer.

## Key Concepts

### Intermediate Representation vs Storage Format

**`Recording` type** - The intermediate representation used throughout the application:
- Unified interface for UI components
- Contains `blob: Blob | undefined` for audio data
- Same structure whether on desktop or web
- Defined in `models/recordings.ts`

**Storage formats** - How data is actually persisted:
- **Desktop**: Markdown files (.md) + separate audio files (.webm, .mp3)
- **Web**: IndexedDB with serialized audio (`RecordingStoredInIndexedDB`)

### The Pattern

```
Storage Layer          →    Service Layer    →    UI Layer
================            ==============        ==========
Desktop: .md + .webm   →                     →
                            Recording type    →    Components
Web: IndexedDB         →                     →
```

Each storage implementation:
1. Reads from its native format
2. Converts to `Recording` type
3. Returns to UI/service layer

## Desktop Storage (File System)

**Location**: `~/.whispering/recordings/` (or platform-specific app data)

**Format**:
```
recordings/
  abc123.md          ← Metadata (YAML frontmatter + transcribed text)
  abc123.webm        ← Audio file (same ID)
  def456.md
  def456.mp3
```

**Metadata file** (`abc123.md`):
```markdown
---
id: abc123
title: My Recording
subtitle: Quick note
timestamp: 2025-10-28T10:30:00Z
created_at: 2025-10-28T10:30:00Z
updated_at: 2025-10-28T10:35:00Z
transcription_status: DONE
---

This is the transcribed text content.
```

**Audio file**: Stored as separate file with same ID

**Implementation**: `file-system.ts`
- Uses `@tauri-apps/plugin-fs` for file operations
- Uses `gray-matter` to parse YAML frontmatter
- Converts snake_case (YAML) ↔ camelCase (TypeScript)
- Reads audio file and converts to Blob when returning Recording

## Web Storage (IndexedDB)

**Database**: `whispering-db`

**Format**: Single object store `recordings` with schema V5:
```typescript
{
  id: 'abc123',
  title: 'My Recording',
  subtitle: 'Quick note',
  timestamp: '2025-10-28T10:30:00Z',
  createdAt: '2025-10-28T10:30:00Z',
  updatedAt: '2025-10-28T10:35:00Z',
  transcribedText: 'This is the transcribed text...',
  transcriptionStatus: 'DONE',
  serializedAudio: {
    arrayBuffer: ArrayBuffer(...),
    blobType: 'audio/webm'
  }
}
```

**Why serializedAudio?** IndexedDB can't reliably store Blob objects across browsers, so we serialize to ArrayBuffer + mime type.

**Implementation**: `index-db.ts`
- Uses Dexie.js for IndexedDB operations
- Serializes blobs to `{ arrayBuffer, blobType }` when storing
- Deserializes back to Blob when reading

## Migration and Read Optimization (Desktop Only)

Desktop uses an automatic migration system with intelligent read optimization:

### Migration on Startup

When the desktop DB service is created, three migrations run in parallel in the background:
1. **Recordings migration**: Copies recordings + audio blobs to file system, deletes from IndexedDB
2. **Transformations migration**: Copies transformations to file system, deletes from IndexedDB
3. **Transformation runs migration**: Copies runs to file system (keeps in IndexedDB due to no delete interface)

Each migration:
- Is idempotent (safe to run multiple times)
- Preserves original timestamps and IDs
- Deletes successfully migrated data from IndexedDB to free storage
- Logs warnings for individual failures but continues overall migration

### Optimized Reads

Each read method awaits only its relevant migration before deciding how to read:

```typescript
// Example: recordings.getAll()
async function getAll() {
  // Wait for recordings migration to complete
  const { error: migrationError } = await recordingResultPromise;

  if (!migrationError) {
    // Fast path: migration succeeded, only read from file system
    return fileSystem.recordings.getAll();
  }

  // Fallback: migration failed, dual read from both sources
  const [fsResult, idbResult] = await Promise.all([
    fileSystem.recordings.getAll(),
    indexedDB.recordings.getAll(),
  ]);

  // Merge, preferring file system for duplicates
  return mergeDeduplicate(fsResult, idbResult);
}
```

**Fast path** (normal case): Once migration completes, reads only from file system (single source, no merge overhead)

**Fallback path** (migration failure): Dual read from both sources ensures no data loss

### Granular Migration Tracking

Each table tracks its own migration independently:
- `recordings.*` methods await `recordingResultPromise`
- `transformations.*` methods await `transformationResultPromise`
- `runs.*` methods await `runsResultPromise`

This means recordings can switch to fast-path reads as soon as recording migration completes, without waiting for transformation or run migrations.

### Writes

All write operations (create, update, delete) only write to the file system:

```typescript
async function create(recording) {
  // Always write to file system only (never IndexedDB)
  return fileSystem.create(recording);
}
```

This ensures new data goes directly to the target storage format.

### Performance Characteristics

**First app launch** (migration in progress):
- Migrations run in background without blocking app startup
- First read of each table waits for its specific migration (not all migrations)
- If recordings migrate faster than transformations, recording reads switch to fast-path immediately
- Dual-read fallback ensures data is accessible even if migration fails

**Subsequent app launches** (after successful migration):
- Migration checks file system and skips already-migrated items (idempotent)
- Read methods immediately use fast-path (single source, no merge)
- No IndexedDB overhead for recordings and transformations (deleted after migration)
- Significantly reduced storage usage (especially from audio blobs)

**Storage savings**:
- Audio blobs: Deleted from IndexedDB after successful migration
- Recordings metadata: Deleted from IndexedDB
- Transformations: Deleted from IndexedDB
- Runs: Remain in IndexedDB (small metadata, minimal impact)

## Service Interface

All implementations expose the same `DbService` interface:

```typescript
type DbService = {
  recordings: {
    getAll: () => Promise<Result<Recording[], DbServiceError>>;
    getById: (id: string) => Promise<Result<Recording | null, DbServiceError>>;
    create: (recording: Recording) => Promise<Result<Recording, DbServiceError>>;
    update: (recording: Recording) => Promise<Result<Recording, DbServiceError>>;
    delete: (id: string) => Promise<Result<void, DbServiceError>>;
  };
  // ... other stores
};
```

## File Organization

```
src/lib/services/db/
├── README.md              ← This file
├── index.ts               ← Platform-specific db factory
├── types.ts               ← DbService interface and error types
├── models.ts              ← Type definitions (Recording, Transformation, etc.)
├── file-system.ts         ← Desktop file system implementation
├── web.ts                 ← Web IndexedDB implementation (Dexie)
└── desktop.ts             ← Desktop migration + optimized read wrapper
                              - Migration functions (migrateRecordings, etc.)
                              - Per-table migration promises
                              - Intelligent read methods (fast-path vs fallback)
```

## Usage Examples

### Creating a recording

```typescript
import { db } from '$lib/services/db';

const { data: recording, error } = await db.recordings.create({
  id: generateId(),
  title: 'My Recording',
  subtitle: 'Quick note',
  timestamp: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  blob: audioBlob, // From MediaRecorder
  transcribedText: '',
  transcriptionStatus: 'UNPROCESSED',
});
```

### Reading recordings

```typescript
const { data: recordings, error } = await db.recordings.getAll();

// Both platforms return the same Recording type
recordings.forEach(recording => {
  console.log(recording.title);

  // Blob is populated on both platforms
  if (recording.blob) {
    const url = URL.createObjectURL(recording.blob);
    // Use url in <audio> element
  }
});
```

## Migration Path

The long-term plan is to eventually use file system storage on both platforms:

1. **Phase 1** (✅ Complete): Web uses IndexedDB
2. **Phase 2** (✅ Complete): Desktop uses file system with automatic migration from IndexedDB
   - Background migration on app startup
   - Fast-path reads after successful migration
   - Automatic cleanup of IndexedDB storage
3. **Phase 3** (Future): Web uses File System Access API where supported
4. **Phase 4** (Future): Unified file system implementation across platforms

See `docs/specs/20251029T000000 indexeddb-to-filesystem-migration.md` for detailed implementation.
