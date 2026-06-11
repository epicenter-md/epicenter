# Whispering Settings Separation (Wave 2)

**Date**: 2026-03-12
**Status**: Implemented
**Builds on**: [20260312T170000-whispering-workspace-polish-and-migration.md](./20260312T170000-whispering-workspace-polish-and-migration.md)

## Overview

Split Whispering's unified `settings.svelte.ts` (localStorage-backed, ~80 keys) into two reactive state files reflecting a real architectural boundary:

- **`workspace-settings.svelte.ts`**: ~42 synced preferences backed by Yjs KV (SvelteMap + observer)
- **`device-config.svelte.ts`**: ~36 device-bound keys backed by localStorage (`createPersistedState`)

This wave creates the reactive layer that Wave 3 (migration) writes into.

## Architecture

### Data Flow: workspace-settings

```
┌─────────────────────────────────────────────────────────────────┐
│  workspace-settings.svelte.ts                                    │
│                                                                  │
│  ┌──────────────┐  observeAll()  ┌───────────────┐  .get(key)  │
│  │  Yjs KV      │───────────────►│  SvelteMap    │────────────►UI│
│  │  (Y.Array)   │               │  (reactive)   │              │
│  │  42 entries   │               │  42 entries   │              │
│  └──────┬───────┘               └───────────────┘              │
│         ▲                              │                        │
│         │     kv.set(key, value)       │                        │
│         └──────────────────────────────┘                        │
│           write goes to Yjs first,                              │
│           observer updates SvelteMap                            │
└─────────────────────────────────────────────────────────────────┘
```

**Write path (unidirectional):**
1. Component calls `workspaceSettings.set('sound.manualStart', false)`
2. `kv.set('sound.manualStart', false)` writes to Yjs KV
3. Yjs KV fires `observeAll()` callback with `{ key: 'sound.manualStart', value: false }`
4. Callback calls `svelteMap.set('sound.manualStart', false)`
5. Only components that called `svelteMap.get('sound.manualStart')` re-render

**Read path (direct):**
`workspaceSettings.get('sound.manualStart')` → `svelteMap.get('sound.manualStart')` → per-key Svelte reactivity

**Remote sync path:**
Same as write path: remote Yjs changes fire the same `observeAll()` observer. SvelteMap updates, UI re-renders. No extra code needed.

### Data Flow: device-config

