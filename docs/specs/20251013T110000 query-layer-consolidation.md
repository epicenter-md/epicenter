# Query Layer Consolidation

## Date
October 13, 2025

## Overview
Consolidated the query layer into a single `query/db.ts` file that mirrors the exact same structure as the database service layer, providing consistency and improved organization.

## Changes Made

### 1. Created Consolidated `query/db.ts`
- Single file containing all database query operations
- Mirrors the exact same namespace structure as `services.db`
- Three main namespaces: `recordings`, `transformations`, and `runs`

### 2. Updated Query Keys
Consolidated all query keys into a single `dbKeys` object with the same namespace structure:
```typescript
export const dbKeys = {
  recordings: {
    all: ['db', 'recordings'] as const,
    latest: ['db', 'recordings', 'latest'] as const,
    byId: (id: string) => ['db', 'recordings', id] as const,
  },
  transformations: {
    all: ['db', 'transformations'] as const,
    byId: (id: string) => ['db', 'transformations', id] as const,
  },
  runs: {
    byTransformationId: (id: string) => ['db', 'runs', 'transformationId', id] as const,
    byRecordingId: (id: string) => ['db', 'runs', 'recordingId', id] as const,
  },
};
```

### 3. API Structure
The new API exactly mirrors the database service structure:
- `rpc.db.recordings.getAll` (was `rpc.recordings.getAllRecordings`)
- `rpc.db.recordings.getLatest` (was `rpc.recordings.getLatestRecording`)
- `rpc.db.recordings.getById` (was `rpc.recordings.getRecordingById`)
- `rpc.db.recordings.create` (was `rpc.recordings.createRecording`)
- `rpc.db.recordings.update` (was `rpc.recordings.updateRecording`)
- `rpc.db.recordings.delete` (was `rpc.recordings.deleteRecording/deleteRecordings`)
- `rpc.db.transformations.*` (similar pattern)
- `rpc.db.runs.*` (was `rpc.transformationRuns.*`)

### 4. Updated All Component Imports
Systematically updated all component imports throughout the codebase to use the new `rpc.db.*` pattern.

### 5. Removed Old Files
- Deleted `query/recordings.ts`
- Deleted `query/transformations.ts`
- Deleted `query/transformation-runs.ts`

## Files Modified
- Created: `/apps/whispering/src/lib/query/db.ts`
- Modified: `/apps/whispering/src/lib/query/index.ts`
- Modified: All components using database queries (21 files total)
- Modified: `/apps/whispering/src/lib/query/transformer.ts` (updated key imports)
- Modified: `/apps/whispering/src/lib/query/transcription.ts` (updated to use db)
- Modified: `/apps/whispering/src/lib/query/commands.ts` (updated to use db)
- Removed: 3 old query files

## Benefits
1. **Perfect Consistency**: Query layer now mirrors database service structure exactly
2. **Single Source of Truth**: All database queries in one consolidated file
3. **Better Discoverability**: `rpc.db.*` makes it clear these are database operations
4. **Simpler Imports**: One import for all database operations
5. **Cleaner API**: Method names are shorter within their namespace context
6. **Easier Maintenance**: Changes to database queries are centralized

## Migration Examples
```typescript
// Before
import { rpc } from '$lib/query';
rpc.recordings.getAllRecordings
rpc.transformations.queries.getAllTransformations
rpc.transformationRuns.getTransformationRunsByRecordingId

// After
import { rpc } from '$lib/query';
rpc.db.recordings.getAll
rpc.db.transformations.getAll
rpc.db.runs.getByRecordingId
```

## Verification
- All TypeScript checks pass
- No remaining references to old query modules
- All components successfully migrated to new API
- Transformer and other dependent modules updated

## Review
This consolidation successfully creates a clean, unified query layer that perfectly mirrors the database service structure. The consistency between the two layers makes the codebase more intuitive and maintainable. The consolidation reduces the number of files while improving organization and discoverability of database operations.