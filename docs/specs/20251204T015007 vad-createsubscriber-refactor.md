# VAD Recorder: Replace invalidateQueries with createSubscriber

## Context

The VAD recorder currently uses TanStack Query's `invalidateQueries` pattern to notify UI components of state changes. This works but is suboptimal because:

1. **Pull vs Push**: `invalidateQueries` marks the query as stale and triggers a refetch. But the state has already changed in the service; we just need to notify consumers.
2. **Overhead**: Every `invalidateVadState()` call causes TanStack Query to re-execute `resultQueryFn`, even though it's just reading a synchronous getter.
3. **Inconsistency**: Other similar reactive state in the codebase (`createPressedKeys`, `createPersistedState`) uses `createSubscriber` pattern instead.

## Current Architecture

### Service Layer (`vad-recorder.ts`)

```typescript
export function createVadService() {
  let maybeVad: MicVAD | null = null;
  let vadState: VadState = 'IDLE';  // Plain variable

  return {
    getVadState: (): VadState => vadState,  // Simple getter

    startActiveListening: async ({ onSpeechStart, onSpeechEnd, ... }) => {
      // ...
      const newVad = await MicVAD.new({
        onSpeechStart: () => {
          vadState = 'SPEECH_DETECTED';  // State changes here
          onSpeechStart();  // Callback notifies query layer
        },
        // ...
      });
    },
  };
}
```

### Query Layer (`query/vad-recorder.ts`)

```typescript
const invalidateVadState = () =>
  queryClient.invalidateQueries({ queryKey: vadRecorderKeys.state });

export const vadRecorder = {
  getVadState: defineQuery({
    queryKey: vadRecorderKeys.state,
    resultQueryFn: () => {
      const vadState = services.vad.getVadState();  // Just reads the getter
      return Ok(vadState);
    },
    initialData: 'IDLE' as VadState,
  }),

  startActiveListening: defineMutation({
    resultMutationFn: async ({ onSpeechStart, onSpeechEnd }) => {
      await services.vad.startActiveListening({
        onSpeechStart: () => {
          invalidateVadState();  // Force refetch
          onSpeechStart();
        },
        // ...
      });
    },
  }),
};
```

## How createSubscriber Works

From DeepWiki and codebase examples:

```typescript
const subscribe = createSubscriber((update) => {
  // Attach event listeners
  const cleanup = on(window, 'event', () => {
    // When event fires, update internal state
    value = newValue;
    update();  // Notify Svelte's reactivity system
  });

  // Return cleanup function
  return cleanup;
});

return {
  get current() {
    subscribe();  // Register reactive dependency
    return value;
  },
};
```

Key mechanics:
- `createSubscriber` returns a `subscribe` function
- Calling `subscribe()` in a getter registers the current effect as interested
- Calling `update()` signals that dependent effects should re-run
- The `start` callback can return a cleanup function

## Proposed Refactor

### Service Layer Changes

```typescript
import { createSubscriber } from 'svelte/reactivity';

export function createVadService() {
  let maybeVad: MicVAD | null = null;
  let vadState = $state<VadState>('IDLE');
  let currentStream: MediaStream | null = null;

  // For notifying subscribers when state changes
  let notifyUpdate: (() => void) | null = null;

  const subscribe = createSubscriber((update) => {
    notifyUpdate = update;
    return () => {
      notifyUpdate = null;
    };
  });

  return {
    get vadState() {
      subscribe();
      return vadState;
    },

    startActiveListening: async ({ deviceId, onSpeechStart, onSpeechEnd, ... }) => {
      // ... existing stream setup logic ...

      const newVad = await MicVAD.new({
        stream,
        onSpeechStart: () => {
          vadState = 'SPEECH_DETECTED';
          notifyUpdate?.();
          onSpeechStart();
        },
        onSpeechEnd: (audio) => {
          vadState = 'LISTENING';
          notifyUpdate?.();
          const wavBuffer = utils.encodeWAV(audio);
          const blob = new Blob([wavBuffer], { type: 'audio/wav' });
          onSpeechEnd(blob);
        },
        onVADMisfire: () => {
          vadState = 'LISTENING';
          notifyUpdate?.();
          onVADMisfire();
        },
        onSpeechRealStart: () => {
          notifyUpdate?.();
          onSpeechRealStart();
        },
      });

      maybeVad = newVad;
      vadState = 'LISTENING';
      notifyUpdate?.();
      return Ok(deviceOutcome);
    },

    stopActiveListening: async () => {
      // ... existing cleanup logic ...
      vadState = 'IDLE';
      notifyUpdate?.();
      // ...
    },
  };
}
```

### Query Layer Changes

Option 1: Remove `getVadState` query entirely, access service directly:

```typescript
// Components would use:
// services.vad.vadState (reactive getter)
// instead of:
// createQuery(rpc.vadRecorder.getVadState.options)
```

Option 2: Thin wrapper for API consistency:

```typescript
export const vadRecorder = {
  // Direct reactive access (no query needed)
  get vadState() {
    return services.vad.vadState;
  },

  // Mutations stay the same but remove invalidateVadState calls
  startActiveListening: defineMutation({
    resultMutationFn: async ({ onSpeechStart, onSpeechEnd }) => {
      const { data, error } = await services.vad.startActiveListening({
        deviceId: settings.value['recording.navigator.deviceId'],
        onSpeechStart,  // No invalidation needed
        onSpeechEnd,
        onVADMisfire: () => {},  // No invalidation needed
        onSpeechRealStart: () => {},
      });

      if (error) return fromTaggedErr(error, { ... });
      return Ok(data);
    },
  }),
};
```