```
┌─────────────────────────────────────────────────────────────────┐
│  device-config.svelte.ts                                         │
│                                                                  │
│  ┌──────────────┐  createPersistedState  ┌─────────────┐       │
│  │ localStorage │◄──────────────────────►│  $state obj │──────►UI│
│  │ (persisted)  │                        │  (reactive) │        │
│  └──────────────┘                        └─────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

Keeps the existing `createPersistedState` pattern. Typed `get(key)/set(key, value)` wrapper for API consistency. No SvelteMap for now: `createPersistedState` already handles reactivity + persistence.

## Prerequisites: `observeAll()` on KV Helper

### Why

The current `kv.observe(key, callback)` API observes one key at a time. With 42 keys, that creates 42 handlers on the same underlying `YKeyValueLww`, each filtering for their specific key. While 42 is not a performance concern, a single `observeAll()` is cleaner and avoids redundant filtering.

### Current KvHelper API

```typescript
type KvHelper<TKvDefinitions> = {
  get<K>(key: K): KvGetResult<InferKvValue<TKvDefinitions[K]>>;
  set<K>(key: K, value: InferKvValue<TKvDefinitions[K]>): void;
  delete<K>(key: K): void;
  observe<K>(key: K, callback: (change: KvChange<...>, transaction: unknown) => void): () => void;
};
```

### Proposed Addition

```typescript
type KvHelper<TKvDefinitions> = {
  // ... existing methods ...

  /**
   * Watch for changes to ANY KV key.
   *
   * Unlike `observe(key, callback)` which filters for a single key, this
   * fires for every KV change with the key name included. Useful for reactive
   * stores that need to sync all keys efficiently (e.g., SvelteMap).
   *
   * Invalid values (schema validation failure) are skipped: only valid,
   * migrated values fire the callback.
   *
   * @returns Unsubscribe function
   */
  observeAll(
    callback: (
      changes: Map<string, KvChange<unknown>>,
      transaction: unknown,
    ) => void,
  ): () => void;
};
```

### Implementation in `create-kv.ts`

```typescript
observeAll(callback) {
  const handler = (
    changes: Map<string, YKeyValueLwwChange<unknown>>,
    transaction: Y.Transaction,
  ) => {
    const parsed = new Map<string, KvChange<unknown>>();

    for (const [key, change] of changes) {
      const definition = definitions[key];
      if (!definition) continue; // skip unknown keys

      if (change.action === 'delete') {
        parsed.set(key, { type: 'delete' });
      } else {
        // Parse and migrate the new value
        const result = parseValue(change.newValue, definition);
        if (result.status === 'valid') {
          parsed.set(key, { type: 'set', value: result.value });
        }
        // Skip invalid values
      }
    }

    if (parsed.size > 0) {
      callback(parsed, transaction);
    }
  };

  ykv.observe(handler);
  return () => ykv.unobserve(handler);
},
```

### Type Addition in `types.ts`

Add to `KvHelper<TKvDefinitions>`:

```typescript
/** Watch for changes to any KV key. Returns unsubscribe function. */
observeAll(
  callback: (
    changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
    transaction: unknown,
  ) => void,
): () => void;
```

## Implementation Plan

- [x] **Task 1**: Add `observeAll()` to workspace KV helper

**Files:**
- `packages/workspace/src/workspace/types.ts`: add `observeAll` to `KvHelper` type
- `packages/workspace/src/workspace/create-kv.ts`: implement `observeAll`
- `packages/workspace/src/workspace/create-kv.test.ts`: test `observeAll`

**Acceptance:**
- Single observer on underlying YKeyValueLww
- Fires callback with `Map<key, KvChange>` for all changed keys
- Invalid values skipped (only valid, migrated values)
- Unknown keys skipped
- Returns unsubscribe function
- Tests pass

- [x] **Task 2**: Create `workspace-settings.svelte.ts`
  > **Note**: kv.get() returns value directly (no discriminated union). Defaults seeding simplified to just `map.set(key, workspace.kv.get(key))`.

**File:** `apps/whispering/src/lib/state/workspace-settings.svelte.ts`

**Architecture:**

```typescript
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';

// The KV definitions from workspace.ts: used for typing and defaults
const KV_DEFINITIONS = workspace.definitions.kv;

function createWorkspaceSettings() {
  const map = new SvelteMap<string, unknown>();

  // 1. Initialize SvelteMap with defaults for all 42 keys
  //    (workspace KV entries may not exist yet: fresh workspace)
  for (const key of Object.keys(KV_DEFINITIONS)) {
    const result = workspace.kv.get(key);
    if (result.status === 'valid') {
      map.set(key, result.value);
    }
    // 'not_found' or 'invalid' → leave unset, handled by typed getter defaults
  }

  // 2. Single observer for ALL KV changes
  workspace.kv.observeAll((changes) => {
    for (const [key, change] of changes) {
      if (change.type === 'set') {
        map.set(key, change.value);
      } else if (change.type === 'delete') {
        map.delete(key);
      }
    }
  });

  // 3. Typed accessors
  return {
    /**
     * Get a synced workspace setting. Returns the current value from the
     * reactive SvelteMap. Components reading this will re-render when the
     * value changes (from local writes OR remote sync).
     */
    get<K extends keyof typeof KV_DEFINITIONS & string>(key: K) {
      return map.get(key) as InferKvValue<(typeof KV_DEFINITIONS)[K]>;
    },

    /**
     * Set a synced workspace setting. Writes to Yjs KV, which fires the
     * observer, which updates the SvelteMap. Unidirectional: never set
     * the SvelteMap directly.
     */
    set<K extends keyof typeof KV_DEFINITIONS & string>(
      key: K,
      value: InferKvValue<(typeof KV_DEFINITIONS)[K]>,
    ) {
      workspace.kv.set(key, value);
    },
  };
}

