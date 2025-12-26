# Custom Notification Sounds Reimplementation

## Background

The original PR (feature/volume-control-for-notification-sound-and-custom-notification-sound-upload) implemented:
1. Volume control for notification sounds (per-sound and global)
2. Custom notification sound upload

The volume control settings were preserved during the merge (stored in `settings.ts`), but the custom sounds database layer needs reimplementation to match main's new architecture.

## Current State After Merge

### What's Preserved
- `settings.ts` - All volume settings (`sound.volume.*`) and custom flags (`sound.custom.*`)
- `LabeledSlider.svelte` - Volume slider component
- `LabeledFileUpload.svelte` - File upload component
- `models/custom-sounds.ts` - Type definitions (`CustomSound`, `CustomSoundUpload`, `CustomSoundMetadata`)
- `sound/+page.svelte` - Full UI with volume controls and file upload zones

### What's Broken
The UI in `sound/+page.svelte` calls these methods that no longer exist:
- `db.saveCustomSound(customSound)` - line 85
- `db.deleteCustomSound(soundKey)` - line 121
- `db.resetDatabase()` - line 151

These were removed when `dexie.ts` was deleted during the merge.

## Current Architecture

Main has moved from a Dexie-only approach to a split architecture:

### Desktop (File System)
- Recordings stored as `.md` (metadata) + `.webm/.mp3` (audio) files
- Location: `~/.whispering/recordings/`
- Uses `@tauri-apps/plugin-fs` for file operations

### Web (IndexedDB)
- Still uses Dexie for audio storage
- Stores `serializedAudio: { arrayBuffer, blobType }`

### The Pattern
```
Desktop: Write audio file → ~/{appData}/recordings/{id}.{ext}
Web: Write to IndexedDB → serializedAudio field
```

## Implementation Plan

### Phase 1: Add Custom Sounds Path

- [ ] Add `CUSTOM_SOUNDS()` to `PATHS.DB` in `constants/paths.ts`
  ```typescript
  async CUSTOM_SOUNDS() {
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const dir = await appDataDir();
    return await join(dir, 'custom-sounds');
  }
  ```

### Phase 2: Extend DbService Type

- [ ] Add `customSounds` namespace to `DbService` in `types.ts`
  ```typescript
  customSounds: {
    get(soundId: WhisperingSoundNames): Promise<Result<Blob | null, DbServiceError>>;
    save(soundId: WhisperingSoundNames, audio: Blob, metadata: CustomSoundMetadata): Promise<Result<void, DbServiceError>>;
    delete(soundId: WhisperingSoundNames): Promise<Result<void, DbServiceError>>;
    getMetadata(soundId: WhisperingSoundNames): Promise<Result<CustomSoundMetadata | null, DbServiceError>>;
  };
  ```

### Phase 3: Implement File System Storage (Desktop)

- [ ] Add custom sounds methods to `file-system.ts`
  - Store as `{soundId}.{ext}` (e.g., `manual-start.mp3`)
  - Store metadata as `{soundId}.json` (fileName, fileSize, uploadedAt, etc.)
  - Directory: `~/{appData}/custom-sounds/`

### Phase 4: Implement IndexedDB Storage (Web)

- [ ] Add `customSounds` table to Dexie schema in `web.ts`
- [ ] Implement same interface as file system

### Phase 5: Wire Up Desktop Service

- [ ] Add custom sounds to `desktop.ts`
- [ ] No migration needed (new feature)

### Phase 6: Update Sound Assets Resolution

- [ ] Modify `sound/assets/index.ts` to check for custom sounds
- [ ] Pattern:
  ```typescript
  async function resolveAudio(soundKey: WhisperingSoundNames) {
    // Check if custom sound exists (from settings flag)
    if (settings.value[`sound.custom.${soundKey}`]) {
      const { data: customBlob } = await db.customSounds.get(soundKey);
      if (customBlob) return customBlob;
    }
    // Fall back to default
    return defaultSounds[soundKey];
  }
  ```

### Phase 7: Update Sound Settings Page

- [ ] Verify `sound/+page.svelte` works with new architecture
- [ ] Update imports if needed (route moved from `(config)` to `(app)/(config)`)

## Files to Modify

1. `src/lib/constants/paths.ts` - Add CUSTOM_SOUNDS path
2. `src/lib/services/db/types.ts` - Add customSounds interface
3. `src/lib/services/db/file-system.ts` - Implement desktop storage
4. `src/lib/services/db/web.ts` - Implement web storage
5. `src/lib/services/db/desktop.ts` - Wire up to service
6. `src/lib/services/db/index.ts` - Export types if needed
7. `src/lib/services/sound/assets/index.ts` - Resolve custom sounds
8. `src/routes/(app)/(config)/settings/sound/+page.svelte` - Verify UI works

