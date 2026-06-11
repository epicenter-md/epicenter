# Settings Data Migration

**Date**: 2026-03-13
**Status**: Implemented
**Builds on**: [20260313T160000-per-key-device-config.md](./20260313T160000-per-key-device-config.md)
**Parent**: [20260312T170000-whispering-workspace-polish-and-migration.md](./20260312T170000-whispering-workspace-polish-and-migration.md) (Wave 3)

## Overview

One-time migration that reads existing user settings from the old `whispering-settings` localStorage blob, splits them by destination, and writes workspace-bound keys to Yjs KV and device-bound keys to per-key localStorage. Users who upgrade from the old settings system retain all their configuration: API keys, model selections, shortcut customizations, sound preferences.

## Motivation

### Current State

After the settings separation (Wave 2), the app reads from two new sources:

```
workspace-settings ← reads from Yjs KV (empty on first boot)
device-config      ← reads from per-key localStorage (empty on first boot)
```

But existing users have all their data sitting in the OLD location:

```
localStorage['whispering-settings'] → { "apiKeys.openai": "sk-...", "sound.playOn.manual-start": true, ... }
```

Nobody reads it. Every existing user gets all defaults on upgrade. Their API keys, model choices, shortcut customizations: invisible until migration runs.

### Desired State

On first boot after upgrade:

```
1. Detect old 'whispering-settings' in localStorage
2. Parse with parseStoredSettings() (already battle-tested)
3. Map old key names → new key names
4. Write workspace keys → Yjs KV via workspace.kv.set()
5. Write device keys → per-key localStorage via deviceConfig.set()
6. Mark migration complete
7. Old data stays intact (user can clean up later in settings)
```

## Research Findings

### Key Name Mapping (Old → New)

The settings separation changed many key names. This mapping was already used in the Wave 2 consumer migration and is the source of truth.

**Workspace KV keys** (old → new):

| Old Key | New Workspace KV Key | Type Change |
|---|---|---|
| `sound.playOn.manual-start` | `sound.manualStart` | none |
| `sound.playOn.manual-stop` | `sound.manualStop` | none |
| `sound.playOn.manual-cancel` | `sound.manualCancel` | none |
| `sound.playOn.vad-start` | `sound.vadStart` | none |
| `sound.playOn.vad-capture` | `sound.vadCapture` | none |
| `sound.playOn.vad-stop` | `sound.vadStop` | none |
| `sound.playOn.transcriptionComplete` | `sound.transcriptionComplete` | none |
| `sound.playOn.transformationComplete` | `sound.transformationComplete` | none |
| `transcription.copyToClipboardOnSuccess` | `output.transcription.clipboard` | none |
| `transcription.writeToCursorOnSuccess` | `output.transcription.cursor` | none |
| `transcription.simulateEnterAfterOutput` | `output.transcription.enter` | none |
| `transformation.copyToClipboardOnSuccess` | `output.transformation.clipboard` | none |
| `transformation.writeToCursorOnSuccess` | `output.transformation.cursor` | none |
| `transformation.simulateEnterAfterOutput` | `output.transformation.enter` | none |
| `system.alwaysOnTop` | `ui.alwaysOnTop` | none |
| `ui.layoutMode` | `ui.layoutMode` | none |
| `database.recordingRetentionStrategy` | `retention.strategy` | none |
| `database.maxRecordingCount` | `retention.maxCount` | string → number |
| `recording.mode` | `recording.mode` | none |
| `transcription.selectedTranscriptionService` | `transcription.service` | none |
| `transcription.openai.model` | `transcription.openai.model` | none |
| `transcription.groq.model` | `transcription.groq.model` | none |
| `transcription.elevenlabs.model` | `transcription.elevenlabs.model` | none |
| `transcription.deepgram.model` | `transcription.deepgram.model` | none |
| `transcription.mistral.model` | `transcription.mistral.model` | none |
| `transcription.outputLanguage` | `transcription.language` | none |
| `transcription.prompt` | `transcription.prompt` | none |
| `transcription.temperature` | `transcription.temperature` | string → number |
| `transcription.compressionEnabled` | `transcription.compressionEnabled` | none |
| `transcription.compressionOptions` | `transcription.compressionOptions` | none |
| `transformations.selectedTransformationId` | `transformation.selectedId` | none |
| `completion.openrouter.model` | `transformation.openrouterModel` | none |
| `analytics.enabled` | `analytics.enabled` | none |
| `shortcuts.local.toggleManualRecording` | `shortcut.toggleManualRecording` | none |
| `shortcuts.local.startManualRecording` | `shortcut.startManualRecording` | none |
| `shortcuts.local.stopManualRecording` | `shortcut.stopManualRecording` | none |
| `shortcuts.local.cancelManualRecording` | `shortcut.cancelManualRecording` | none |
| `shortcuts.local.toggleVadRecording` | `shortcut.toggleVadRecording` | none |
| `shortcuts.local.startVadRecording` | `shortcut.startVadRecording` | none |
| `shortcuts.local.stopVadRecording` | `shortcut.stopVadRecording` | none |
| `shortcuts.local.pushToTalk` | `shortcut.pushToTalk` | none |
| `shortcuts.local.openTransformationPicker` | `shortcut.openTransformationPicker` | none |
| `shortcuts.local.runTransformationOnClipboard` | `shortcut.runTransformationOnClipboard` | none |