export const workspaceSettings = createWorkspaceSettings();
```

**Key decisions:**
- **SvelteMap for per-key reactivity**: `map.get(key)` tracks that specific key. `map.set(key, value)` only triggers subscribers of that key.
- **Unidirectional writes**: component calls `set()` → Yjs KV → observer → SvelteMap. Never mutate the SvelteMap directly.
- **Defaults**: populated from current KV state on init. If KV entry doesn't exist (fresh workspace), getter returns `undefined`. Consumers handle defaults (same as current pattern where settings schema has defaults).
- **No destroy needed**: singleton, lives for app lifetime (same as current settings.svelte.ts)

**Acceptance:**
- SvelteMap initialized from current Yjs KV state
- `observeAll()` updates SvelteMap on any KV change (local or remote)
- `get(key)` returns typed value per key definition
- `set(key, value)` writes to Yjs KV (type-checked)
- Per-key reactivity verified: changing one key doesn't re-render components reading other keys

- [x] **Task 3**: Create `device-config.svelte.ts`
  > **Note**: Removed pipe transforms for device IDs (plain `string | null`). Removed unused TRANSCRIPTION import.

**File:** `apps/whispering/src/lib/state/device-config.svelte.ts`

**Architecture:**

Uses `createPersistedState` (existing pattern) with a typed wrapper:

```typescript
import { createPersistedState } from '@epicenter/svelte-utils';
import { type } from 'arktype';
// ... import constants

const DeviceConfig = type({
  // API keys: secrets, never synced
  'apiKeys.openai': "string = ''",
  'apiKeys.anthropic': "string = ''",
  // ... all 8 API key entries

  // API endpoint overrides
  'apiEndpoints.openai': "string = ''",
  'apiEndpoints.groq': "string = ''",

  // Hardware device IDs
  'recording.cpal.deviceId': 'string | null = null',
  'recording.navigator.deviceId': 'string | null = null',
  'recording.ffmpeg.deviceId': 'string | null = null',

  // Recording method + config
  'recording.method': "'cpal' | 'navigator' | 'ffmpeg' = 'cpal'",
  'recording.navigator.bitrateKbps': type.enumerated(...BITRATES_KBPS).default(DEFAULT_BITRATE_KBPS),
  'recording.cpal.outputFolder': 'string | null = null',
  'recording.cpal.sampleRate': "'16000' | '44100' | '48000' = '16000'",
  'recording.ffmpeg.globalOptions': 'string = ...',
  'recording.ffmpeg.inputOptions': 'string = ...',
  'recording.ffmpeg.outputOptions': 'string = ...',

  // Local model paths
  'transcription.speaches.baseUrl': "string = 'http://localhost:8000'",
  'transcription.speaches.modelId': 'string = ...',
  'transcription.whispercpp.modelPath': "string = ''",
  'transcription.parakeet.modelPath': "string = ''",
  'transcription.moonshine.modelPath': "string = ''",

  // Self-hosted server URLs
  'completion.custom.baseUrl': "string = 'http://localhost:11434/v1'",

  // Global OS shortcuts
  'shortcuts.global.toggleManualRecording': 'string | null = ...',
  // ... all 10 global shortcuts
});

type DeviceConfig = typeof DeviceConfig.infer;

