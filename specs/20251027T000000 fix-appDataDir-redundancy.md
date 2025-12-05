# Fix appDataDir Redundant Path

## Problem
Currently using `${appDataDir()}/whispering/models` which creates redundant nesting since `appDataDir()` already returns `.../com.bradenwong.whispering/`.

Results in: `.../com.bradenwong.whispering/whispering/models` ❌

Should be: `.../com.bradenwong.whispering/models` ✅

## Implementation Plan

### 1. Update paths.ts
- [x] Change `${dir}/whispering/models` to `${dir}/models`
- Location: `apps/whispering/src/lib/constants/paths.ts` line 5

### 2. Create Migration Utility
- [x] Create `apps/whispering/src/lib/services/migration.ts`
- [x] Implement function to:
  - Check if old path exists: `{appDataDir}/whispering/models`
  - If exists, move contents to new path: `{appDataDir}/models`
  - Handle errors gracefully (log but don't block app)
- [x] Add TODO comment to remove migration in v7.7.0 or later

### 3. Hook Migration into App Load
- [x] Found app initialization point: `src/routes/+layout/AppShell.svelte`
- [x] Call migration utility in `onMount()` via dynamic import
- [x] Ensured it runs early in app lifecycle, before other operations
- [x] Run only on desktop/Tauri environment (checks `window.__TAURI_INTERNALS__`)

### 4. Test Migration
- [ ] Manually create old path structure with dummy model files
- [ ] Run app and verify files move to new location
- [ ] Verify app works with models at new location
- [ ] Test when old path doesn't exist (no-op case)

## Files Modified

1. ✅ `apps/whispering/src/lib/constants/paths.ts` - Fixed the path
2. ✅ `apps/whispering/src/lib/services/migration.ts` - New file for migration logic (simplified single function)
3. ✅ `apps/whispering/src/routes/+layout/AppShell.svelte` - App initialization (added migration call in onMount)

## Migration Strategy

**Graceful, one-time migration:**
- Check if `{appDataDir}/whispering/models` exists
- If yes, move entire directory to `{appDataDir}/models`
- If no, skip silently (new user or already migrated)
- Errors are logged but don't block app startup
- Add TODO to remove this migration code in v7.7.0 or later

## Breaking Changes

None - migration code handles existing users transparently.

---

## Review

### Changes Made

1. **Updated `paths.ts`**: Changed `${dir}/whispering/models` to `${dir}/models` to remove redundant path nesting.

2. **Created `migration.ts`**: Single simplified function `migrateModelPaths()` that:
   - Dynamically imports Tauri dependencies inside function body (keeps imports lazy)
   - Checks if old path (`{appDataDir}/whispering/models`) exists
   - Safely moves entire directory to new path (`{appDataDir}/models`) if found
   - Handles edge cases (both paths exist, empty old path, etc.)
   - Logs all operations to console for debugging
   - Never blocks app startup (errors are caught and logged)
   - Includes TODO comments to remove in v7.7.0
   - Combined what was originally `runMigrations()` and `migrateModelPaths()` into single function

3. **Integrated migration into app load**: Added migration call in `AppShell.svelte` `onMount()`:
   - Runs only on desktop (checks `window.__TAURI_INTERNALS__`)
   - Uses dynamic import with `.then()` for clean inline call: `await import('...').then(m => m.migrateModelPaths())`
   - Executes early in app lifecycle, before other operations
   - Moved from `$effect()` in `+layout.svelte` to `onMount()` in `AppShell.svelte` for better control

### Why This Works

- **Tauri's `appDataDir()`** already returns a path with the bundle identifier:
  - macOS: `/Users/{user}/Library/Application Support/com.bradenwong.whispering`
  - Windows: `C:\Users\{user}\AppData\Roaming\com.bradenwong.whispering`

- Adding `/whispering/models` created redundant nesting with "whispering" appearing twice in the path

- The fix simplifies paths to `{appDataDir}/models` which is cleaner and more conventional

### Migration Safety

- Uses Tauri's `rename()` API which is atomic on most filesystems
- Checks both old and new paths before moving
- Gracefully handles all edge cases
- Non-fatal: errors don't prevent app from starting
- One-time: only runs if old path exists

### Testing Needed

Manual testing should verify:
1. New installations work correctly with new path
2. Existing users see models automatically migrated on first launch
3. App functions normally after migration
4. No data loss during migration

### Removal Plan

Migration code should be removed in v7.7.0 (or a few releases later) once most users have upgraded and had the migration run. Look for TODO comments in:
- `apps/whispering/src/lib/services/migration.ts` (entire file can be deleted)
- `apps/whispering/src/routes/+layout/AppShell.svelte` (remove migration call and import in onMount)