### Component Changes

Before:
```svelte
const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);

$effect(() => {
  if (getVadStateQuery.data === 'LISTENING') {
    // ...
  }
});
```

After:
```svelte
import * as services from '$lib/services';

$effect(() => {
  if (services.vad.vadState === 'LISTENING') {
    // ...
  }
});
```

## Benefits

1. **Push-based reactivity**: State updates are pushed to consumers immediately, no refetch.
2. **Less overhead**: No TanStack Query machinery for simple synchronous state.
3. **Consistent patterns**: Aligns with `createPressedKeys` and `createPersistedState`.
4. **Simpler code**: Remove `invalidateVadState()` calls from all callbacks.

## Concerns & Mitigations

### Concern: Breaking single source of truth pattern

The codebase uses TanStack Query as the "single source of truth" for UI state. Bypassing it for VAD state could be inconsistent.

**Mitigation**: VAD state is fundamentally different from persisted data (recordings, sessions). It's ephemeral, local, and changes rapidly based on audio input. Similar to keyboard state (`createPressedKeys`), it belongs in Svelte's reactivity system rather than a data-fetching library.

### Concern: Component migration effort

Components currently use `createQuery` for VAD state.

**Mitigation**: Only 2-3 components use `getVadStateQuery`. The migration is straightforward:
- `AppLayout.svelte`: Uses it to trigger `cleanupExpired` effect
- `(config)/+layout.svelte`: Uses it for similar effects

## Files to Change

- [x] `apps/whispering/src/lib/services/vad-recorder.ts`: Deleted; merged into query layer
- [x] `apps/whispering/src/lib/query/vad-recorder.ts`: Deleted; replaced with `vad.svelte.ts`
- [x] `apps/whispering/src/lib/query/vad.svelte.ts`: New unified module with `$state` reactivity
- [x] `apps/whispering/src/lib/query/actions.ts`: Updated to use `vad` directly
- [x] `apps/whispering/src/lib/stores/settings.svelte.ts`: Updated to use `vad.state`
- [x] `apps/whispering/src/routes/(app)/_components/AppLayout.svelte`: Updated to use `vad.state`
- [x] `apps/whispering/src/routes/(app)/+page.svelte`: Updated to use `vad.state`
- [x] `apps/whispering/src/routes/(app)/(config)/+layout.svelte`: Updated to use `vad.state`
- [x] `apps/whispering/src/routes/(app)/_layout-utils/alwaysOnTop.svelte.ts`: Updated to use `vad.state`
- [x] `apps/whispering/src/lib/components/settings/selectors/VadDeviceSelector.svelte`: Updated to use inline `createQuery` with `vad.enumerateDevices()`
- [x] `apps/whispering/src/routes/(app)/(config)/settings/recording/VadSelectRecordingDevice.svelte`: Updated to use inline `createQuery` with `vad.enumerateDevices()`
- [x] `apps/whispering/src/lib/query/index.ts`: Removed `vadRecorder` export
- [x] `apps/whispering/src/lib/services/index.ts`: Removed `vad` export

## Questions Before Implementation

1. Should we keep a thin query wrapper for API consistency, or access the service directly?
   **Decision**: Neither. We created a unified `vad.svelte.ts` module in the query folder that combines service logic with Svelte 5 `$state` reactivity. Components import `vad` directly from this module.

2. Should we apply the same pattern to `recorder.getRecorderState`? (Same invalidation pattern exists there)
   **Decision**: Out of scope for this refactor. Could be done in a follow-up if this pattern proves successful.

## Review

### Implementation Summary

The final implementation went simpler than originally proposed. Instead of using `createSubscriber`, we discovered that Svelte 5's `$state` rune alone is sufficient for VAD state reactivity. The key insight: `createSubscriber` is designed for external event sources (browser APIs, etc.), but VAD owns its own state; updating `$state` directly triggers reactivity automatically.

### Architecture Changes

**Before:**
- Service layer: `$lib/services/vad-recorder.ts` (creates `VadServiceLive`)
- Query layer: `$lib/query/vad-recorder.ts` (wraps service with `defineQuery`/`defineMutation`)
- Components: Use `createQuery(rpc.vadRecorder.getVadState.options)`

**After:**
- Single module: `$lib/query/vad.svelte.ts` with `$state` reactivity
- Components: Use `vad.state` directly (reactive getter)
- Device enumeration: Components use inline `createQuery` with `vad.enumerateDevices()`

### Key Code Patterns

```typescript
// $lib/query/vad.svelte.ts
export const vad = (() => {
  let _state = $state<VadState>('IDLE');

  return {
    get state(): VadState {
      return _state;  // Automatically reactive
    },
    async startActiveListening({ onSpeechStart, ... }) {
      // MicVAD callbacks update _state directly
      const newVad = await MicVAD.new({
        onSpeechStart: () => {
          _state = 'SPEECH_DETECTED';  // Triggers reactivity
          onSpeechStart();
        },
        // ...
      });
    },
  };
})();
```

### Benefits Achieved

1. **Simplified architecture**: Eliminated the service/query layer split for VAD
2. **Less code**: Deleted two files, added one simpler file
3. **Push-based reactivity**: No more `invalidateQueries` pattern
4. **Better performance**: No TanStack Query overhead for state reads
5. **Type safety**: Direct access to state without query wrapper

### Notes

- Device enumeration still uses `createQuery` for loading/error states, but calls `vad.enumerateDevices()` directly instead of going through `rpc.vadRecorder`
- Error handling in device selectors required `as unknown as { title: string }` casts because TanStack Query types errors as generic `Error`