export const deviceConfig = (() => {
  const _config = createPersistedState({
    key: 'whispering-device-config',
    schema: DeviceConfig,
    onParseError: (error) => {
      // Same progressive validation as current settings.ts
      // ...
    },
  });

  return {
    get value(): DeviceConfig { return _config.value; },
    update(updates: Partial<DeviceConfig>) { _config.value = { ..._config.value, ...updates }; },
    updateKey<K extends keyof DeviceConfig>(key: K, value: DeviceConfig[K]) {
      _config.value = { ..._config.value, [key]: value };
    },
  };
})();
```

**Key decisions:**
- **Same `createPersistedState` pattern**: battle-tested, already handles reactivity + localStorage
- **Separate localStorage key**: `whispering-device-config` (not `whispering-settings`)
- **Progressive validation**: same approach as current `parseStoredSettings()` for robustness
- **API shape**: `get value`, `update()`, `updateKey()` (same as current `settings`)

**Acceptance:**
- All ~36 device-bound keys defined with defaults
- Persists to `whispering-device-config` in localStorage
- Progressive validation handles corrupted/partial data
- Type-safe get/set per key

- [x] **Task 4**: Update consumers to import from correct source
  > **Note**: ~47 files migrated. Reset methods (reset(), resetLocalShortcuts, resetGlobalShortcuts) added to new modules.
  > register-commands.ts rewritten with proper type-safe shortcut key mapping.
  > switchRecordingMode() inlined in +page.svelte. retention.maxCount converted number→string at service boundary.

This is the largest task by file count but each change is mechanical:

**Pattern:**
```diff
- import { settings } from '$lib/state/settings.svelte';
- const mode = settings.value['recording.mode'];
+ import { workspaceSettings } from '$lib/state/workspace-settings.svelte';
+ const mode = workspaceSettings.get('recording.mode');
```

For device-config:
```diff
- import { settings } from '$lib/state/settings.svelte';
- const apiKey = settings.value['apiKeys.openai'];
+ import { deviceConfig } from '$lib/state/device-config.svelte';
+ const apiKey = deviceConfig.value['apiKeys.openai'];
```

**Consumer categories:**

| Consumer | Reads From | Why |
|---|---|---|
| Sound toggle UI | workspace-settings | Sound preferences sync |
| Output behavior UI | workspace-settings | Output prefs sync |
| Transcription service selection | workspace-settings (service/model) + device-config (API key) | Service/model syncs, keys don't |
| Recording mode selector | workspace-settings (mode) + device-config (method, device IDs) | Mode syncs, hardware doesn't |
| Shortcut configuration | workspace-settings (local shortcuts) + device-config (global shortcuts) | In-app sync, OS-global don't |
| API key inputs | device-config | Secrets stay local |
| Retention settings | workspace-settings | Policy syncs |
| Always-on-top / layout | workspace-settings | UI prefs sync |

**Acceptance:**
- Zero imports from old `settings.svelte.ts`
- Each consumer imports from the correct source
- All existing functionality preserved (no regressions)
- LSP diagnostics clean on all changed files

- [x] **Task 5**: Deprecate old unified settings
  > **Note**: settings.svelte.ts marked @deprecated with JSDoc. settings.ts schema kept for Wave 3 migration.

**Files:**
- `apps/whispering/src/lib/state/settings.svelte.ts`: mark deprecated or remove
- `apps/whispering/src/lib/settings/settings.ts`: keep schema (still used for migration in Wave 3)

**Strategy:**
- Don't delete `settings.ts` (the schema): Wave 3 migration needs it to read old localStorage data
- Don't delete `parseStoredSettings()`: Wave 3 needs it
- Delete or deprecate `settings.svelte.ts` (the reactive singleton): all consumers now use workspace-settings or device-config
- Keep `whispering-settings` localStorage key intact: Wave 3 migration reads from it

**Acceptance:**
- No runtime imports of the old `settings.svelte.ts` reactive singleton
- Old `settings.ts` schema preserved for Wave 3
- Old `whispering-settings` localStorage data preserved for Wave 3
- App functions identically after the switch

### Task 6: Handle defaults and initial state

When the workspace is fresh (no KV entries), `workspaceSettings.get(key)` returns `undefined`. Consumers need defaults.

**Strategy:**
- On `createWorkspaceSettings()` init, read all KV entries from Yjs
- For keys that return `not_found`, write the default value to Yjs KV
- This seeds the KV store on first use and ensures the SvelteMap always has values

```typescript
// During init:
for (const [key, definition] of Object.entries(KV_DEFINITIONS)) {
  const result = workspace.kv.get(key);
  if (result.status === 'valid') {
    map.set(key, result.value);
  } else {
    // Seed with default from old settings schema
    const defaultValue = getDefaultForKvKey(key);
    workspace.kv.set(key, defaultValue);
    map.set(key, defaultValue);
  }
}
```

The defaults come from the old `Settings` schema (`getDefaultSettings()`), mapped to new KV key names.

**Acceptance:**
- Fresh workspace gets all 42 KV entries seeded with defaults
- Existing workspace preserves current values
- SvelteMap always has a value for every key (never `undefined`)

## Execution Order

```
Task 1  →  Task 2  →  Task 3  →  Task 4  →  Task 5
  │                                  │          │
  │  (workspace pkg)                 │          │
  │                                  │          │
  └── observeAll() on KV helper      │          │
                                     │          │
  Task 6 is embedded in Task 2       │          │
  (defaults seeding during init)     │          │
                                     │          │
                          Consumer migration  Deprecate old
