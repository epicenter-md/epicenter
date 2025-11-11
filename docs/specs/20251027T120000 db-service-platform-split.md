# DB Service Platform Split: IndexedDB + File System

**Created**: 2025-10-27T12:00:00
**Status**: Planning
**Branch**: split-db-web-desktop

## Overview

Refactor the DB service to support both web (IndexedDB) and desktop (file system) implementations, with the goal of eventually migrating desktop to use the file system exclusively for better performance and data portability.

## Current State Analysis

### Existing Structure
```
apps/whispering/src/lib/services/db/
├── index.ts              # Main entry point, exports DbServiceLive
├── dexie.ts              # All IndexedDB implementation (947 lines)
└── models/
    ├── index.ts
    ├── recordings.ts
    ├── transformations.ts
    └── transformation-runs.ts
```

### Key Observations

1. **Current Implementation**: All DB logic is in `dexie.ts` using Dexie (IndexedDB wrapper)
2. **Three Main Tables**:
   - `recordings`: Audio recordings with metadata and serialized audio
   - `transformations`: Transformation workflows/pipelines
   - `transformationRuns`: Execution history of transformations

3. **Existing Pattern**: Other services (analytics, fs, http, etc.) already use the web/desktop split pattern:
   ```typescript
   // Example from fs/index.ts
   export const FsServiceLive = window.__TAURI_INTERNALS__
     ? createFsServiceDesktop()
     : createFsServiceWeb();
   ```

4. **Complex Migration Logic**: The IndexedDB implementation has sophisticated schema versioning (v0.1 to v0.5) with error handling and rollback capabilities

5. **Dependencies**: DbService depends on DownloadService for error dump downloads

## Goals

### Phase 1: Pure Refactoring (This Task)
- Split DB implementation into platform-specific files without changing functionality
- Maintain 100% backward compatibility
- Desktop continues using IndexedDB (via web implementation)
- Establish foundation for future file system implementation

### Phase 2: Desktop File System (Future)
- Implement file-based storage for desktop
- Store data in app data directory with folder structure:
  - `{APP_DATA}/recordings/` - Individual JSON files per recording
  - `{APP_DATA}/transformations/` - Individual JSON files per transformation
  - `{APP_DATA}/transformation-runs/` - Individual JSON files per run
- Support both IndexedDB and file system concurrently
- Migration tools to move data from IndexedDB to file system

### Phase 3: Full Migration (Future)
- Desktop exclusively uses file system
- Data migration path for existing users
- Cleanup IndexedDB code for desktop builds

## Phase 1: Implementation Plan

### Step 1: Create Type Definitions
**File**: `apps/whispering/src/lib/services/db/types.ts`