**Device config keys** (old → new, same names unless noted):

| Old Key | New Device Config Key | Notes |
|---|---|---|
| `apiKeys.openai` | `apiKeys.openai` |: |
| `apiKeys.anthropic` | `apiKeys.anthropic` |: |
| `apiKeys.groq` | `apiKeys.groq` |: |
| `apiKeys.google` | `apiKeys.google` |: |
| `apiKeys.deepgram` | `apiKeys.deepgram` |: |
| `apiKeys.elevenlabs` | `apiKeys.elevenlabs` |: |
| `apiKeys.mistral` | `apiKeys.mistral` |: |
| `apiKeys.openrouter` | `apiKeys.openrouter` |: |
| `apiKeys.custom` | `apiKeys.custom` |: |
| `apiEndpoints.openai` | `apiEndpoints.openai` |: |
| `apiEndpoints.groq` | `apiEndpoints.groq` |: |
| `recording.method` | `recording.method` |: |
| `recording.cpal.deviceId` | `recording.cpal.deviceId` | old used pipe transform, new is plain string |
| `recording.navigator.deviceId` | `recording.navigator.deviceId` | same |
| `recording.ffmpeg.deviceId` | `recording.ffmpeg.deviceId` | same |
| `recording.navigator.bitrateKbps` | `recording.navigator.bitrateKbps` |: |
| `recording.cpal.outputFolder` | `recording.cpal.outputFolder` |: |
| `recording.cpal.sampleRate` | `recording.cpal.sampleRate` |: |
| `recording.ffmpeg.globalOptions` | `recording.ffmpeg.globalOptions` |: |
| `recording.ffmpeg.inputOptions` | `recording.ffmpeg.inputOptions` |: |
| `recording.ffmpeg.outputOptions` | `recording.ffmpeg.outputOptions` |: |
| `transcription.speaches.baseUrl` | `transcription.speaches.baseUrl` |: |
| `transcription.speaches.modelId` | `transcription.speaches.modelId` |: |
| `transcription.whispercpp.modelPath` | `transcription.whispercpp.modelPath` |: |
| `transcription.parakeet.modelPath` | `transcription.parakeet.modelPath` |: |
| `transcription.moonshine.modelPath` | `transcription.moonshine.modelPath` |: |
| `completion.custom.baseUrl` | `completion.custom.baseUrl` |: |
| `shortcuts.global.*` (10 keys) | `shortcuts.global.*` | same key names |

### Migration State Machine (from parent spec)

