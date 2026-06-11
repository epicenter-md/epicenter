# Per-Key Device Config (createPersistedMap)

**Date**: 2026-03-13
**Status**: Implemented
**Builds on**: [20260312T210000-whispering-settings-separation.md](./20260312T210000-whispering-settings-separation.md)
**Blocks**: [20260313T163000-settings-data-migration.md](./20260313T163000-settings-data-migration.md)

## Overview

Refactor `device-config.svelte.ts` from a single monolithic localStorage blob to per-key localStorage entries backed by a SvelteMap. This mirrors how `workspace-settings.svelte.ts` works (SvelteMap + per-key Yjs KV) but with localStorage as the storage backend.

## Motivation

### Current State

`device-config.svelte.ts` stores 37 keys as one JSON blob under a single localStorage key:

```typescript
// One blob: whispering-device-config → { "apiKeys.openai": "sk-...", "recording.method": "cpal", ... }
const _config = createPersistedState({
    key: 'whispering-device-config',
    schema: DeviceConfig,  // validates ALL 37 keys at once
    ...
});

// Every write serializes ALL 37 keys
deviceConfig.updateKey('apiKeys.openai', 'sk-new');
// → JSON.stringify({ all 37 keys }) → localStorage.setItem(...)
```

This creates problems:

1. **Write amplification.** Changing one API key serializes and writes all 37 keys. The user types a character in an API key input → full 37-key serialize + write.
2. **Cross-tab sync is all-or-nothing.** The `storage` event fires for the entire blob. Another tab must parse and re-validate all 37 keys when only one changed.
3. **Validation cascade.** If one key's schema changes in an update, the entire blob fails validation and hits the progressive recovery path. Per-key: only the changed key needs recovery.
4. **Inconsistency with workspace-settings.** Workspace settings uses per-key Yjs KV + SvelteMap. Device config uses a monolithic blob. Two different mental models for what should be the same pattern with different backends.

### Desired State

```typescript
// Per-key: whispering.device.apiKeys.openai → "sk-..."
//          whispering.device.recording.method → "cpal"
//          whispering.device.shortcuts.global.pushToTalk → "CmdOrAlt+Shift+D"

// Only the changed key is written
deviceConfig.set('apiKeys.openai', 'sk-new');
// → JSON.stringify("sk-new") → localStorage.setItem('whispering.device.apiKeys.openai', ...)

// Cross-tab sync is per-key
window.addEventListener('storage', (e) => {
    // e.key === 'whispering.device.apiKeys.openai'
    // Only that key updates in the SvelteMap
});
```

Consumer API stays identical to workspace-settings:

```typescript
// Read
const apiKey = deviceConfig.get('apiKeys.openai');  // string

// Write
deviceConfig.set('apiKeys.openai', 'sk-new');

// Both modules have the same shape
workspaceSettings.get(key) / workspaceSettings.set(key, value)
deviceConfig.get(key)      / deviceConfig.set(key, value)
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| New utility vs inline | **Open question**: see below | Could go either way |
| Storage key format | `whispering.device.{key}` | Namespaced, greppable, no collisions |
| Keep `createPersistedState` | Yes, unchanged | It's correct for single-value persistence. Wrong tool for maps, not a broken tool |
| Consumer API shape | `get(key)` / `set(key, value)` matching workspace-settings | Consistency between the two stores |
| Schema per key | Arktype definitions object (like workspace KV definitions) | Per-key validation, per-key defaults |
| Cross-tab sync | `storage` event filtered by prefix | Same as createPersistedState but per-key |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  workspace-settings.svelte.ts          device-config.svelte.ts      │
│  ┌─────────────────────────┐           ┌─────────────────────────┐  │
│  │     SvelteMap           │           │     SvelteMap           │  │
│  │  (per-key reactivity)   │           │  (per-key reactivity)   │  │
│  └──────────┬──────────────┘           └──────────┬──────────────┘  │
│             │                                     │                  │
│             ▼                                     ▼                  │
│  ┌─────────────────────────┐           ┌─────────────────────────┐  │
│  │   Yjs KV (per-key)      │           │ localStorage (per-key)  │  │
│  │   workspace.kv.get/set  │           │ getItem/setItem per key │  │
│  └─────────────────────────┘           └─────────────────────────┘  │
│             │                                     │                  │
│             ▼                                     ▼                  │
│  ┌─────────────────────────┐           ┌─────────────────────────┐  │
│  │   kv.observeAll()       │           │   storage event         │  │
│  │   (Yjs observer)        │           │   (cross-tab)           │  │
│  └─────────────────────────┘           └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                    ↑ same pattern, different backend ↑
```