## Already Preserved (from merge)

These were kept from the original PR via the `-X theirs` merge strategy applied to non-conflicting files:

- `src/lib/settings/settings.ts` - Volume settings (`sound.volume.*`) and custom flags (`sound.custom.*`)
- `src/lib/components/labeled/LabeledSlider.svelte` - Volume slider component
- `src/lib/components/labeled/LabeledFileUpload.svelte` - File upload component
- `src/lib/services/db/models/custom-sounds.ts` - Type definitions

## Notes

- The settings flags (`sound.custom.{soundKey}`) track whether a custom sound exists
- The actual audio data is stored separately in the file system/IndexedDB
- This follows the same pattern as recordings: metadata in settings, audio in storage

## Implementation Review

### Completed Tasks

- [x] Phase 1: Added `CUSTOM_SOUNDS()` path to `constants/paths.ts`
- [x] Phase 2: Added `sounds` namespace to `DbService` type in `types.ts` (named `sounds` not `customSounds` for brevity)
- [x] Phase 3: Implemented file system storage in `file-system.ts`
  - Added `sounds.get()`, `sounds.save()`, `sounds.delete()`, `sounds.getMetadata()` methods
  - Added `findAudioFileBySoundId()` helper function
  - Audio stored as `{soundId}.{ext}`, metadata as `{soundId}.json`
- [x] Phase 4: Implemented IndexedDB storage in `web.ts`
  - Added `customSounds` Dexie table in version 0.7
  - Implemented same interface as file system
- [x] Phase 5: Wired up desktop service in `desktop.ts`
  - Used file system directly (no dual-read migration needed for new feature)
- [x] Phase 6: Updated sound assets resolution in `sound/assets/index.ts`
  - Changed from `db.getCustomSound()` to `db.sounds.get()`
  - Removed debug console.log statements
- [x] Phase 7: Updated sound settings page
  - Changed `db.saveCustomSound()` to `db.sounds.save()`
  - Changed `db.deleteCustomSound()` to `db.sounds.delete()`
  - Removed unused `resetDatabase()` function
- [x] Added missing settings to `settings.ts`
  - Added `sound.playOn.cpal-*` toggles (missing CPAL sound events)
  - Added `sound.volume` and `sound.volume.*` for volume control
  - Added `sound.custom.*` flags for custom sound tracking

### Files Modified

1. `src/lib/constants/paths.ts` - Added CUSTOM_SOUNDS path
2. `src/lib/services/db/types.ts` - Added sounds namespace to DbService
3. `src/lib/services/db/models/index.ts` - Exported custom sound types
4. `src/lib/services/db/file-system.ts` - Implemented file system storage + helper
5. `src/lib/services/db/web.ts` - Implemented IndexedDB storage + Dexie v0.7 migration
6. `src/lib/services/db/desktop.ts` - Wired up sounds namespace
7. `src/lib/services/sound/assets/index.ts` - Updated resolveAudioSource function
8. `src/routes/(app)/(config)/settings/sound/+page.svelte` - Updated to use new API
9. `src/lib/settings/settings.ts` - Added missing volume and custom sound settings

### Architecture Decision

Used `db.sounds.*` namespace (not `db.customSounds.*`) to match existing patterns like `db.recordings`, `db.transformations`, `db.runs`. The namespace represents what's stored (sounds), not how they differ from defaults (custom).

### Additional Fixes (Post-Implementation)

During svelte-check verification, discovered and fixed additional issues:

1. **`LabeledSlider` not exported** - Added export to `src/lib/components/labeled/index.ts`
2. **`LabeledSwitch.onCheckedChange` not wired up** - The prop was defined but not passed to the underlying Switch component. Fixed by passing `{onCheckedChange}` to the Switch
3. **`settings.value` is read-only** - The settings store exposes a read-only getter. Updated all direct assignments (`settings.value = {...}`) to use `settings.update({...})` method
4. **Missing type annotations** - Added explicit `: number` and `: boolean` type annotations to callback parameters in the template

### Additional Files Modified

10. `src/lib/components/labeled/index.ts` - Added LabeledSlider export
11. `src/lib/components/labeled/LabeledSwitch.svelte` - Wired up onCheckedChange prop to Switch component
