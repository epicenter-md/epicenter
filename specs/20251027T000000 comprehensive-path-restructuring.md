# Comprehensive Model Path Restructuring

## Problem

Multiple redundant path patterns existed in the codebase:

1. `{appDataDir}/whispering/models` - Redundant "whispering" (appDataDir already contains `com.bradenwong.whispering`)
2. `{appDataDir}/whisper-models` - Not organized under a common models directory
3. `{appDataDir}/parakeet-models` - Not organized under a common models directory

## Solution

Unified structure under a single `models` directory:

```
{appDataDir}/models/
├── whisper/     (Whisper.cpp models)
└── parakeet/    (Parakeet models)
```

### Path Mappings

| Old Path | New Path |
|----------|----------|
| `{appDataDir}/whispering/models` | `{appDataDir}/models` |
| `{appDataDir}/whisper-models` | `{appDataDir}/models/whisper` |
| `{appDataDir}/parakeet-models` | `{appDataDir}/models/parakeet` |

## Implementation

### 1. Created New PATHS Structure

**File**: `apps/whispering/src/lib/constants/paths.ts`

Restructured to use nested object with uppercase constants:

```typescript
export const PATHS = {
  MODELS: {
    async WHISPER() {
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const dir = await appDataDir();
      return await join(dir, 'models', 'whisper');
    },
    async PARAKEET() {
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const dir = await appDataDir();
      return await join(dir, 'models', 'parakeet');
    },
  },
  // Deprecated for backward compatibility
  async whisperModelsDirectory() {
    return await PATHS.MODELS.WHISPER();
  },
};
```

### 2. Updated LocalModelDownloadCard

**File**: `apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte`

- Removed top-level imports of `appDataDir` and `join`
- Dynamically imports `PATHS` and `join` within functions
- Uses `PATHS.MODELS.WHISPER()` and `PATHS.MODELS.PARAKEET()` for path resolution
- Fully lazy-loaded Tauri dependencies

### 3. Comprehensive Migration

**File**: `apps/whispering/src/lib/services/migration.ts`

Handles three separate migrations:

1. **Legacy whispering/models migration**:
   - Moves `{appDataDir}/whispering/models` → `{appDataDir}/models`
   - Handles existing models directory

2. **Whisper models migration**:
   - Moves `{appDataDir}/whisper-models` → `{appDataDir}/models/whisper`
   - Creates parent directory if needed

3. **Parakeet models migration**:
   - Moves `{appDataDir}/parakeet-models` → `{appDataDir}/models/parakeet`
   - Creates parent directory if needed

Each migration:
- Checks if old path exists before attempting migration
- Handles cases where both paths exist
- Logs all operations for debugging
- Non-fatal: errors don't block app startup
- Runs sequentially to ensure directory structure is ready

## Files Modified

1. ✅ `apps/whispering/src/lib/constants/paths.ts` - New PATHS.MODELS structure
2. ✅ `apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte` - Updated to use new paths
3. ✅ `apps/whispering/src/lib/services/migration.ts` - Comprehensive three-stage migration
4. ✅ `apps/whispering/src/routes/+layout/AppShell.svelte` - Calls migration on mount

## Benefits

### Code Organization
- **Single source of truth**: All model paths defined in `PATHS.MODELS`
- **Clear hierarchy**: `models/whisper` and `models/parakeet` clearly show organization
- **Scalable**: Easy to add new model types under `PATHS.MODELS`

### User Experience
- **Transparent migration**: Existing users see models automatically moved
- **No data loss**: Migration checks ensure safe moves
- **Clean directory structure**: No redundant nesting or scattered directories

### Performance
- **Fully lazy**: All Tauri imports happen inside functions
- **Smaller web bundle**: Tauri dependencies excluded from web build
- **Faster startup**: No unnecessary import parsing

## Migration Strategy

**Graceful, sequential migrations:**

1. Check for legacy `whispering/models` → migrate to `models`
2. Check for legacy `whisper-models` → migrate to `models/whisper`
3. Check for legacy `parakeet-models` → migrate to `models/parakeet`

Each migration:
- Only runs if old path exists
- Skips if already migrated (empty old directory)
- Warns if both paths have content
- Creates parent directories as needed
- Errors are logged but non-fatal

## Testing Checklist

- [ ] New installations use correct paths
- [ ] Existing Whisper models migrate correctly
- [ ] Existing Parakeet models migrate correctly
- [ ] Legacy whispering/models migrates correctly
- [ ] App works normally after migration
- [ ] No data loss during any migration
- [ ] Console logs show migration progress
- [ ] Migration handles edge cases (both paths exist, empty dirs, etc.)

## Removal Plan

Migration code should be removed in **v7.7.0 or later** once most users have upgraded:

**Files to clean up:**
- `apps/whispering/src/lib/services/migration.ts` (delete entire file)
- `apps/whispering/src/routes/+layout/AppShell.svelte` (remove migration call in onMount)
- `apps/whispering/src/lib/constants/paths.ts` (remove deprecated `whisperModelsDirectory`)

**Search for**: `TODO: Remove` comments in these files

## Example Paths

### macOS
- Old: `/Users/braden/Library/Application Support/com.bradenwong.whispering/whispering/models`
- Old: `/Users/braden/Library/Application Support/com.bradenwong.whispering/whisper-models`
- Old: `/Users/braden/Library/Application Support/com.bradenwong.whispering/parakeet-models`
- **New**: `/Users/braden/Library/Application Support/com.bradenwong.whispering/models/whisper`
- **New**: `/Users/braden/Library/Application Support/com.bradenwong.whispering/models/parakeet`

### Windows
- Old: `C:\Users\braden\AppData\Roaming\com.bradenwong.whispering\whispering\models`
- Old: `C:\Users\braden\AppData\Roaming\com.bradenwong.whispering\whisper-models`
- Old: `C:\Users\braden\AppData\Roaming\com.bradenwong.whispering\parakeet-models`
- **New**: `C:\Users\braden\AppData\Roaming\com.bradenwong.whispering\models\whisper`
- **New**: `C:\Users\braden\AppData\Roaming\com.bradenwong.whispering\models\parakeet`

## Why This is Better

1. **Cleaner paths**: No redundant "whispering" or scattered model directories
2. **Better organization**: All models under one `models/` directory
3. **Easier maintenance**: Clear PATHS.MODELS.* API
4. **Backward compatible**: Deprecated path still works, migration handles existing users
5. **Scalable**: Easy to add `PATHS.MODELS.FUTURE_ENGINE()` later
