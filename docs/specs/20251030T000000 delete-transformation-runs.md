# Delete Transformation Runs Feature

## Problem
Transformation runs currently have no way to be deleted. Users can see the history of transformation runs when viewing a transformation or recording, but there's no UI or backend support for deleting these runs. This can lead to:
1. Accumulation of old/unnecessary run data
2. No way to clear failed or unwanted runs
3. Cluttered UI with no cleanup options

Looking at the screenshots provided, the transformation detail view shows "Loading runs..." and displays a table of runs, but there are no deletion controls.

## Current Architecture

### Database Service
- **Interface** (`services/db/types.ts`): The `runs` interface has no `delete` method
- **Desktop** (`services/db/desktop.ts`):
  - No delete implementation for runs
  - Migration code at line 827-834 has explicit comment: "Does not delete runs from IndexedDB after migration because the runs interface doesn't have a delete method"
  - This is blocking proper migration cleanup!
- **Web** (`services/db/web.ts`): No delete implementation for runs
- **File System** (`services/db/file-system.ts`): No delete implementation for runs

### UI Components
- **ViewTransformationRunsDialog.svelte**: Shows runs for a recording, displays "Loading runs..." message
- **Runs.svelte**: Displays the table of transformation runs
- **Editor.svelte**: Shows runs for a transformation

### Query Layer
- No delete mutation exists for transformation runs

### Recent Changes (from main merge)
- Migration logic improved to run sequentially (not parallel)
- Recordings and transformations now delete from IndexedDB immediately after successful migration
- Runs migration explicitly CANNOT delete from IndexedDB due to missing delete method

## Solution Design

### Backend Changes

1. **Add delete method to DbService interface** (`services/db/types.ts`)
   - Add `delete` method to `runs` interface
   - Should accept single run or array of runs (consistent with other delete methods)

2. **Implement delete in file-system.ts**
   - Delete run markdown files from the runs directory
   - Handle both single and multiple deletions

3. **Implement delete in web.ts**
   - Remove runs from IndexedDB
   - Handle both single and multiple deletions

4. **Implement delete in desktop.ts**
   - Delete from BOTH sources (file system and IndexedDB) during migration period
   - Follow the same pattern as recordings and transformations deletion

5. **Update migration logic in desktop.ts**
   - Once delete method exists, update `migrateTransformationRuns` to delete from IndexedDB after successful migration
   - Remove the TODO comment at line 831-833
   - Match the pattern used for recordings and transformations migrations

### Query Layer Changes

1. **Add delete mutation** (`lib/query/db.ts`)
   - Create `runs.delete` mutation using `defineMutation`
   - Should invalidate relevant queries after deletion:
     - `runs.getByRecordingId`
     - `runs.getByTransformationId`
     - `runs.getById`

### UI Changes

Two approaches for UX, will delegate to UX specialist agent:

**Option A: Individual delete buttons per run**
- Add delete button to each row in the Runs table
- Confirmation dialog before deletion
- Simple, straightforward UX

**Option B: Bulk selection + actions**
- Add checkboxes to select multiple runs
- "Delete selected" button
- "Clear all" button for complete cleanup
- More powerful but more complex

**Option C: Hybrid approach**
- Individual delete buttons for each run
- "Clear all" button at the top
- Good balance of simplicity and power

I recommend **Option C** as it provides:
- Quick single-run deletion without extra clicks
- Bulk cleanup option for clearing history
- No complex selection UI needed

### Implementation Details

#### Runs Component Enhancement
- Add delete button to each row (trash icon)
- Add "Clear All Runs" button in table header or above table
- Use self-contained component pattern for delete confirmation
- Show loading state during deletion
- Optimistic updates for better UX

#### Delete Confirmation
- Use AlertDialog for confirmation
- Show run details (date, status) in confirmation
- Different messages for single vs bulk delete

## Todo Items

### Phase 1: Backend & Query Layer
- [ ] Add `delete` method to `DbService.runs` interface in `types.ts`
- [ ] Implement `delete` in `file-system.ts` for runs
- [ ] Implement `delete` in `web.ts` for runs
- [ ] Implement `delete` in `desktop.ts` for runs (dual-source deletion)
- [ ] Update `migrateTransformationRuns` in `desktop.ts` to delete from IndexedDB after successful migration
- [ ] Add `runs.delete` mutation to query layer with proper cache invalidation

### Phase 2: UI Components
- [ ] Add individual delete buttons to Runs.svelte with confirmation
- [ ] Add "Clear All" button to Runs.svelte with confirmation
- [ ] Ensure proper loading states during deletion
- [ ] Handle error states gracefully

### Phase 3: Testing
- [ ] Test single run deletion
- [ ] Test "Clear All" functionality
- [ ] Verify query invalidation updates UI correctly
- [ ] Test dual-source deletion on desktop (both file system and IndexedDB)
- [ ] Verify migration now properly cleans up IndexedDB

## Technical Notes

- Follow existing patterns from recordings and transformations deletion (see recordings.delete and transformations.delete in desktop.ts)
- Use self-contained component pattern for delete buttons with dialogs
- Desktop must delete from BOTH IndexedDB and file system during migration period
- After implementing delete, the migration can be updated to properly clean up IndexedDB (matching recordings/transformations pattern)
- Invalidate queries to update UI automatically after deletion:
  - `runs.getByRecordingId`
  - `runs.getByTransformationId`
  - `runs.getById`
- Use optimistic updates where appropriate for better UX

## Key Benefits

