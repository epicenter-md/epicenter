# Manual Recorder State Ownership Refactor

**Date**: 2026-05-25
**Status**: Draft
**Owner**: Braden
**Branch**: `braden-w/bilbao-v1`

## One Sentence

Delete the ffmpeg recording backend, then replace TanStack Query's `getRecorderState`/`invalidateQueries` ceremony with a single `manualRecorder` module that owns its state via Svelte `$state`, mirroring the existing `vadRecorder` pattern.

## How to read this spec

```
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan

Read if changing the architecture:
  Design Decisions
  Rejected Alternatives
  Tauri snapshot+subscribe pattern

Historical / context:
  Research Findings
  Edge Cases
  Open Questions
```

## Overview

The manual recorder currently polls a TanStack Query (`rpc.recorder.getRecorderState`) and invalidates it after every mutation. The VAD recorder, by contrast, owns its state directly via `$state` in `$lib/state/vad-recorder.svelte.ts`. This spec collapses the manual recorder to the VAD shape. As a prerequisite, the ffmpeg recording backend is removed: it forces a three-way method branch that prevents the natural "browser → navigator, desktop → cpal" collapse and saves ~700 LOC plus a settings surface.

## Motivation

### Current State

State lives **three places at once**:

```
recorder.ts (query layer)
  defineQuery('getRecorderState')
    → recorderService().getRecorderState()
        → navigator.ts: returns Ok(activeRecording ? 'RECORDING' : 'IDLE')
        → ffmpeg.ts:    returns Ok(sessionState.current ? 'RECORDING' : 'IDLE')
        → cpal.ts:      invokes Rust 'get_current_recording_id'

After every start/stop/cancel: queryClient.invalidateQueries({ queryKey: ['recorder', 'recorderState'] })
```

Consumers create one query each:

```ts
// apps/whispering/src/routes/(app)/_layout-utils/alwaysOnTop.svelte.ts:8
const getRecorderStateQuery = createQuery(() => ({
  ...rpc.recorder.getRecorderState.options,
  enabled: settings.get('recording.mode') === 'manual',
}));

// 5 more files do the same.
```

This creates problems:

1. **State duplication**: Truth lives in the backend's internal var AND a Query cache, kept in sync by mutation-side `onSettled` callbacks. Drift is possible if any mutation forgets to invalidate.
2. **Async toggle**: `toggleManualRecording` calls `recorder.getRecorderState.fetch()` to decide whether to start or stop, paying a service round-trip per click.
3. **Inconsistent with VAD**: `vadRecorder.state` is a synchronous getter, `getRecorderStateQuery.data` is a TanStack Query. Reading both in one component (e.g. `+layout.svelte`) is jarring.
4. **Three-backend tax**: `recording.method ∈ {'navigator', 'ffmpeg', 'cpal'}` forces a `paramsMap` in `recorder.ts:89-118` and prevents platform-determined collapse.

### Desired State

One singleton, getter-based reactive state, mirroring VAD:

```ts
// $lib/state/manual-recorder.svelte.ts
export const manualRecorder = createManualRecorder();
manualRecorder.state // synchronous, reactive
await manualRecorder.startRecording({ toastId })
await manualRecorder.stopRecording({ toastId })
await manualRecorder.cancelRecording({ toastId })
```

```ts
// Consumers (8 files)
{RECORDER_STATE_TO_ICON[manualRecorder.state]}
```

## Research Findings

### Tauri state synchronization (canonical pattern)

Verified via DeepWiki against `tauri-apps/tauri`:

> "Fetch initial state via `invoke()` ... then listen for subsequent changes via `listen()`."

Two-step protocol: **snapshot + subscribe.**

| Mechanism | When to use | Trade-off |
|---|---|---|
| `app.emit` + `listen` | Broadcasting state changes | No replay; need initial `invoke()` |
| `Channel` | Ordered streaming, large payloads | One-to-one, heavier setup |