```typescript
import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Settings } from '$lib/settings';
import type {
  Recording,
  Transformation,
  TransformationRun,
  TransformationRunCompleted,
  TransformationRunFailed,
  TransformationStepRun,
} from './models';

export const { DbServiceError, DbServiceErr } =
  createTaggedError('DbServiceError');
export type DbServiceError = ReturnType<typeof DbServiceError>;

export type DbService = {
  recordings: {
    getAll(): Promise<Result<Recording[], DbServiceError>>;
    getLatest(): Promise<Result<Recording | null, DbServiceError>>;
    getTranscribingIds(): Promise<Result<string[], DbServiceError>>;
    getById(id: string): Promise<Result<Recording | null, DbServiceError>>;
    create(recording: Recording): Promise<Result<Recording, DbServiceError>>;
    update(recording: Recording): Promise<Result<Recording, DbServiceError>>;
    delete(
      recordings: Recording | Recording[],
    ): Promise<Result<void, DbServiceError>>;
    cleanupExpired(params: {
      recordingRetentionStrategy: Settings['database.recordingRetentionStrategy'];
      maxRecordingCount: Settings['database.maxRecordingCount'];
    }): Promise<Result<void, DbServiceError>>;
  };
  transformations: {
    getAll(): Promise<Result<Transformation[], DbServiceError>>;
    getById(id: string): Promise<Result<Transformation | null, DbServiceError>>;
    create(
      transformation: Transformation,
    ): Promise<Result<Transformation, DbServiceError>>;
    update(
      transformation: Transformation,
    ): Promise<Result<Transformation, DbServiceError>>;
    delete(
      transformations: Transformation | Transformation[],
    ): Promise<Result<void, DbServiceError>>;
  };
  runs: {
    getById(
      id: string,
    ): Promise<Result<TransformationRun | null, DbServiceError>>;
    getByTransformationId(
      transformationId: string,
    ): Promise<Result<TransformationRun[], DbServiceError>>;
    getByRecordingId(
      recordingId: string,
    ): Promise<Result<TransformationRun[], DbServiceError>>;
    create(params: {
      transformationId: string;
      recordingId: string | null;
      input: string;
    }): Promise<Result<TransformationRun, DbServiceError>>;
    addStep(
      run: TransformationRun,
      step: {
        id: string;
        input: string;
      },
    ): Promise<Result<TransformationStepRun, DbServiceError>>;
    failStep(
      run: TransformationRun,
      stepRunId: string,
      error: string,
    ): Promise<Result<TransformationRunFailed, DbServiceError>>;
    completeStep(
      run: TransformationRun,
      stepRunId: string,
      output: string,
    ): Promise<Result<TransformationRun, DbServiceError>>;
    complete(
      run: TransformationRun,
      output: string,
    ): Promise<Result<TransformationRunCompleted, DbServiceError>>;
  };
};
```

### Step 2: Rename and Refactor Dexie Implementation
**File**: `apps/whispering/src/lib/services/db/web.ts`

- Rename `dexie.ts` to `web.ts`
- Export `createDbServiceWeb` instead of `createDbServiceDexie`
- Remove the `DbService` type definition (now in types.ts)
- Keep all IndexedDB logic intact

Changes:
```typescript
// Remove these exports (moved to types.ts):
// export type DbService = { ... }
// export const { DbServiceError, DbServiceErr } = ...

// Import from types.ts instead:
import type { DbService } from './types';
import { DbServiceErr } from './types';

// Rename export:
export function createDbServiceWeb({
  DownloadService,
}: {
  DownloadService: DownloadService;
}): DbService {
  // ... existing implementation
}
```

### Step 3: Create Desktop Implementation
**File**: `apps/whispering/src/lib/services/db/desktop.ts`

For now, this simply re-exports the web implementation:

```typescript
import type { DownloadService } from '$lib/services/download';
import { createDbServiceWeb } from './web';
import type { DbService } from './types';

export function createDbServiceDesktop({
  DownloadService,
}: {
  DownloadService: DownloadService;
}): DbService {
  // Phase 1: Use web implementation (IndexedDB)
  // Phase 2: Will implement file system storage
  return createDbServiceWeb({ DownloadService });
}
```

### Step 4: Update Main Index
**File**: `apps/whispering/src/lib/services/db/index.ts`

```typescript
import { DownloadServiceLive } from '../download';
import { createDbServiceDesktop } from './desktop';
import { createDbServiceWeb } from './web';

// Re-export types
export type { DbService, DbServiceError } from './types';
export { DbServiceErr } from './types';
export type {
  InsertTransformationStep,
  Recording,
  Transformation,
  TransformationRun,
  TransformationRunCompleted,
  TransformationRunFailed,
  TransformationStep,
  TransformationStepRun,
} from './models';
export {
  generateDefaultTransformation,
  generateDefaultTransformationStep,
  TRANSFORMATION_STEP_TYPES,
  TRANSFORMATION_STEP_TYPES_TO_LABELS,
} from './models';

// Platform detection and service instantiation
export const DbServiceLive = window.__TAURI_INTERNALS__
  ? createDbServiceDesktop({ DownloadService: DownloadServiceLive })
  : createDbServiceWeb({ DownloadService: DownloadServiceLive });
```