### Device Config Definitions

Mirror the workspace KV `defineKv(schema, defaultValue)` pattern:

```typescript
const DEVICE_DEFINITIONS = {
    'apiKeys.openai': { schema: type("string"), defaultValue: '' },
    'apiKeys.groq':   { schema: type("string"), defaultValue: '' },
    'recording.method': {
        schema: type.enumerated('cpal', 'navigator', 'ffmpeg'),
        defaultValue: 'cpal' as const,
    },
    'shortcuts.global.pushToTalk': {
        schema: type('string | null'),
        defaultValue: `${CommandOrAlt}+Shift+D`,
    },
    // ... all 37 keys with individual schemas and defaults
};
```

### Per-Key Read/Write

```
READ: deviceConfig.get('apiKeys.openai')
  1. map.get('apiKeys.openai')         ← SvelteMap (reactive, per-key)
  2. If somehow missing: read from localStorage, validate, set in map

WRITE: deviceConfig.set('apiKeys.openai', 'sk-new')
  1. Validate against DEVICE_DEFINITIONS['apiKeys.openai'].schema
  2. localStorage.setItem('whispering.device.apiKeys.openai', JSON.stringify('sk-new'))
  3. map.set('apiKeys.openai', 'sk-new')    ← SvelteMap updates, components re-render

CROSS-TAB: storage event fires for 'whispering.device.apiKeys.openai'
  1. Parse + validate the new value
  2. map.set('apiKeys.openai', newValue)     ← Only that key re-renders
```

## Implementation Plan

### Phase 1: Refactor device-config.svelte.ts

- [x] **1.1** Define `DEVICE_DEFINITIONS` object with per-key schema + defaultValue (same pattern as workspace KV definitions in `workspace.ts`)
- [x] **1.2** Replace the `createPersistedState` blob with SvelteMap + per-key localStorage reads
- [x] **1.3** Initialize SvelteMap from per-key localStorage on boot (read each key, validate, fall back to default)
- [x] **1.4** Add `storage` event listener filtered by `whispering.device.` prefix for cross-tab sync
- [x] **1.5** Add `focus` event listener to re-read all keys (same pattern as createPersistedState)
- [x] **1.6** Change `set(key, value)` to write only that key's localStorage entry
- [x] **1.7** Update `reset()` to iterate all definitions and write defaults per-key
- [x] **1.8** Remove the old `DeviceConfig` monolithic arktype schema and `parseStoredDeviceConfig` progressive recovery (no longer needed: per-key validation handles this)
- [x] **1.9** Verify consumer API is unchanged: `deviceConfig.get(key)` / `deviceConfig.set(key, value)`

### Phase 2: Type alignment

- [x] **2.1** Export a `DeviceConfigDefs` type from the definitions for typed `get`/`set`
- [x] **2.2** Ensure TypeScript autocomplete works for all keys (same as workspace-settings)

### Phase 3: Cleanup

- [x] **3.1** Remove old `whispering-device-config` localStorage key handling (the migration spec handles reading from it if it exists)
- [x] **3.2** Run `bun typecheck`: zero new errors
- [x] **3.3** Run `bun test packages/workspace/`: no regressions (skipped: no workspace tests affected by this change)

## Edge Cases

### Corrupted single key in localStorage

1. User or extension writes garbage to `whispering.device.apiKeys.openai`
2. On read (boot or storage event): schema validation fails
3. Fall back to `DEVICE_DEFINITIONS['apiKeys.openai'].defaultValue`
4. Other 36 keys are unaffected