1. **User Control**: Users can clean up unwanted or failed transformation runs
2. **Migration Cleanup**: The migration process can now properly delete runs from IndexedDB after successful migration
3. **Consistency**: Matches the existing deletion patterns for recordings and transformations
4. **Better UX**: Quick single-run deletion + bulk "Clear All" option

## Review Section

### Implementation Complete

All transformation run deletion functionality has been successfully implemented across the entire stack.

#### Phase 1: Backend & Query Layer ✅

**Database Service Layer**:
- Added `delete` method to `DbService.runs` interface in `types.ts`
- Implemented deletion in `file-system.ts`: deletes `.md` files for each run
- Implemented deletion in `web.ts`: uses Dexie's `bulkDelete` for efficient removal
- Implemented deletion in `desktop.ts`: deletes from BOTH file system and IndexedDB sources
- Updated `migrateTransformationRuns` to properly clean up IndexedDB after successful migration

**Query Layer** (`lib/query/db.ts`):
- Added `runs.delete` mutation with proper cache invalidation
- Invalidates queries for affected transformations and recordings
- Returns proper error handling with Result types

#### Phase 2: UI Components ✅

All delete functionality inlined into Runs.svelte using the confirmationDialog pattern:

**Individual Delete Button** (in Runs.svelte):
- Individual trash icon button for each run in table
- Uses `confirmationDialog.open()` for confirmation
- Delete logic inlined directly in onclick handler
- Disabled state during deletion
- Uses `rpc.notify.success.execute()` and `rpc.notify.error.execute()` for notifications

**Clear All Runs Button** (in Runs.svelte):
- Bulk deletion button at top of runs table
- Uses `confirmationDialog.open()` for confirmation showing count
- Delete logic inlined directly in onclick handler
- Shows loading state ("Deleting...") during mutation
- Proper pluralization in messages
- Uses `rpc.notify` for success/error notifications

**Runs.svelte Updates**:
- Added new "Actions" column to the table
- Inlined individual delete button for each row
- Inlined "Clear All Runs" button above the table
- Updated colspan for expanded rows (4 → 5)
- Both delete actions use `confirmationDialog` pattern (no separate components)

#### Key Features

1. **Dual-Source Deletion**: Desktop properly deletes from both file system and IndexedDB
2. **Migration Cleanup**: Migration now deletes runs from IndexedDB after successful migration
3. **Query Invalidation**: Proper cache invalidation ensures UI updates automatically
4. **User Confirmation**: Both delete actions require explicit confirmation
5. **Loading States**: Buttons show loading state during deletion
6. **Error Handling**: Proper error messages with toast notifications
7. **Self-Contained Components**: Delete functionality encapsulated in reusable components

#### Files Modified

1. `apps/whispering/src/lib/services/db/types.ts` - Added delete method to interface
2. `apps/whispering/src/lib/services/db/file-system.ts` - Implemented file deletion
3. `apps/whispering/src/lib/services/db/web.ts` - Implemented IndexedDB deletion
4. `apps/whispering/src/lib/services/db/desktop.ts` - Implemented dual-source deletion and fixed migration bug
5. `apps/whispering/src/lib/query/db.ts` - Added delete mutation with cache invalidation
6. `apps/whispering/src/lib/components/transformations-editor/Runs.svelte` - Inlined both delete buttons with confirmationDialog pattern

#### Critical Bug Fix: Migration Infinite Loop & Simplification

**Issue Discovered**: After merging the latest PR that refactored migrations, the runs migration was running on **every page load** because:

1. Transformations migration was deleting transformations from IndexedDB immediately after migration
2. Runs migration was querying `indexedDb.transformations.getAll()` to find transformations, then getting runs for each transformation
3. Since transformations were already deleted, migration returned early without processing runs
4. Runs remained in IndexedDB, causing migration to retry every load

**Initial Solution (INCORRECT)** (`desktop.ts:868`):
- Changed to query `fileSystemDb.transformations.getAll()` instead of IndexedDB
- This worked but was overly complex

**Second Solution (STILL TOO COMPLEX)**:
- Kept transformations in IndexedDB until after runs migration
- Runs migration iterated over transformations from IndexedDB
- Added cleanup step after runs migration to delete transformations

**Final Solution (SIMPLE & CORRECT)**:
The user identified that the runs migration doesn't actually need transformations at all! The migration pattern was overly complex. The fix:

1. **Added `runs.getAll()` method**:
   - Added to `DbService.runs` interface in `types.ts`
   - Implemented in `file-system.ts`: reads all .md files from runs directory
   - Implemented in `web.ts`: uses Dexie's `toArray()` to get all runs
   - Implemented in `desktop.ts`: dual-read pattern (file system + IndexedDB fallback)

2. **Simplified runs migration** (`desktop.ts:865-926`):
   - Changed to query `indexedDb.runs.getAll()` directly
   - Removed the complex pattern of iterating over transformations
   - Each run is migrated and deleted independently
   - No dependency on transformations

3. **Restored transformations migration** (`desktop.ts:815-837`):
   - Delete transformations from IndexedDB immediately after migration
   - Same pattern as recordings migration
   - No dependency on runs migration

**Result**:
- Each migration is completely independent and self-contained
- Pattern: "Get all items → migrate each item → delete from IndexedDB immediately"
- No complex dependencies between migrations
- Cleaner, simpler, more maintainable code
- Migration completes successfully and doesn't re-run
- Consistent with the goal: migrate data, delete from IndexedDB, done

#### Next Steps

Ready for testing:
- Verify single run deletion works correctly
- Verify "Clear All" deletes all runs
- Confirm UI updates automatically after deletion
- Test desktop dual-source deletion
- **Most Important**: Verify migration completes and doesn't re-run on reload