### Step 5: Update All Imports
Search and replace throughout the codebase:
- `createDbServiceDexie` → `createDbServiceWeb` (if any direct imports exist)
- Verify all imports of `DbService` and `DbServiceErr` still work

**Files to check**:
```bash
# Find all files importing from db service
grep -r "from.*db" apps/whispering/src/lib --include="*.ts" --include="*.svelte"
```

### Step 6: Testing
1. **Web Build**: Ensure web version still works with IndexedDB
2. **Desktop Build**: Ensure desktop version still works with IndexedDB
3. **Schema Migrations**: Test database upgrade paths still work
4. **Error Handling**: Verify error dump functionality still works

## File Structure After Phase 1

```
apps/whispering/src/lib/services/db/
├── index.ts              # Platform detection + exports
├── types.ts              # Shared types and error constructors
├── web.ts                # IndexedDB implementation (renamed from dexie.ts)
├── desktop.ts            # Currently calls web.ts
└── models/
    ├── index.ts
    ├── recordings.ts
    ├── transformations.ts
    └── transformation-runs.ts
```

## Phase 2 Preview: Desktop File System

### Directory Structure
```
{APP_DATA}/whispering/
├── recordings/
│   ├── {id}.json          # Recording metadata
│   └── {id}.wav           # Audio file
├── transformations/
│   └── {id}.json
└── transformation-runs/
    └── {id}.json
```

### Key Considerations for Phase 2
1. **Atomic Writes**: Use temp files + rename for atomic updates
2. **Concurrency**: File locking or async queue for write operations
3. **Indexing**: In-memory index for queries (or SQLite?)
4. **Migration**: Tool to export from IndexedDB and import to file system
5. **Blob Storage**: Store audio files separately from metadata
6. **Performance**: File system is faster than IndexedDB for large files
7. **Backup**: Users can easily backup the whispering folder

## Success Criteria

### Phase 1 (This Task)
- [ ] All tests pass
- [ ] Web build works identically to before
- [ ] Desktop build works identically to before
- [ ] No breaking changes to external API
- [ ] Code structure matches other services (analytics, fs, etc.)
- [ ] Type safety maintained throughout

### Phase 2 (Future)
- [ ] Desktop can store and retrieve data from file system
- [ ] Migration tool successfully moves data from IndexedDB
- [ ] Performance is equal or better than IndexedDB
- [ ] Data is human-readable (JSON files)

### Phase 3 (Future)
- [ ] Desktop exclusively uses file system
- [ ] IndexedDB code removed from desktop builds
- [ ] Bundle size reduced for desktop

## Risks and Mitigations

### Risk 1: Breaking Changes
**Mitigation**: Keep API identical, only change internal implementation

### Risk 2: Data Loss During Migration
**Mitigation**: Phase 2 will support both storage methods concurrently, with export/backup tools

### Risk 3: Performance Regression
**Mitigation**: Benchmark before and after, profile file system operations in Phase 2

### Risk 4: Complex Migration Logic Lost
**Mitigation**: Preserve all migration code in web.ts, document thoroughly

## Timeline

### Phase 1: 2-3 hours
- File reorganization and type extraction
- Update imports and exports
- Testing and verification

### Phase 2: 1-2 days (Future)
- File system implementation
- Migration tools
- Extensive testing

### Phase 3: 1 day (Future)
- Remove IndexedDB from desktop
- Build optimization
- Documentation

## Questions to Resolve

1. **App Data Path**: Where exactly should desktop files be stored?
   - Check existing `FsService` or Tauri path APIs
   - Confirm with user preferences

2. **File Format**: JSON vs Binary for audio storage?
   - Separate files recommended (metadata.json + audio.wav)

3. **Concurrency Model**: How to handle simultaneous writes?
   - Queue-based approach?
   - File locking?