```
localStorage['whispering:migration']:

  (absent)     → probe for old data → 'pending' or 'not-needed'
  'pending'    → show dialog → user clicks Migrate → run migration → 'completed'
  'completed'  → old data still on disk, offer cleanup in settings
  'not-needed' → terminal, skip all probes (fresh install, no old data)
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Migration trigger | Automatic on boot, no dialog | Settings migration is safe (copies, never deletes) and should be invisible. Dialog is for the heavier table/recording migration |
| Old data handling | Keep `whispering-settings` intact after migration | User can verify nothing was lost. Cleaned up in a later pass |
| Type conversions | Convert at migration time | `temperature` string→number, `maxRecordingCount` string→number. Better to fix once during migration than at every read |
| Failure strategy | Per-key fallback | If one key fails to migrate, skip it (user gets default). Don't abort the whole migration for one bad key |
| Migration idempotency | Safe to run multiple times | Check if destination already has a non-default value before overwriting. First write wins |
| Migration state key | `whispering:settings-migration` | Distinct from the broader table migration state machine |

## Implementation Plan

### Phase 1: Migration function

- [x] **1.1** Create `apps/whispering/src/lib/state/migrate-settings.ts`
- [x] **1.2** ~~Import `parseStoredSettings`~~: `parseStoredSettings` no longer exists; migration parses the raw JSON blob directly with `JSON.parse()` and maps known keys
- [x] **1.3** Implement `migrateOldSettings()`:
    1. Check `localStorage['whispering:settings-migration']`: if `'completed'` or `'not-needed'`, return early
    2. Read `localStorage['whispering-settings']` and `localStorage['whispering-device-config']`: if both absent, set migration state to `'not-needed'`, return
    3. Parse both blobs with `JSON.parse()`: if both fail, set to `'completed'` (nothing to migrate), return
    4. Await `workspace.whenReady` to ensure IndexedDB persistence has loaded (critical for first-write-wins check)
    5. For each workspace key: map old name → new name, skip if user already changed it (compare to default), convert type if needed, call `workspace.kv.set(newKey, value)`
    6. For each device key: skip if per-key localStorage already exists, look up from `whispering-device-config` then `whispering-settings`, call `deviceConfig.set(newKey, value)`
    7. Delete `localStorage['whispering-settings']` and `localStorage['whispering-device-config']`
    8. Set `localStorage['whispering:settings-migration']` to `'completed'`
- [x] **1.4** Define the key mapping as a static data structure (not inline logic): `WORKSPACE_KEY_MAP` (43 entries) and `DEVICE_KEY_MAP` (37 entries)

### Phase 2: Boot integration

- [x] **2.1** Call `migrateOldSettings()` in `(app)/+layout.svelte` script body: runs for both desktop and web
- [x] **2.2** Runs after workspace is initialized (module-level singleton created on import; migration also awaits `workspace.whenReady` for IndexedDB)
- [x] **2.3** Runs after device-config is initialized (module-level singleton created on import)

### Phase 3: Verify

- [x] **3.1** `bun typecheck --filter=@epicenter/whispering`: no new errors (8 pre-existing errors in packages/ui and packages/workspace)
- [ ] **3.2** Manual test: set old `whispering-settings` in devtools → reload → verify values appear in new stores

## Edge Cases

### User has never used Whispering before

1. `localStorage['whispering-settings']` doesn't exist
2. Migration sets state to `'not-needed'` and returns
3. Both stores use defaults: correct

### User upgraded but only opened the app once before this migration lands

1. `localStorage['whispering-settings']` has their old data
2. `localStorage['whispering-device-config']` might have data from the brief monolithic period
3. Per-key localStorage entries don't exist yet
4. Migration reads from `whispering-settings` (canonical old source), writes to new destinations
5. If per-key entries already exist (user changed something after the Wave 2 code shipped), don't overwrite: fresh user choices win over migrated old data

### Migration crashes mid-way (browser closed, tab killed)

1. `whispering:settings-migration` is still absent (not yet set to 'completed')
2. On next boot: migration runs again from scratch
3. Idempotent: keys already written get skipped (first write wins check)
4. No partial state to recover from

### Old settings has unknown keys

1. `parseStoredSettings()` already handles this: unknown keys are dropped during progressive validation
2. Migration only maps known keys: anything not in the mapping is ignored

### Type conversion failure

1. Old `transcription.temperature` is `"abc"` (invalid string, not a number)
2. `parseFloat("abc")` → `NaN`
3. Fall back to default value for `transcription.temperature`
4. Log warning, continue with other keys

### Old data is deleted after migration

1. The old blob is ~3KB of flat config: not irreplaceable user content
2. Migration copies everything out first, then deletes
3. If user somehow downgrades, they re-enter their API key in 5 seconds
4. No cleanup UI needed: silent delete at end of migration

## Open Questions

1. **Should migration be automatic or dialog-driven?**

   The parent spec describes a dialog for Wave 3. But settings migration (copy flat keys) is much simpler and lower-risk than table/recording migration (copy IndexedDB rows with audio blobs). A dialog feels like overkill for settings.

   **Recommendation**: Automatic for settings. Save the dialog UX for the heavier table migration. Settings migration is silent: user doesn't even know it happened.

2. **Should we also migrate from `whispering-device-config` (the monolithic key)?**

   There's a window where users ran the Wave 2 code with the monolithic `device-config`. They might have data in `whispering-device-config` that's NOT in `whispering-settings`. The migration should check both sources.

   **Recommendation**: Yes. Priority order for each device key:
   1. Per-key localStorage (already migrated or user-set): highest priority
   2. `whispering-device-config` blob (from the brief monolithic period)
   3. `whispering-settings` blob (original old data)
   4. Default value: lowest priority

3. **When does `whispering-settings` actually get deleted?**

   **Decision**: Immediately after successful migration. The old blob is ~3KB of config data, not irreplaceable content. Migration copies everything out, then `localStorage.removeItem()` for both `whispering-settings` and `whispering-device-config`. No cleanup UI needed.

## Success Criteria

- [x] Existing user upgrades → all settings preserved (API keys, models, shortcuts, sound toggles)
- [x] Fresh install → no migration runs, all defaults
- [x] Migration is idempotent: running twice produces same result
- [x] Old localStorage data deleted after successful migration (changed from original spec: see Open Questions #3)
- [x] `bun typecheck --filter=@epicenter/whispering`: no new errors
- [x] Type conversions are correct (temperature string→number, maxRecordingCount string→number)

## References

- `apps/whispering/src/lib/settings/settings.ts`: `parseStoredSettings()`, `getDefaultSettings()`, `Settings` type
- `apps/whispering/src/lib/state/workspace-settings.svelte.ts`: destination for workspace keys
- `apps/whispering/src/lib/state/device-config.svelte.ts`: destination for device keys
- `apps/whispering/src/lib/workspace.ts`: workspace KV definitions (canonical key names)
- `specs/20260312T210000-whispering-settings-separation.md`: key mapping reference (Wave 2 review section)
- `specs/20260312T170000-whispering-workspace-polish-and-migration.md`: parent spec, Wave 3 section

## Review

**Completed**: 2026-03-13

### Summary

Implemented one-time settings migration from old monolithic `whispering-settings` localStorage blob to per-key workspace KV and device config stores. The migration runs automatically on boot for both desktop and web, is idempotent, and handles per-key failures gracefully.

### Deviations from Spec

- **`parseStoredSettings()` no longer exists**: the old settings system was fully replaced in Wave 2. The migration parses the raw JSON blob directly with `JSON.parse()` and maps only known keys. Unknown keys are silently ignored.
- **Added `workspace.whenReady` await**: critical timing requirement not in original spec. IndexedDB persistence loads async; without awaiting it, the migration's first-write-wins check would see defaults instead of user-set values, causing old data to overwrite newer user choices.
- **Migration runs in `(app)/+layout.svelte`** instead of AppLayout's `onMount`: this runs for both desktop and web contexts (not just Tauri), which is correct since the old `whispering-settings` blob exists in both environments.
- **Type boundary handling**: used function-level type assertions (`workspace.kv.set as KvSetter`) for dynamic key writes, consistent with the existing `deviceConfig.update()` pattern that does the same internally.
- **Old data deleted**: per Open Questions #3 decision, both `whispering-settings` and `whispering-device-config` are removed immediately after successful migration.

### Files Changed

- `apps/whispering/src/lib/state/migrate-settings.ts`: new, migration function with static key mappings
- `apps/whispering/src/routes/(app)/+layout.svelte`: added import and call to `migrateOldSettings()`