Our case: discrete state transitions, all listeners want the same value → `emit`/`listen`. Initial snapshot via `invoke('get_current_recording_id')` already exists on the Rust side.

### VAD pattern (the reference implementation)

`$lib/state/vad-recorder.svelte.ts` (208 LOC) is the proven shape:

- `let _state = $state<VadState>('IDLE')` at module scope
- Getter on returned object: `get state() { return _state; }`
- Mutates `_state` inside its own start/stop methods AND inside callbacks from MicVAD library
- `enumerateDevices` stays as a `defineQuery` (it benefits from TanStack's loading/error states)

VAD doesn't need snapshot+subscribe because its truth lives in JS and dies on reload. Manual recorder's cpal backend needs it because Rust survives JS reloads.

### ffmpeg-as-recorder: is it earning its keep?

| Aspect | Value |
|---|---|
| LOC of `ffmpeg.ts` recorder service | 679 |
| Additional surface | `FfmpegCommandBuilder.svelte`, `checkFfmpegRecordingMethodCompatibility()`, `recording.ffmpeg.*` settings, UI option in `ManualDeviceSelector.svelte` |
| What it adds vs CPAL | Custom shell flags, custom devices (`-f avfoundation`/`-f pulse`), custom filters |
| Default? | No. CPAL is default on desktop. ffmpeg is opt-in. |
| Telemetry on usage | None available. |

**Key finding**: ffmpeg-the-binary is *also* used for compression (CPAL → Opus) and local-transcription preprocessing (Navigator webm → WAV for Whisper/Parakeet/Moonshine). Those paths stay. Only ffmpeg-as-recording-backend is being removed.

**Implication**: dropping ffmpeg-as-recorder is a small product surface change (one settings option) with significant architectural payoff (collapses three-way branch to platform-determined binary).

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Remove ffmpeg as recording backend | 3 taste | Remove | 679 LOC + architectural drag for a power-user feature CPAL covers for everyone. ffmpeg-the-binary stays for compression/transcription. |
| State ownership | 2 coherence | `$state` in `$lib/state/manual-recorder.svelte.ts` | Mirror VAD. Eliminates Query+invalidate dance. |
| Single singleton vs per-backend factory | 2 coherence | Single singleton | With ffmpeg gone, navigator and cpal are platform-mutually-exclusive. Factory needs ≥2 live instances to earn its keep. |
| Module file location | 3 taste | `$lib/state/manual-recorder.svelte.ts` | Mirrors `$lib/state/vad-recorder.svelte.ts`. (Spec doc origin suggested `$lib/query/`; rejected for consistency.) |
| Keep `enumerateDevices` as `defineQuery` | 1 evidence | Keep | VAD does this; loading states are useful in device selectors. |
| Init seed strategy | 1 evidence | `void service.getRecorderState().then(...)` IIFE on cpal | Tauri canonical pattern: snapshot via invoke. One-tick flicker acceptable (reload is already ~200ms). |
| Tauri `emit`/`listen` for cpal state changes | Deferred | Plan for follow-up | JS-side `listen` placeholder in module; Rust `emit` lands in a separate PR. State stays correct without it; only edge case is Rust-side state changes that bypass our mutations. |
| Mutation mutex (`isRecordingOperationBusy`) | 2 coherence | Keep in `actions.ts` | Independent concern. Race prevention happens at the action layer, not the state layer. |

## Architecture

### Before

```
+-------------------+         +---------------------------+
| Consumer (Svelte) |  reads  | rpc.recorder.getRecorderState |
+-------------------+ ------> | (TanStack Query)              |
                              +---------------------------+
                                        | fetches
                                        v
                              +---------------------------+
                              | recorderService()             |
                              | - navigator (JS var)          |
                              | - ffmpeg    (persisted state) |
                              | - cpal      (Rust invoke)     |
                              +---------------------------+

Mutations (start/stop/cancel) → invalidate query → consumer re-fetches
```

### After

```
+-------------------+        +-----------------------------+
| Consumer (Svelte) |  reads | manualRecorder.state ($state) |
+-------------------+ -----> +-----------------------------+
                                          ^
                                          | sets directly on mutation success
                              +-----------------------------+
                              | service (selected at module init) |
                              | - browser  → NavigatorRecorder    |
                              | - desktop  → CpalRecorder         |
                              +-----------------------------+
                                          ^
                                          | (PR 3, future) Rust emit('recorder:state-changed')
                                          | snapshot: service.getRecorderState() on init
```

### Module shape

```ts
// $lib/state/manual-recorder.svelte.ts

const service = window.__TAURI_INTERNALS__
  ? CpalRecorderServiceLive
  : NavigatorRecorderServiceLive;

function createManualRecorder() {
  let _state = $state<WhisperingRecordingState>('IDLE');
  let _currentRecordingId: string | null = null;

  // Snapshot (cpal may have a Rust session from before reload)
  void service.getRecorderState().then(({ data }) => { if (data) _state = data; });

  // Subscribe (placeholder until Rust emit lands; harmless no-op until then)
  if (window.__TAURI_INTERNALS__) {
    void listen<WhisperingRecordingState>('recorder:state-changed', (e) => { _state = e.payload; });
  }

  return {
    get state(): WhisperingRecordingState { return _state; },
    enumerateDevices: defineQuery({ /* ... */ }),
    async startRecording({ toastId }) { /* sets _state = 'RECORDING' on success */ },
    async stopRecording({ toastId })  { /* sets _state = 'IDLE' */ },
    async cancelRecording({ toastId }) { /* sets _state = 'IDLE' */ },
  };
}

export const manualRecorder = createManualRecorder();
```

## Call sites: before and after

### alwaysOnTop.svelte.ts

**Before** (`apps/whispering/src/routes/(app)/_layout-utils/alwaysOnTop.svelte.ts:8-11`):

```ts
const getRecorderStateQuery = createQuery(() => ({
  ...rpc.recorder.getRecorderState.options,
  enabled: settings.get('recording.mode') === 'manual',
}));

// ...later:
if (getRecorderStateQuery.data === 'RECORDING' || ...) { ... }
```

**After**:

```ts
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

if (manualRecorder.state === 'RECORDING' || ...) { ... }
```

### actions.ts: toggleManualRecording

**Before** (`apps/whispering/src/lib/query/actions.ts:347-356`):

```ts
const { data: recorderState, error } = await recorder.getRecorderState.fetch();
if (error) { notify.error(error); return Ok(undefined); }
if (recorderState === 'RECORDING') return await stopManualRecording(undefined);
return await startManualRecording(undefined);
```

**After**:

```ts
if (manualRecorder.state === 'RECORDING') return await stopManualRecording(undefined);
return await startManualRecording(undefined);
```

### +page.svelte: stopAllRecordingModesExcept

**Before** (`apps/whispering/src/routes/(app)/+page.svelte:172-178`):

```ts
const { data: recorderState } = await rpc.recorder.getRecorderState.fetch();
const recordingModes = [
  { mode: 'manual', isActive: () => recorderState === 'RECORDING', stop: () => rpc.actions.stopManualRecording() },
  ...
];
```

**After**:

```ts
const recordingModes = [
  { mode: 'manual', isActive: () => manualRecorder.state === 'RECORDING', stop: () => rpc.actions.stopManualRecording() },
  ...
];
```

(The function can become synchronous now, but keep it async for parity with VAD's path until the wider refactor.)

## Implementation Plan

Single PR, sequenced commits. Each commit must typecheck and pass any existing tests.

### Phase 1: Remove ffmpeg as recording backend (Commit 1)

- [ ] **1.1** Delete `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts`
- [ ] **1.2** Delete `apps/whispering/src/routes/(app)/(config)/settings/recording/FfmpegCommandBuilder.svelte`
- [ ] **1.3** Remove `FfmpegRecordingParams` from the `StartRecordingParams` union in `services/recorder/types.ts`
- [ ] **1.4** Remove `ffmpegRecorder` from `services/desktop/index.ts`
- [ ] **1.5** Narrow `recording.method` in `state/device-config.svelte.ts` to `'cpal' | 'navigator'`; remove `recording.ffmpeg.*` keys
- [ ] **1.6** Add migration in `migration/migrate-settings.ts`: existing `recording.method === 'ffmpeg'` → `'cpal'`
- [ ] **1.7** Remove `ffmpeg` entry from `RECORDING_METHODS` in `ManualDeviceSelector.svelte`
- [ ] **1.8** Drop ffmpeg config section from `routes/(app)/(config)/settings/recording/+page.svelte` and `+page.ts`
- [ ] **1.9** Remove `checkFfmpegRecordingMethodCompatibility()` from `_layout-utils/check-ffmpeg.ts`; remove its call site in `AppLayout.svelte:onMount`
- [ ] **1.10** Remove ffmpeg branch from `paramsMap` in `query/recorder.ts:89-118` and the `recorderService()` selector
- [ ] **1.11** Grep for `recording.method === 'ffmpeg'` and `FfmpegRecorder`: verify zero matches outside of migration code

**Keep** (ffmpeg-the-binary):
- `services/desktop/ffmpeg.ts`
- `services/desktop/command.ts`
- `routes/(app)/(config)/install-ffmpeg/+page.svelte`
- `query/desktop/ffmpeg.ts:checkFfmpegInstalled`
- The other functions in `_layout-utils/check-ffmpeg.ts` (compression recommendations, local-transcription compatibility)

### Phase 2: Create the `manualRecorder` module (Commit 2)

- [ ] **2.1** Create `apps/whispering/src/lib/state/manual-recorder.svelte.ts` per the module shape above
- [ ] **2.2** Inline the params builder (CPAL needs `await PATHS.DB.RECORDINGS()` fallback; make `buildStartParams` async)
- [ ] **2.3** Inline the `_currentRecordingId` lifecycle (move from `query/recorder.ts:26`)
- [ ] **2.4** Move `enumerateDevices` query definition into the new module
- [ ] **2.5** Verify typecheck: module compiles but is not yet consumed

### Phase 3: Migrate consumers (Commit 3)

Independent file edits: can be fanned out. All swap `rpc.recorder.*` for `manualRecorder.*`.

- [ ] **3.1** `query/actions.ts`: replace all 4 `recorder.*` references; simplify `toggleManualRecording`
- [ ] **3.2** `_layout-utils/alwaysOnTop.svelte.ts`: delete `createQuery`, read `manualRecorder.state`
- [ ] **3.3** `_layout-utils/syncIconWithRecorderState.svelte.ts`: same
- [ ] **3.4** `_components/AppLayout.svelte`: same
- [ ] **3.5** `(config)/+layout.svelte`: same (5 reads of `getRecorderStateQuery.data`)
- [ ] **3.6** `(app)/+page.svelte`: same (4 reads + `stopAllRecordingModesExcept`)
- [ ] **3.7** `ManualDeviceSelector.svelte`: swap `rpc.recorder.enumerateDevices.options` → `manualRecorder.enumerateDevices.options`
- [ ] **3.8** `FfmpegCommandBuilder.svelte`: already deleted in Phase 1
- [ ] **3.9** `ManualSelectRecordingDevice.svelte`: same swap as 3.7

### Phase 4: Delete the old query layer (Commit 4)

- [ ] **4.1** Delete `apps/whispering/src/lib/query/recorder.ts`
- [ ] **4.2** Remove `recorder` from `rpc` namespace in `query/index.ts`
- [ ] **4.3** Final grep: `rpc.recorder` and `from './recorder'` should be zero
- [ ] **4.4** Run typecheck, lint, any existing tests

### Phase 5 (Future PR): Rust emit + JS listen

Out of scope for this PR. The `listen` call in the module is a placeholder; Rust doesn't emit yet. Documented as a follow-up because it requires Rust changes that should be reviewed independently.

## Edge Cases

### Init seed timing (cpal)

1. User records via cpal, force-quits or reloads mid-recording.
2. Rust still has an active session; JS module loads with `_state = 'IDLE'`.
3. `void service.getRecorderState().then(...)` fires; resolves ~1 tick later with `'RECORDING'`.
4. **Acceptable**: ~1ms flicker during which UI shows mic icon instead of stop icon. Reload is already ~200ms, so not user-perceivable.
5. If unacceptable, gate first interaction on a `_initialized: boolean` flag and show a spinner.

### Mid-recording method switch

Today's UI hides device/method selectors when recording. With ffmpeg gone, only navigator↔cpal swap is possible, and both UIs still hide selectors during recording. **Not reachable** through normal UI flow.

### Existing users with `recording.method === 'ffmpeg'`

Phase 1.6 migration auto-promotes to `'cpal'`. If user explicitly wanted ffmpeg's custom flags, they lose that feature with no warning. Mitigation: release notes mention the removal.

### Multiple consumers re-rendering

`$state` getters in Svelte 5 dedupe fine-grained reactivity. 8 consumers reading `manualRecorder.state` all subscribe to the same signal; no duplicate work vs the Query cache.

## Open Questions

1. **Should `recording.method` setting survive?**
   - With one platform-determined backend, the setting becomes vestigial.
   - Options: (a) keep it for forward-compat (b) delete it entirely (c) keep it but make it derived from platform.
   - **Recommendation**: keep the key (don't break migrations), but stop reading it. Remove the UI selector. Delete in a follow-up after one release cycle.

2. **Should `stopAllRecordingModesExcept` become synchronous?**
   - With both `manualRecorder.state` and `vadRecorder.state` synchronous, the function's awaits are unnecessary.
   - **Recommendation**: keep async for this PR (minimal diff), refactor in a follow-up.

3. **Snapshot via `void Promise` vs awaited in layout `onMount`?**
   - The IIFE has a one-tick flicker. Awaiting in `+layout.svelte:onMount` removes it.
   - **Recommendation**: IIFE for this PR. The flicker isn't user-visible and `onMount` coupling is a layering smell.

## Success Criteria

- [ ] `apps/whispering` typechecks
- [ ] No reference to `rpc.recorder.*` outside of `query/recorder.ts` deletion commit
- [ ] No reference to `'ffmpeg'` in `recording.method` contexts outside the migration
- [ ] Manual smoke test on Tauri: start, stop, cancel a recording via CPAL; state icon updates immediately on each transition
- [ ] Manual smoke test on browser: start, stop a recording via Navigator; same
- [ ] Existing user with `recording.method === 'ffmpeg'` setting gets migrated to `'cpal'` on first load
- [ ] Each of commits 1-4 typechecks independently
- [ ] PR description summarizes the four commits with a one-line "what" each

## References

- `apps/whispering/src/lib/state/vad-recorder.svelte.ts`: the pattern being mirrored
- `apps/whispering/src/lib/query/recorder.ts`: the file being deleted
- `apps/whispering/src/lib/services/recorder/types.ts`: `RecorderService` interface; `FfmpegRecordingParams` to remove
- `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts`: 679 LOC to delete
- `apps/whispering/src/lib/services/desktop/recorder/cpal.ts`: Rust-backed service; `getRecorderState` reads from Rust
- `apps/whispering/src/lib/services/recorder/navigator.ts`: browser backend; state in module-local var
- DeepWiki search: Tauri emit/listen pattern for state sync: verified canonical "snapshot + subscribe"