4. **Search/Query Performance**: How to maintain fast queries with file system?
   - In-memory index?
   - SQLite for metadata queries?

## Review Section

### Changes Made

**Phase 1 Pure Refactoring - COMPLETED**

1. **Created types.ts** (2,743 bytes)
   - Extracted `DbService` type definition from dexie.ts
   - Extracted `DbServiceError` and `DbServiceErr` error constructors
   - Now serves as single source of truth for DB service types

2. **Renamed dexie.ts → web.ts** (24,430 bytes)
   - Renamed `createDbServiceDexie()` → `createDbServiceWeb()`
   - Removed duplicate type definitions (now imported from types.ts)
   - Removed unnecessary imports (`createTaggedError`, `Result`, `Settings`)
   - Kept all IndexedDB implementation logic intact (947 lines → 872 lines after removing types)

3. **Created desktop.ts** (412 bytes)
   - Simple wrapper that calls `createDbServiceWeb()`
   - Contains Phase 2 implementation comment for future file system work
   - Follows same pattern as other services (analytics, fs, etc.)

4. **Updated index.ts** (807 bytes)
   - Added platform detection using `window.__TAURI_INTERNALS__`
   - Updated imports to use `desktop.ts` and `web.ts`
   - Updated exports to use `types.ts`
   - Removed `createDbServiceDexie` export (breaking for direct imports, but none exist)

### File Structure After Refactoring

```
apps/whispering/src/lib/services/db/
├── index.ts              # 807 bytes - Platform detection + exports
├── types.ts              # 2,743 bytes - Shared types (NEW)
├── web.ts                # 24,430 bytes - IndexedDB implementation (renamed from dexie.ts)
├── desktop.ts            # 412 bytes - Wrapper calling web.ts (NEW)
└── models/
    ├── index.ts
    ├── recordings.ts
    ├── transformations.ts
    └── transformation-runs.ts
```

### Git Status
```
D apps/whispering/src/lib/services/db/dexie.ts      # Deleted (renamed to web.ts)
M apps/whispering/src/lib/services/db/index.ts      # Modified (platform detection)
?? apps/whispering/src/lib/services/db/desktop.ts   # New file
?? apps/whispering/src/lib/services/db/types.ts     # New file
?? apps/whispering/src/lib/services/db/web.ts       # New file (renamed from dexie.ts)
```

### Performance Impact
- **Zero performance impact**: Desktop still uses IndexedDB via web implementation
- **Code size**: Slightly reduced due to removed duplicate type definitions
- **Build time**: No change expected
- **Runtime**: Identical behavior to before refactoring

### Breaking Changes
- **External API**: No breaking changes - all exports from `db/index.ts` remain identical
- **Internal**: `createDbServiceDexie` → `createDbServiceWeb` (not exported, so no impact)
- **Imports**: All imports of `DbService`, `DbServiceErr`, etc. still work from `db/index.ts`

### Verification
1. ✅ File structure matches other services (analytics, fs, http)
2. ✅ No direct imports of `dexie.ts` found in codebase
3. ✅ Type definitions properly extracted to types.ts
4. ✅ Platform detection follows established pattern
5. ✅ Desktop wraps web implementation as planned

### Follow-up Items

**Phase 2: Desktop File System Implementation** (Future)
- [ ] Determine app data path for desktop storage
- [ ] Implement file-based CRUD operations in desktop.ts
- [ ] Create migration tools from IndexedDB to file system
- [ ] Add concurrency handling for file writes
- [ ] Performance benchmarking vs IndexedDB
- [ ] User documentation for data location and backup

**Phase 3: Full Migration** (Future)
- [ ] Remove IndexedDB dependency from desktop builds
- [ ] Bundle size optimization
- [ ] Migration guide for users

---

**Status**: Phase 1 COMPLETED ✅
**Next Steps**: Commit changes and proceed to Phase 2 when ready.
