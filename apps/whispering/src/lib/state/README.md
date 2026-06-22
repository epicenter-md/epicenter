# State

Singleton reactive state that stays in sync with the application. Unlike the rpc layer which uses stale-while-revalidate caching, state modules maintain live state that updates immediately and persists across the application lifecycle.

## When to Use State vs RPC Layer

| Aspect | `$lib/state/` | `$lib/rpc/` |
|--------|----------------|---------------|
| **Pattern** | Singleton reactive state | Stale-while-revalidate (TanStack Query) |
| **State Location** | Module-level `$state` runes | TanStack Query cache |
| **Updates** | Immediate, live | Cached with background refresh |
| **Use Case** | Hardware state, user preferences, live status, workspace table data | Data fetching, mutations, external API calls |
| **Lifecycle** | Application lifetime | Managed by TanStack Query |

## Current State Modules

### `settings.svelte.ts`

Synced workspace settings backed by Yjs KV. Settings here roam across devices via CRDT sync. Uses a SvelteMap for per-key reactivity.

```typescript
import { settings } from '$lib/state/settings.svelte';

// Read settings reactively (re-renders on change)
const trigger = settings.get('recording.trigger');

// Update settings (writes to Yjs KV → syncs to other devices)
settings.set('recording.trigger', 'vad');
```

### `recordings.svelte.ts`

Recording metadata backed by Yjs workspace table. SvelteMap provides per-key reactivity: updating one recording doesn't re-render the entire list. Audio blobs are not stored here because they are too large for CRDTs; use `$lib/rpc/audio` for playback URLs and `services.blobs.audio` for raw blob access.

```typescript
import { InstantString } from '@epicenter/field';

import { recordings } from '$lib/state/recordings.svelte';

// Read recordings reactively
const recording = recordings.get(id);
const sorted = recordings.sorted; // newest first

// Write (Yjs observer auto-updates SvelteMap)
recordings.set(recording);
recordings.update(id, {
	transcript,
	transcription: { status: 'completed', completedAt: InstantString.now() },
});
recordings.delete(id);
```

### `recipes.svelte.ts`

Recipes backed by a Yjs workspace table. A Recipe is a single self-contained row: a name and one instruction (text in, text out). No replacements, no prompt split, no per-Recipe model. Built-in recipes ship in code (`builtin-recipes.ts`); the table holds only user customs. See ADR 0046.

```typescript
import { recipes } from '$lib/state/recipes.svelte';

// Built-ins first, then the user's own (alphabetical by name)
const list = recipes.pickable;

recipes.set(recipe);
recipes.delete(id);
```

### `device-config.svelte.ts`

Device-bound configuration backed by per-key localStorage. Secrets, hardware IDs, filesystem paths, and global OS shortcuts that should never sync across devices. Uses a SvelteMap for per-key reactivity with cross-tab sync via storage events.

```typescript
import { deviceConfig } from '$lib/state/device-config.svelte';

// Read config reactively
const apiKey = deviceConfig.get('providers.openai.apiKey');

// Update config (writes to localStorage per-key)
deviceConfig.set('providers.openai.apiKey', 'sk-...');

// Get definition default (for "Default: X" placeholders)
const defaultShortcut = deviceConfig.getDefault('shortcuts.global.toggleManualRecording');
```

### `vad-recorder.svelte.ts`

Voice Activity Detection (VAD) recorder singleton. Manages the VAD hardware state and provides reactive access to detection status.

```typescript
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

// Reactive state access (triggers $effect when changed)
$effect(() => {
  console.log('VAD state:', vadRecorder.state); // 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED'
});

// Start/stop VAD
await vadRecorder.startActiveListening({
  onSpeechStart: () => console.log('Speaking...'),
  onSpeechEnd: (blob) => processAudio(blob),
});
await vadRecorder.stopActiveListening();
```

## Why VAD Lives Here

The VAD recorder doesn't fit the rpc layer pattern because:

1. **Live state**: VAD state (`IDLE` → `LISTENING` → `SPEECH_DETECTED`) must update immediately as hardware events occur
2. **Singleton nature**: Only one VAD instance can exist at a time
3. **Resource management**: Requires explicit cleanup (`stopActiveListening`) rather than cache invalidation
4. **Hardware lifecycle**: Tied to microphone access, not data fetching

## Adding New State Modules

Create a new state module when you need:

1. **Live reactive state** that must update immediately (not stale-while-revalidate)
2. **Singleton behavior** where only one instance should exist
3. **Application-lifetime persistence** (not request-scoped)
4. **Hardware or system state** that can't be "refreshed" like data

Use the rpc layer (`$lib/rpc/`) instead when you need:
- Data fetching with caching
- Mutations with optimistic updates
- Background refresh and stale-while-revalidate
- TanStack Query devtools integration

If a state module still exposes a TanStack query for one live concern, keep the key map beside the state owner:

```typescript
export const recorderKeys = defineKeys({
	devices: ['recorder', 'devices'],
});
```

Use the same module shape as `$lib/rpc/`: exported `*Keys` for shared cache identity, local `defineErrors` namespaces for state-owned failures, named input object types for structured public methods, and `ReturnType<typeof createThing>` when exporting the exact shape returned by a factory.

See `$lib/rpc/README.md` for the rpc layer documentation.