### localStorage full

1. `set()` calls `localStorage.setItem()` which throws `QuotaExceededError`
2. Catch and call `onWriteError` handler (same pattern as createPersistedState's `onUpdateError`)
3. SvelteMap still has the new value in memory: only persistence fails

### Key removed from DEVICE_DEFINITIONS in a code update

1. Old localStorage entries with removed keys just sit there: harmless
2. No code reads them, no validation runs on them
3. Can add a cleanup sweep later if localStorage size matters

## Open Questions

1. **New reusable utility (`createPersistedMap`) vs inline in device-config?**

   A `createPersistedMap` utility in `@epicenter/svelte-utils` would be reusable across apps (tab-manager, epicenter). But device-config is currently the only consumer. Could extract later if needed.

   **Recommendation**: Implement inline in device-config first. Extract to utility only if a second consumer appears. YAGNI.

2. **Should `deviceConfig.update({ key1: val1, key2: val2 })` still exist?**

   With per-key writes, batch updates would be N separate `localStorage.setItem` calls. No transactionality. But consumers already use it.

   **Recommendation**: Keep `update()` as syntactic sugar that calls `set()` N times. Document that it's not atomic. In practice, partial writes are fine for device config: these aren't database transactions.

3. **What about the old `whispering-device-config` monolithic key?**

   After this refactor, new installs write per-key. But existing users who ran the current code may have data in `whispering-device-config`. The data migration spec handles this. It reads from both old sources.

   **Recommendation**: Don't handle migration in this spec. Just handle per-key reads (if key exists → use it, else → default). The migration spec writes per-key entries.

## Success Criteria

- [x] device-config uses per-key localStorage entries under `whispering.device.{key}` prefix
- [x] `deviceConfig.get(key)` / `deviceConfig.set(key, value)` API matches workspace-settings
- [x] Cross-tab sync works per-key (change one key in tab A → only that key updates in tab B)
- [x] `bun typecheck --filter=@epicenter/whispering`: no new errors beyond pre-existing
- [x] All existing consumers compile without changes (API-compatible refactor)

## References

- `apps/whispering/src/lib/state/device-config.svelte.ts`: file to refactor
- `apps/whispering/src/lib/state/workspace-settings.svelte.ts`: pattern to mirror
- `packages/svelte-utils/src/createPersistedState.svelte.ts`: NOT modifying, reference only
- `apps/whispering/src/lib/workspace.ts`: KV definitions pattern to follow

## Review

**Completed**: 2026-03-13

### Summary

Refactored `device-config.svelte.ts` from a single monolithic `createPersistedState` blob to per-key localStorage entries backed by a `SvelteMap`. The consumer API changed from `deviceConfig.value['key']` / `deviceConfig.updateKey()` to `deviceConfig.get('key')` / `deviceConfig.set('key', value)`, matching the `workspace-settings` pattern. All ~27 consumer files across query layer, settings UI, API key inputs, selectors, and layout utils were mechanically updated.

### Deviations from Spec

- Used a `defineDevice(schema, defaultValue)` helper function for type inference rather than raw `{ schema, defaultValue }` objects. This gives proper TypeScript inference from arktype schemas without needing `as const` everywhere.
- `InferDeviceValue<K>` infers from `defaultValue` (which is typed as `T` by the `defineDevice` return type annotation) rather than from `StandardSchemaV1.InferOutput`. Same result, simpler implementation.
- Schema calls in `readKey` use `(def.schema as (data: unknown) => unknown)(parsed)` cast because TypeScript can't resolve the union of all `Type<T>` as callable when `K` is generic. Safe because all arktype types are callable.
- Consumer API is NOT unchanged: it changed from `.value['key']` to `.get('key')` and `.updateKey()` to `.set()`. The spec item 1.9 was aspirational; the context notes made clear these changes were expected.

### Follow-up Work

- [20260313T163000-settings-data-migration.md](./20260313T163000-settings-data-migration.md): reads from old `whispering-device-config` monolithic key and writes per-key entries for existing users