```

Tasks 2 and 3 can be parallelized (independent files). Task 4 depends on both 2 and 3 being complete. Task 5 depends on Task 4.

## Open Questions

1. **Default seeding strategy**: should we seed defaults into Yjs KV on first access (lazy), or eagerly on workspace creation? Eager is simpler but writes 42 entries to an empty Yjs doc. Lazy avoids writes but complicates the getter.

   **Leaning**: Eager. 42 entries in a single `batch()` is trivial. Clean mental model: every key always has a value.

2. **API surface for consumers**: the workspace-settings `get(key)` returns a raw typed value. Should it return a `KvGetResult<T>` discriminated union (with `status: 'valid'|'not_found'`) like the raw KV API?

   **Leaning**: No. The SvelteMap is always seeded with defaults. `get(key)` always returns a value. No discriminated union needed: that complexity belongs in the workspace package, not the app-level reactive layer.

3. **Cross-tab sync for device-config**: localStorage `storage` events fire across tabs. Should device-config listen for them to sync across browser tabs?

   **Leaning**: Not in this wave. `createPersistedState` may already handle this. If not, add later.

## Review

**Completed**: 2026-03-13
**Branch**: opencode/silent-squid

### Summary

Split the unified `settings.svelte.ts` singleton into two purpose-built modules:
- **workspace-settings.svelte.ts**: ~43 synced preferences backed by Yjs KV + SvelteMap for per-key reactivity
- **device-config.svelte.ts**: ~37 device-bound secrets/hardware/paths backed by localStorage via createPersistedState

All 47 consumer files migrated. Old settings module marked @deprecated (schema preserved for future localStorage→Yjs migration).

### Deviations from Spec

- **No defaults seeding**: `kv.get()` already returns defaultValue for missing keys, so eager seeding into Yjs was unnecessary. SvelteMap is populated from `kv.get()` directly.
- **No discriminated union**: `get(key)` returns the value directly (not `KvGetResult<T>`), matching the simplified Spec 1 API.
- **Pipe transforms dropped**: device-config uses plain `string | null` for device IDs instead of the old `deviceIdTransform` pipe. Consumers that need `DeviceIdentifier` branding call `asDeviceIdentifier()` at the call site.
- **Reset methods added**: `workspaceSettings.reset()` and `deviceConfig.reset()` added to support the existing "Reset All Settings" button. `resetLocalShortcuts()` and `resetGlobalShortcuts()` extracted to register-commands.ts.
- **switchRecordingMode inlined**: The old `settings.switchRecordingMode()` method was inlined in `+page.svelte` since it was the only consumer.
- **Type conversions at boundaries**: `transcription.temperature` (string→number) and `retention.maxCount` (string→number) require `String()` conversion at service call boundaries since service types still reference the old `Settings` type.

### Follow-up Work

- **Wave 3 migration**: Read old `whispering-settings` localStorage data, parse with `parseStoredSettings()`, and seed workspace KV + device-config localStorage. Then delete the old key.
- **Service type updates**: Update `cleanupExpired()` and transcription service signatures to accept `number` directly instead of requiring `String()` conversion.
- **README updates**: Update state/README.md and components/settings/README.md to reference new modules.
- **Remove old settings.svelte.ts**: After Wave 3 migration is complete, delete the deprecated file.
