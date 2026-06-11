# Rust Transcription Service: Ambient Config + Loading Events

**Date**: 2026-05-27
**Status**: Implemented (pending Rust regen of bindings on stable toolchain)
**Owner**: Whispering desktop
**Base**: `origin/main` at 01438a78f
**Branch**: `braden-w/rust-transcription-service`
**Supersedes**: `specs/20260526T034000-rust-transcription-service-boundary.md` (state-machine design rejected as over-engineered)

## One Sentence

Extend main's `ModelManager` with ambient config + preload + loading events + panic-safe inference, so the FE pushes settings once, observes state, and calls `commands.transcribeRecording({ recordingId })` with no per-call config arg.

## How to read this spec

```txt
Read first:
  One Sentence
  Why this is small
  Architecture (diff against main)
  Command and event surface
  Implementation plan

Read if grilling the design:
  Self-grill section (every claim has a "why this earns its keep")
  Rejected alternatives

Skip:
  Nothing. This spec is short on purpose.
```

## Why this is small

The predecessor spec built a 730-line `TranscriptionService` with a four-variant `EngineSlot` state machine and take/put-back semantics. After main landed the artifact-based architecture (recording_id, `read_artifact_samples`, specta bindings), the state machine no longer earned its keep:

- The state machine's defining property is "slot is None during inference". Nothing in the system observes that property usefully. The idle watcher uses `try_lock`; `setConfig` writes to a separate `RwLock`.
- Take/put-back protects against mutex poisoning. So does `catch_unwind` under hold-lock. The latter is one wrapper, not 400 LOC of state transitions.
- Main's `ModelManager` already implements the cache lifecycle correctly. Replacing it instead of extending it is a regression on diff size with no payoff.

This spec extends `ModelManager` in place. Net new code: roughly 200 LOC of Rust + 80 LOC of TS, plus the bindings regeneration step.

## Architecture (diff against main)

```txt
WHAT MAIN HAS TODAY
+----------------------------------------------------------+
| FE: transcribe.ts                                        |
|   case 'whispercpp':                                     |
|     commands.transcribeRecording({                       |
|       recordingId, config: { engine, modelPath, ... }    |
|     })                                                   |
+----------------------------+-----------------------------+
                             |
+----------------------------v-----------------------------+
| FE: +layout.svelte                                       |
|   $effect: invoke('set_unload_policy', { policy })       |
+----------------------------+-----------------------------+
                             |
+----------------------------v-----------------------------+
| Rust: transcription::                                    |
|   transcribe_recording(id, config) -> spawn_blocking ->  |
|     read_artifact_samples(id) -> run_inference ->        |
|     ModelManager.with_X(path, |engine| engine.transcribe)|
|   set_unload_policy(policy)                              |
| ModelManager: cache (Mutex), policy (RwLock),            |
|               idle watcher, poisoning-on-panic recovery  |
+----------------------------------------------------------+


WHAT THIS SPEC ADDS
+----------------------------------------------------------+
| FE: transcribe.ts                                        |
|   case 'whispercpp':                                     |
|   case 'parakeet':                                       |
|   case 'moonshine':                                      |
|     commands.transcribeRecording({ recordingId })        |
+----------------------------+-----------------------------+
                             |
+----------------------------v-----------------------------+
| FE: +layout.svelte                                       |
|   ONE $effect: commands.setTranscriptionConfig({ ... })  |
|   onMount: localModel.attach()                           |
+----------------------------+-----------------------------+
                             |
+----------------------------v-----------------------------+
| Rust: transcription::                                    |
|   transcribe_recording(id)              <-- drop arg     |
|   set_transcription_config(config)      <-- new          |
|   get_transcription_state()             <-- new          |
| ModelManager: + config (RwLock), + app (AppHandle),      |
|               + preload(), catch_unwind under hold-lock, |
|               emits transcription://model-state events   |
+----------------------------------------------------------+
```

## Design Decisions

| Decision | Why |
|---|---|
| Drop `config: TranscribeRequest` arg from `transcribe_recording` | Ambient state replaces it. One source of truth, no FE diff-tracking. |
| One `set_transcription_config(config)` replaces `set_unload_policy` | Unload policy + (engine, modelPath, language, prompt, translate) are one coherent push. |
| Preload triggered inside `setConfig` when (engine, modelPath) drifts | Real UX win on whisper-medium/large (~10s cold-start). No explicit `preload` command for v1. |
| Extend `ModelManager` in place; do NOT add a new `TranscriptionService` wrapper | One struct already owns cache + policy. Adding config + app + preload keeps ownership coherent. |
| Hold lock through inference + `catch_unwind(AssertUnwindSafe(...))` | Equivalent panic-safety to take/put-back, ~10 LOC vs 400 LOC. Validated by reading Handy's pattern: their take/put-back is a workaround for Rust's `MutexGuard` not being `UnwindSafe`; `AssertUnwindSafe` makes hold-lock viable. |
| Events on `transcription://model-state`, full state payload | Required because `AppHandle::emit` does not replay to future windows. Cited from Tauri docs (search id `9a9a17fb-f262-4098-a6b6-42adbb806dd4`). |
| `get_transcription_state()` snapshot command | Required by the same emit-no-replay constraint for late-mounted observers. |
| All new commands specta-typed | House convention as of #1833. AGENTS.md documents the rule. |
| Moonshine variant parsed in Rust from `modelPath` | Removes the TS arkregex. Variant is a loader concern; the directory naming convention already encodes it. |
| Lazy `modelPath` validation (no eager check in setConfig) | Filesystem can change between push and use. Eager validation creates a TOCTOU window. |
| Catalogs (`WHISPER_MODELS` etc) move to `lib/constants/local-models.ts` | Pure download metadata, not transcription plumbing. Belongs in constants. |

## TranscriptionConfig (Rust + generated TS)

```rust
// apps/whispering/src-tauri/src/transcription/config.rs (new file)
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionConfig {
    pub engine: Engine,
    pub model_path: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub translate: bool,
    pub unload_policy: UnloadPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[serde(rename = "whispercpp")]
    Whisper,
    Parakeet,
    Moonshine,
}

// UnloadPolicy lives in model_manager.rs already; add Serialize + specta::Type.
```

The TS shape is generated by `tauri-specta` into `bindings.gen.ts`. No hand-written TS type.

## Command surface

```rust
// transcription/mod.rs

#[tauri::command]
#[specta::specta]
pub fn set_transcription_config(
    config: TranscriptionConfig,
    model_manager: State<'_, ModelManager>,
) {
    model_manager.set_transcription_config(config);
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    recording_id: String,
    app_handle: AppHandle,
    model_manager: State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    // No `config` arg; ModelManager reads ambient state.
    let samples = read_artifact_samples(&app_handle, &recording_id)
        .map_err(|e| TranscriptionError::AudioReadError { message: e })?;
    let manager = model_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.transcribe(samples))
        .await
        .map_err(join_err)?
}

#[tauri::command]
#[specta::specta]
pub fn get_transcription_state(
    model_manager: State<'_, ModelManager>,
) -> LocalModelState {
    model_manager.snapshot()
}
```

`set_unload_policy` and the entire `TranscribeRequest`/`MoonshineVariantWire` machinery DELETE.

## Event surface

```rust
// transcription/events.rs (new file, ~80 LOC)

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStateEvent {
    LoadingStarted { state: LocalModelState },
    LoadingCompleted { state: LocalModelState, elapsed_ms: u64 },
    LoadingFailed { state: LocalModelState, error: String },
    Unloaded { state: LocalModelState, reason: UnloadReason },
    SelectionChanged { state: LocalModelState },
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnloadReason {
    Immediate,
    Idle { idle_secs: u64 },
    ConfigChanged,
    Shutdown,
    PanicRecovered { error: String },
}

#[derive(Debug, Clone, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelState {
    pub engine: Option<Engine>,
    pub model_path: Option<String>,
    pub status: ModelStatus,
}

#[derive(Debug, Clone, Serialize, specta::Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStatus {
    Idle,
    Loading,
    Ready,
    Inferring,                      // engine is mid-inference (lock held)
    Error { message: String },
}
```

Channel name: `transcription://model-state`. Broadcast via `app.emit(...)`. Events carry full state (not deltas) because emit does not replay to future windows.

## ModelManager additions

Field-by-field diff:

```rust
pub struct ModelManager {
    cached: Arc<Mutex<Cached>>,                     // existing
    last_activity_ms: Arc<AtomicU64>,               // existing
    policy: Arc<RwLock<UnloadPolicy>>,              // existing (folded into config below)
    // NEW:
    config: Arc<RwLock<Option<TranscriptionConfig>>>,
    app: Arc<AppHandle>,                            // for event emission
}
```

Behavior:

- `ModelManager::new(app: AppHandle)` instead of `new()`. The `manage()` registration in `lib.rs::setup` becomes `manager.manage(ModelManager::new(app.handle().clone()))`.
- `set_transcription_config(config)`: writes config; if `engine + model_path` changed, spawn a preload task that calls `with_engine` with a no-op closure. Updates `policy` from `config.unload_policy`. Emits `SelectionChanged` then (during preload) `LoadingStarted` / `LoadingCompleted` / `LoadingFailed`.
- `transcribe(samples)`: reads ambient config; if `None`, returns `NoConfig`. Otherwise dispatches to `with_whisper` / `with_parakeet` / `with_moonshine` using the ambient values. Wraps inference in `catch_unwind`.
- `snapshot() -> LocalModelState`: reads `cached` + `config` under their locks, builds the snapshot.
- `with_engine` extensions:
  - Emit `LoadingStarted` before calling `load`.
  - On load success: emit `LoadingCompleted { elapsed_ms }`. On load failure: emit `LoadingFailed`.
  - Wrap `use_engine(engine)` in `catch_unwind(AssertUnwindSafe(...))`. On `Err(panic)`: take the slot, emit `Unloaded { reason: PanicRecovered }`, return `TranscriptionError`. The slot was held by the guard; `MutexGuard` is not `UnwindSafe` but `AssertUnwindSafe` is sound because we drop the engine and clear the slot in the panic branch, so no other caller observes partial state.
  - On `Ok(...)`: existing behavior (touch activity, evict_if_immediate if policy is Immediate).

The `policy: Arc<RwLock<UnloadPolicy>>` field collapses into `config.unload_policy`. Reads go through `config.read().unload_policy` instead of `policy.read()`.

## Frontend migration

Files to delete (already deleted on the predecessor branch; doing again here):

```
apps/whispering/src/lib/services/transcription/local/local-transcription.ts
apps/whispering/src/lib/services/transcription/local/whispercpp.ts
apps/whispering/src/lib/services/transcription/local/parakeet.ts
apps/whispering/src/lib/services/transcription/local/moonshine.ts
```

Catalogs move:

```
apps/whispering/src/lib/services/transcription/local/types.ts
  -> apps/whispering/src/lib/constants/local-models.ts
```

(Keep `WHISPER_MODELS`, `PARAKEET_MODELS`, `MOONSHINE_MODELS`, `*ModelConfig` types, `isModelFileSizeValid`. Drop `MOONSHINE_VARIANTS` regex constants if the variant parsing moves to Rust.)

New file:

```ts
// apps/whispering/src/lib/state/local-model.svelte.ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands, type LocalModelState, type ModelStateEvent } from '$lib/tauri/commands';
import { tauri } from '$lib/tauri';

class LocalModel {
  state = $state<LocalModelState>({ engine: null, modelPath: null, status: { kind: 'idle' } });

  async attach(): Promise<UnlistenFn> {
    if (!tauri) return () => {};
    this.state = await commands.getTranscriptionState();
    return listen<ModelStateEvent>('transcription://model-state', (event) => {
      this.state = event.payload.state;
    });
  }

  get isBusy(): boolean {
    const kind = this.state.status.kind;
    return kind === 'loading' || kind === 'inferring';
  }
}

export const localModel = new LocalModel();
```

Modified files:

| File | Change |
|---|---|
| `apps/whispering/src/routes/(app)/+layout.svelte` | Replace `set_unload_policy` $effect with `setTranscriptionConfig` $effect. Add `localModel.attach()` in `onMount`. |
| `apps/whispering/src/lib/operations/transcribe.ts` | Collapse three local cases to `commands.transcribeRecording({ recordingId })`. Drop the `config` construction for local engines. |
| `apps/whispering/src/lib/services/transcription/index.ts` | Drop the three local exports. |
| Settings UI imports | Re-point to `lib/constants/local-models.ts`. |

The single setConfig effect:

```svelte
$effect(() => {
  if (!tauri) return;
  const service = settings.get('transcription.service');
  if (!isLocalEngine(service)) return;

  const modelPath = deviceConfig.get(`transcription.${service}.modelPath`);
  if (!modelPath) return;

  void commands.setTranscriptionConfig({
    engine: service,
    modelPath,
    language: outputLanguageOrNull(),
    initialPrompt: settings.get('transcription.prompt') || null,
    translate: settings.get('transcription.translate') ?? false,
    unloadPolicy: deviceConfig.get('transcription.localModelUnloadPolicy'),
  });
});
```

## Working checkpoints

Each MUST end with `bun run build` passing AND a manual transcribe-end-to-end smoke test.

### Checkpoint A: Rust extension

- [x] Create `transcription/config.rs` with `TranscriptionConfig`, `Engine`. Add `Serialize` + `specta::Type` to `UnloadPolicy`.
  > **Deviation**: `UnloadPolicy` moved into `config.rs` (out of `model_manager.rs`) and restructured to flat variants (`Never`, `Immediately`, `AfterFiveMinutes`, `AfterThirtyMinutes`) with serde renames matching the FE wire strings exactly. The old `from_wire` string parser is gone: serde handles deserialization.
  > **Added**: `should_preload(old, new) -> bool` helper, per grilling-fix #3.
- [x] Create `transcription/events.rs` with `ModelStateEvent`, `UnloadReason`, `LocalModelState`, `ModelStatus`.
  > Added `EVENT_CHANNEL: &str = "transcription://model-state"` constant so both Rust emitter and TS listener key off one symbol (well, until the FE consumes the constant via bindings; for now it's a string literal on the FE side).
  > `u64` fields (`elapsed_ms`, `idle_secs`) carry `#[specta(type = u32)]` to avoid the bigint guard, per grilling-fix #4.
- [x] Extend `ModelManager` with `config`, `app`, `status` fields and the new constructor `ModelManager::new(app)`.
  > **Added** `status: Arc<RwLock<ModelStatus>>` (grilling-fix #2): lock-free snapshot path. `snapshot()` reads only `status` and `config`, never touches `cached`, so a new window calling `getTranscriptionState` mid-inference does not block.
  > Old `policy: Arc<RwLock<UnloadPolicy>>` field is gone (collapsed into `config.unload_policy`).
- [x] Add `set_transcription_config`, `transcribe(samples)`, `snapshot`, `preload` methods on `ModelManager`.
  > `set_transcription_config` returns immediately: the eviction-then-preload runs on `spawn_blocking` so the Tauri command thread never waits on the cache mutex.
- [x] ~~Add `catch_unwind(AssertUnwindSafe(...))` wrap inside `with_engine` around both `load(&model_path)` and `use_engine(engine)`.~~
  > **Dropped**. `Cargo.toml` has `[profile.release] panic = "abort"`, which makes `catch_unwind` a no-op in the only build that matters. Per the grilling-finding-1 caveat, C aborts from `GGML_ASSERT` are also uncatchable. The existing `lock_cached` poisoning recovery handles what is recoverable. The status field is set to `Error` on inference failure so the FE sees a clear failure state; the cache is NOT cleared on inference failure (the engine is still loaded; a transient FFI hiccup should not force a reload).
- [x] Emit `LoadingStarted`/`LoadingCompleted`/`LoadingFailed` from `with_engine`'s load branch and `preload`.
  > Status sequence is codified (grilling-fix #5):
  > - Load + transcribe: `Idle/Ready → Loading → Ready → Inferring → Ready` (or `Error`)
  > - Preload only (no-op closure): `Idle/Ready → Loading → Ready → Inferring → Ready` where the `Inferring → Ready` step is imperceptible because the closure returns instantly.
- [x] Register new commands in `make_specta_builder` and `collect_commands!`.
- [x] Delete `set_unload_policy` command. Delete old `transcribe_recording`'s `config: TranscribeRequest` arg. Delete `TranscribeRequest`, `MoonshineVariantWire`, `run_inference`.
  > Moonshine variant parsing now happens in Rust (`parse_moonshine_variant`) and produces a `TranscriptionError::ConfigError` on malformed names (grilling-finding #2).
- [x] Update `manage()` registration to use `ModelManager::new(app.handle().clone())`.
  > Moved `.manage(ModelManager::new(...))` into `.setup()` per grilling-fix #6: the eager builder-time `manage` could not pass an `AppHandle`.
- [x] **Added** sample sanitization at the Rust boundary (`sanitize_samples`): replaces NaN/Inf with 0.0 and truncates at one hour of 16kHz mono, per grilling-finding-1 mitigation.
- [ ] `bun run --cwd apps/whispering bindings:tauri` to regenerate `bindings.gen.ts`.
  > **Blocked locally**: Homebrew Rust 1.90 in this workspace is one version behind specta-2.0.0-rc.25's requirement (`debug_closure_helpers`, stabilized in 1.91). CI uses `dtolnay/rust-toolchain@stable` and will pick this up. `bindings.gen.ts` was **hand-edited** to the shape specta will produce, so `bun typecheck` passes; the regen should be a no-op when run on stable.
- [ ] `bun run build` passes.
  > FE side: `bun run --cwd apps/whispering typecheck` reports **0 errors, 11 pre-existing warnings**. Rust side: deferred to CI for the same toolchain reason.

### Checkpoint B: FE migration

- [x] ~~Create `lib/constants/local-models.ts`.~~ Already done on this branch by prior work. Verified `WHISPER_MODELS`, `PARAKEET_MODELS`, `MOONSHINE_MODELS` + types live there.
- [x] Create `lib/state/local-model.svelte.ts`.
  > Listener registered **before** snapshot (worst case is one stale render; next event self-heals because every event carries full state). Sequence numbers not added (overkill).
- [x] In `+layout.svelte`: replace `set_unload_policy` $effect with `setTranscriptionConfig` $effect. Add `localModel.attach()` in `onMount` with unlisten on destroy.
  > **Deviation**: `translate` field dropped from the pushed config (grilling-finding #1). The `transcription.translate` setting does not exist in the workspace KV schema; adding it is a separate decision the spec deferred to "NOT in scope".
- [x] In `transcribe.ts`: collapse the three local cases into one `commands.transcribeRecording({ recordingId })` call.
  > Per-engine FE preflight (path existence, file-vs-directory, whisper truncation check, moonshine name validation) kept in `dispatchLocalTranscription` because Rust's generic `ModelLoadError` would be a regression on error message quality.
- [x] Delete `services/transcription/local/{whispercpp,parakeet,moonshine,local-transcription}.ts`.
  > Already done on this branch by prior work; the directory `services/transcription/local/` no longer exists.
- [x] Update `services/transcription/index.ts` to drop three exports.
  > Already done on this branch.
- [ ] Wire the transcribe button (or wherever) to disable while `localModel.isBusy`.
  > **Deferred**: `localModel.isBusy` is exported; consumer wiring is a separate UI task. The state machine is in place.
- [x] **Hand-edit `bindings.gen.ts`** to match the new command surface and types (TS-side regression-prevention until CI regenerates).
- [x] **Update `commands.test-d.ts`** with new type assertions for `setTranscriptionConfig`, `getTranscriptionState`, and the updated `transcribeRecording` signature.

### Checkpoint C: Verification

- [x] `rg 'set_unload_policy' apps/whispering` returns zero matches.
- [x] `rg 'services/transcription/local/' apps/whispering/src` returns zero matches.
- [x] `bun typecheck` passes (0 errors).
- [ ] **Followup needed**: register `ModelStateEvent` via `tauri_specta::collect_events!` so when bindings regenerate on stable, the event type stays exported. Currently `ModelStateEvent` is only hand-written in `bindings.gen.ts`; specta will drop it on regen unless `.events(collect_events![ModelStateEvent])` is added to `make_specta_builder` alongside `#[derive(tauri_specta::Event)]` on the type.
- [ ] Manual smoke tests (deferred to a build environment with stable Rust):
  - Each local engine transcribes a 5s clip end-to-end.
  - Switch engine in settings → observe `Unloaded(ConfigChanged) → LoadingStarted → LoadingCompleted`.
  - Open a second window mid-load → `localModel.state` populated via `getTranscriptionState`.
  - Set `unloadPolicy: 'immediately'`, transcribe → observe `Unloaded { Immediate }`.

## Edge cases

| Case | Behavior |
|---|---|
| `transcribe_recording` arrives before any `setTranscriptionConfig` | Returns `NoConfig` error. FE disables transcribe button until `localModel.state.engine !== null`. |
| Settings change mid-transcribe | In-flight inference holds the cache lock; setConfig writes to `config` RwLock (different lock); preload task waits on cache lock. Inference completes on old engine; preload runs after lock releases. |
| Panic during inference | `catch_unwind` catches; slot is cleared while still holding the guard (no poisoning); `Unloaded { PanicRecovered }` emitted; Err returned. Next transcribe reloads. |
| Panic during load | Same pattern: catch, clear slot (it was being populated), emit `LoadingFailed`, return Err. |
| Window closed during loading | Event broadcasts to remaining windows; new window calls `getTranscriptionState` on mount, sees current. |
| Idle watcher during inference | `try_lock` fails (transcribe holds it), watcher skips tick. Activity timestamp refreshes after inference completes. |

## Self-grill (before handing off)

I'm grilling my own design here. Every claim below has to survive scrutiny before I trust the spec.

### Is ambient config genuinely better than per-call config?

**Per-call wins**: stateless, no race, no extra command, easier to test.
**Ambient wins**: preload knows what to load without an extra command; FE call site is shorter; unload policy is genuinely ambient (not per-call) so it naturally pairs with the rest.

**Verdict**: ambient is a net win only because preload is in scope. If we drop preload, ambient becomes worse than per-call. Since preload is a real UX win on whisper-medium/large (5-15s cold-start), ambient stays.

**Risk**: the "transcribe-before-setConfig" race on app startup. Mitigation: FE button is disabled until `localModel.state.engine !== null`. The error path is the safety net.

### Is preload genuinely a UX win?

Cold-start latency by model:
- whisper-tiny (78MB): <1s. Preload barely matters.
- whisper-small (488MB): 2-4s. Preload nice.
- whisper-medium (1.5GB): 5-10s. Preload significant.
- whisper-large-v3-turbo (1.6GB): 8-15s. Preload critical.
- parakeet (~670MB): 2-5s. Preload nice.
- moonshine (~30-65MB): <1s. Preload barely matters.

For the high end (medium/large), preload moves perceptible latency off the user's stop-recording click. Worth keeping.

**Counter-grill**: what if the model gets evicted (idle 5min default)? Then preload only helps the first transcribe after settings change. Users who transcribe once an hour pay cold-start every time.

**Mitigation candidate (future)**: trigger preload from recording-start, not settings-change. Out of scope for v1; document in "Not in scope".

### Is take/put-back genuinely worse than hold-lock + catch_unwind?

Handy uses take/put-back. The deepwiki citation says it's for mutex poisoning.

But `catch_unwind` under hold-lock prevents poisoning too. The panic is caught inside the guarded region, before the guard drops.

Take/put-back also lets other code observe the cache during inference. But nothing in our system needs to: idle watcher uses `try_lock`, setConfig writes to a separate RwLock.

**Verdict**: take/put-back is a fine pattern but its specific benefit (slot is None during inference) is unconsumed. Hold-lock + catch_unwind is shorter and covers the same panic-safety property. Take/put-back wins for code that DOES need cache-during-inference observability, which we don't.

**Sanity check**: does `AssertUnwindSafe` lie? `MutexGuard` is `!UnwindSafe` because a panic with the guard held could leave the protected data in a partial state observable by the next lock acquirer. With `AssertUnwindSafe` + clearing the slot in the panic branch, we guarantee the next acquirer sees `None`, not partial state. The assertion is sound.

### Are events worth the complexity vs polling?

Polling `get_transcription_state` every 250ms during a load: ~40 polls for a 10s load. Each is an IPC roundtrip. Not free.

Events: zero polls, push-based, real-time UI.

For users on macOS/Windows where `app.emit` is cheap, events win. For Linux where IPC has higher overhead, events win bigger.

**Verdict**: events win.

### Is the snapshot command essential, or can we live without?

Without it: new windows see "idle" status until the next state transition fires an event. For multi-window users (settings panel + main), this could show stale info for many seconds.

The command is ~10 LOC.

**Verdict**: cheap insurance, keep.

### Is extending `ModelManager` vs a new `TranscriptionService` wrapper the right call?

ModelManager already owns: cache, idle watcher, policy, eviction.
We add: config, app, preload, events.

Both belong to the same lifecycle (cache + config + events all happen during transcribe). Splitting into ModelManager (cache) + TranscriptionService (config) means TranscriptionService holds an Arc<ModelManager> and proxies most operations.

That wrapper adds a layer with no real boundary. Better to grow ModelManager.

**Verdict**: extend in place. Maybe rename to `TranscriptionService` later if the name "ModelManager" stops fitting; that's a follow-up.

### Could we simplify further by dropping events entirely?

Without events: FE has no loading-state visibility. Generic spinner today. Users don't complain audibly. So... do we need events?

**Counter-grill**: the user explicitly mentioned in the original prompt: "emits loading events". So events are part of the deliverable.

**Verdict**: events stay. They're cheap once the service layer exists.

### Is the FE observer worth being a separate file vs inline?

Multiple potential consumers:
- Transcribe button (disable while busy)
- Settings UI (current model display)
- Possible status bar

Separate file = singleton store. Worth the extra file.

### What's the riskiest thing about this design?

The `AssertUnwindSafe` claim. If transcribe-rs's engines have any internal state that gets corrupted by a panic mid-inference (e.g., partial buffer write, dangling pointer in C FFI), `catch_unwind` catches the panic but the engine is still corrupt. Dropping the engine after panic mitigates this. The corrupt object goes away. But if the panic happened during model load, the engine doesn't exist yet so this is moot. If during inference, we drop the loaded engine. Either way, the cache ends up clean.

The remaining risk: the C FFI (whisper.cpp) might not be panic-safe in the sense Rust expects. A `&mut` reference to a C struct that the C code partially wrote could leave the C struct in a state the next FFI call panics on. But since we DROP the engine on panic, that struct is freed via Drop. Drop is C code; if Drop itself panics... that's a Rust-level abort, not catchable.

**Mitigation**: not much we can do beyond what we're doing. Document the risk in panic-recovery comments. Trust that transcribe-rs's engine Drops are clean (they are, per the docs).

## Rejected alternatives

| Rejected | Why |
|---|---|
| Build the EngineSlot state machine from the predecessor spec | Over-engineered for the property nobody consumes. ~400 LOC for "slot is None during inference" that nothing reads. |
| Keep `set_unload_policy` and add `set_transcription_config` for the rest | Two commands for one push of ambient state. The clean break is one. |
| Keep `config: TranscribeRequest` arg on `transcribe_recording` AND add `set_transcription_config` | Hybrid API. Per-call or ambient, pick one. |
| Build a separate `TranscriptionService` struct that wraps `ModelManager` | Wrapper without a real boundary. Extend in place. |
| Take/put-back lock model | Equivalent panic-safety to hold-lock + `catch_unwind`, but ~30x the code. |
| Separate `PanicRecovered` event variant | Folds cleanly into `Unloaded { reason: PanicRecovered }`. One less FE branch. |
| Preload via recording-start hook | Future optimization. Out of scope for v1. Documented in NOT in scope. |
| Explicit `preload(config)` command | Redundant once `setConfig` triggers preload automatically. |
| Eager `modelPath` validation in `setConfig` | TOCTOU window. Lazy at load time is honest. |

## NOT in scope

- **Wave 2 catalog work**: download progress UI, model dedup, version pinning.
- **Additional engines**: Sherpa, Vosk, etc.
- **Accelerator selection UI**: per-engine CoreML/DirectML/Vulkan toggles.
- **Translate UI**: wire field ships now; UI placement is a separate design decision.
- **Cancellation mid-inference**: transcribe-rs has no cancel API.
- **Preload-on-recording-start**: future optimization.

## References

- `apps/whispering/src-tauri/src/transcription/mod.rs` - current main surface (transcribe_recording, set_unload_policy)
- `apps/whispering/src-tauri/src/transcription/model_manager.rs` - struct to extend
- `apps/whispering/src-tauri/src/recorder/artifact.rs` - read_artifact_samples + RecordingArtifact
- `apps/whispering/src/lib/tauri/commands.ts` - specta boundary adapter
- `apps/whispering/src/lib/tauri/bindings.gen.ts` - generated, regenerate with `bun run --cwd apps/whispering bindings:tauri`
- `apps/whispering/AGENTS.md` - specta registration convention
- `specs/20260526T034000-rust-transcription-service-boundary.md` - predecessor spec; superseded
- Handy reference for catch_unwind + hold-lock: predecessor spec carries the deepwiki citations
- Tauri event broadcast: deepwiki search `9a9a17fb-f262-4098-a6b6-42adbb806dd4`

## Open questions for the grilling agent

These are the design decisions I'm least confident in. The grilling agent should focus here:

1. **Is `AssertUnwindSafe` over a `MutexGuard` really sound for our case?** Rust marks `MutexGuard` as `!UnwindSafe` for a reason. I claim it's safe because we clear the slot in the panic branch. Verify against the Rust nomicon and against transcribe-rs's internals (does the engine ever leave its own slot via panic? probably not, but check).

2. **Does extending `ModelManager` violate single-responsibility?** It now owns cache + policy + ambient config + events + preload. Five concerns. Is the cohesion real, or am I avoiding a justified split?

3. **Is the "engine + modelPath drift triggers preload" rule correct?** What if only `unloadPolicy` changes? Preload shouldn't re-run. What if only `language` changes (Whisper)? No reload needed; just use the new language on next inference. Make sure the drift detection only fires on model identity, not config identity.

4. **Does emitting events from inside `with_engine` create a re-entrancy risk?** `app.emit` is sync but the event handler runs on the FE side asynchronously. Should be fine but verify.

5. **Is there a simpler design we missed?** E.g., skip ambient config entirely, do `preload(config)` as a separate command, keep `transcribe_recording(id, config)`. Is the per-call config + explicit preload actually cleaner than ambient?

## Final sanity-check ritual

Before this spec is executed, an agent should:

1. Re-read main's `transcription/mod.rs` and `model_manager.rs` and `recorder/artifact.rs` from scratch. Confirm the diff this spec proposes is accurate.
2. Verify the `AssertUnwindSafe + MutexGuard` claim against Rust documentation (specifically, the `std::panic::AssertUnwindSafe` docs and the nomicon's chapter on poisoning).
3. Check whether transcribe-rs's `WhisperEngine`, `ParakeetModel`, `MoonshineModel` have any documented panic-safety guarantees.
4. Confirm `tauri-specta` can serialize an enum with tuple-struct variants (the `UnloadReason::Idle { idle_secs: u64 }` shape). If not, restructure.
5. Verify the FE binding regeneration step actually picks up the new commands; the `make_specta_builder` registration in `lib.rs` is the source of truth.
6. Walk Open Questions 1-5 and either resolve them in-line in the spec or escalate them as blockers.

## Grilling Findings (round 1)

Grilled against transcribe-rs v0.3.8 (cjpais/transcribe-rs), whisper.cpp issue tracker, the Rustonomicon poisoning chapter, the std::panic docs, and specta's internally-tagged enum exporter. Findings are blunt on purpose.

### 1. CLAIM 1 (AssertUnwindSafe + MutexGuard sound): PARTIALLY SOUND, with a buried critical caveat

The MutexGuard + AssertUnwindSafe pattern itself is sound. `MutexGuard` is `!UnwindSafe` because a panic-while-locked could leave the protected data in a broken logical state visible to the next acquirer. The spec's mitigation (clear the slot in the panic branch before the guard drops) preserves the logical invariant. Memory safety is already guaranteed by `Mutex` itself. The Rustonomicon's poisoning chapter is explicit: poisoning is a logical-invariant flag, not a memory-safety mechanism. The assertion is honest.

What the spec does NOT acknowledge, and what is the actual material risk:

**whisper.cpp aborts via GGML_ASSERT, and `catch_unwind` does not catch C aborts.** `catch_unwind` only catches Rust unwinding panics. A C-side `abort()` (which is what `GGML_ASSERT` / `WHISPER_ASSERT` call) bypasses it entirely; the process dies. This is a documented Rust property and a documented whisper.cpp behavior. Real-world examples: GGML_ASSERT firing on DTW alignment, quantized model mismatches, Metal `MUL_MAT` not implemented for certain dtypes, Metal command-buffer failures (whisper.cpp issues #2301, #1314, #1664, #1435). For the most common failure modes in production, the catch_unwind wrapper is theatre.

So the whole "panic-safe inference" pitch in the One Sentence is misleading. What we actually get is: Rust-panic-safe inference (ndarray OOB, hound parse panics, ORT panics that unwind, transcribe-rs internal panics). Not whisper.cpp-abort-safe. That is a real but smaller property than the spec implies.

Evidence: cjpais/transcribe-rs depends on whisper-rs, which does not catch panics and does not document panic safety; whisper-rs-sys exposes `ggml_abort` directly. transcribe-rs publishes no panic-safety guarantees. ParakeetModel and MoonshineModel hold mutable `KVCache` state during decode; partial mid-decode mutation is a logical-state issue (stale cache), not a UB issue, and dropping the engine on panic resolves it.

Recommended fix: drop the "panic-safe" framing as a top-line claim. Replace with "Rust-panic-recoverable; C aborts still take down the process. This is documented in `transcribe-rs`/`whisper.cpp` and is a known transcription crash class." Add a follow-up note that the only true mitigations are (a) sanitize samples at the Rust boundary before calling whisper (mono f32, 16kHz, non-empty, length cap, no NaN/Inf), (b) subprocess isolation in some future iteration. Option (a) is cheap and worth adding to the spec now. The artifact path already produces decoded samples; verify `read_artifact_samples` enforces these and add a check if not.

### 2. CLAIM 2 (extend ModelManager, don't split): SOUND

One-sentence test on the post-change struct: "Owns the resident engine's lifecycle and the state observers see while it runs." Cache + policy + ambient config + preload + event emission all serve that one sentence; they are not five concerns, they are one concern with five mechanisms. A separate `TranscriptionService` wrapping `ModelManager` would be an empty layer. The wrapper would proxy every method and own no new invariant. Cohesion wins. The struct could be renamed to `TranscriptionService` later when "Manager" stops fitting; that is a one-PR cosmetic.

Mild caveat: the struct now reaches further across the app boundary (owns an `AppHandle`). That is mild lifecycle-coupling, not a design smell.

### 3. CLAIM 3 (ambient config beats per-call): SOUND, BUT WEAKER THAN THE SPEC ASSERTS

The spec's tiebreaker is preload. Steelman of the alternative (keep per-call config, add explicit `preload_transcription_model(config)`):

- LOC: nearly identical; preload command is ~10 LOC.
- FE coordination: per-call requires the FE to build the same config payload at two call sites (transcribe + preload effect). Ambient builds it once in a single `$effect`. So ambient is genuinely DRY-er at the FE.
- Test surface: ambient adds a new `set_transcription_config` command and a `NoConfig` error path on `transcribe_recording`. Per-call adds a `preload(config)` command. Both surfaces are equal in size; the failure shapes differ.
- Race: ambient introduces "transcribe-before-setConfig" → mitigated by FE button gating. Per-call has no race but every call site must rebuild config from settings.

The honest verdict: ambient is a modest, defensible win driven mostly by FE call-site simplification and the fact that `unloadPolicy` is genuinely ambient state (no caller carries it per-request today). If preload is dropped from scope, the lead disappears. Spec's framing of preload as "the tiebreaker" is correct; do not let that line get cut in revision.

### 4. CLAIM 4 (hold-lock through inference is costless): UNSOUND AS WRITTEN: snapshot becomes a blocking call

The spec adds `get_transcription_state()` to support late-mounted observers, but proposes implementing `snapshot()` by reading `cached` + `config` under their locks. The cache lock is held for the entire inference. So a window opened mid-transcription calls `getTranscriptionState`, the call blocks for the duration of the inference, and then returns. For whisper-medium/large on a long clip, that is 30s+ of FE-side IPC stall. The grilling prompt explicitly flagged this and noted "the spec doesn't add this yet - verify." Verified: spec does not add a lock-free status path.

Two real fixes:

- (a) Track `ModelStatus` in an `Arc<AtomicU8>` (or `Arc<RwLock<ModelStatus>>`: RwLock is fine, status reads are cheap and writes are rare). Snapshot reads status from the atomic/RwLock and reads `engine + model_path` from the *config* RwLock (which is never held across inference). It does NOT touch `cached` Mutex.
- (b) Less elegant but acceptable: snapshot tries `try_lock` on `cached`; if it fails (inference in progress), report `status: Inferring` and pull engine/path identity from the ambient config. This avoids the lock-free atomic at the cost of "during-inference identity reflects config, not what's actually loaded in memory": which is fine because config drift triggers reload anyway.

Option (a) is the right shape. Add a `status: Arc<RwLock<ModelStatus>>` field to `ModelManager`, mutate it inside `with_engine` (Loading → Ready → Inferring → Ready, plus Error), and have `snapshot()` read it without touching `cached`. ~20 LOC.

The spec's "hold-lock is costless" line is wrong without this fix. With this fix, it is costless for inference and free for snapshot, with a tiny per-status RwLock write cost that doesn't matter.

Also worth flagging under this claim: `setConfig`'s auto-preload spawns a task that calls `with_engine`, which contends on the cache lock. If a transcribe is in flight when the user changes settings, the preload task blocks on the cache mutex for the full inference duration, then loads the new model. That is correct behavior, but the spec should say so explicitly in the edge-cases table (it already does, mostly: "preload task waits on cache lock": keep that line).

### 5. CLAIM 5 (events on a single channel with full state are sufficient): MOSTLY SOUND

Events carry full state, so deltas are unnecessary. The `getTranscriptionState` snapshot covers late-mount. The remaining race is `listen()` vs `snapshot()` order at FE mount: the spec's `local-model.svelte.ts` does `snapshot → listen`, which means an event fired *between* those two awaits is dropped. The window is small (single tick of Tauri's IPC) but not zero.

The right order is `listen → snapshot → dedupe by tracking which events arrived during the gap`. Without sequence numbers you cannot dedupe perfectly, but because every event is a full state replacement, the worst case is one stale render. The next event corrects it. Acceptable for v1.

Sequence numbers would be overkill; do not add them.

What the spec misses: event handler ordering inside `with_engine`. `LoadingStarted → load() → LoadingCompleted → use_engine() → SelectionChanged` (if drift) is implied but not codified. The exact sequence affects whether the FE ever observes `status: Ready` between load and inference. If inference begins synchronously after load with the lock held, the FE never sees Ready between them; it goes `Loading → Inferring`. That is fine for the transcribe-call path but wrong for the preload path (preload SHOULD leave the engine in `Ready`, since there is no inference following it). Codify: in `with_engine`, emit `Ready` after `load` only when there is no inference closure body to run; the preload path passes a no-op closure, so emit `Ready` at the end of that no-op path. The transcribe path emits `Inferring` before `use_engine` and `Ready` after.

This is a real correctness issue, not a nit.

### Open Questions resolution

| OQ | Resolution |
|---|---|
| 1 (AssertUnwindSafe sound?) | Yes for Rust panics; useless for whisper.cpp aborts. See Claim 1. Update spec framing. |
| 2 (extension violates SRP?) | No, one-sentence test passes. Optional rename to `TranscriptionService` is a follow-up. |
| 3 (drift detection identity?) | Resolved: compare `(engine, modelPath)` only. Codify a `fn should_preload(old: &TranscriptionConfig, new: &TranscriptionConfig) -> bool` so language/policy/prompt/translate changes never trigger preload. |
| 4 (event re-entrancy?) | None. `AppHandle::emit` is sync and returns `Result`; handler runs on the FE side asynchronously. Not a concern. |
| 5 (simpler design exists?) | Per-call config + explicit preload is the only credible competitor; modestly worse on FE DRY. Ambient stays. |

### Other findings the grill turned up

1. **`transcription.translate` setting does not exist in the FE schema.** `rg 'transcription\.translate' apps/whispering/src` returns zero matches today, but the spec's setConfig effect calls `settings.get('transcription.translate')`. That will throw or return `undefined`. Either add the setting to the schema with a default of `false` and document it in NOT in scope, or drop `translate` from the config entirely for v1 and add it in a follow-up. The spec says "wire field ships now; UI placement is a separate design decision" but never adds the storage. Pick one.

2. **`MoonshineVariantWire` is deleted but Rust parsing of variant from `modelPath` is hand-waved.** The spec line "Moonshine variant parsed in Rust from `modelPath`" hides ~15 LOC of work. The current TS code uses arkregex (`moonshine-(tiny|base)-(en|...)$`); in Rust this becomes a `path.file_name().and_then(|n| n.to_str()).and_then(...)` parse. Acceptable to keep this in the spec but the implementer must not skip the corrupted-name failure case. Map it to a new `TranscriptionError::ConfigError { message: "..." }` variant or fold it into `ModelLoadError`.

3. **FE migration list is incomplete.** Files that touch `transcription.{whispercpp,parakeet,moonshine}` keys today (verified by grep):
   - `lib/settings/transcription-validation.ts`
   - `lib/migration/migrate-settings.ts`
   - `lib/services/transcription/registry.ts`
   - `lib/components/settings/selectors/TranscriptionSelector.svelte`
   These are mostly type/constant references and likely fine after catalogs move to `lib/constants/local-models.ts`, but the spec only names the page-level imports. Add a verification step in Checkpoint C: `rg 'services/transcription/local/' apps/whispering/src` must return zero matches (with the four local files gone).

4. **`UnloadReason::Idle { idle_secs: u64 }` will serialize as `bigint` in TS by default.** specta's u64 → bigint guard is on. The existing `RecordingArtifact` uses `#[specta(type = Number<u64>)]` to opt out. Add the same attribute or change the type to `u32`. Minor nit but the bindings will be ugly otherwise.

5. **The current `transcribe_recording` test for the `commands.test-d.ts` file will break** when the signature drops `config`. Update the type-test alongside the bindings regeneration.

6. **`ModelManager::new(app)` is constructed inside `.setup(|app| { ... })`, but `.manage()` runs before `.setup()`.** Re-read `lib.rs:185`: `.manage(ModelManager::new())` happens during builder construction, BEFORE the app handle exists. The spec wants `ModelManager::new(app.handle().clone())`. The reshape is: move `.manage(ModelManager::new(...))` into `.setup()`, or construct ModelManager in two phases (`new()` returns a half-built struct, `attach_app(handle)` finishes it). Two-phase is uglier; moving the `manage` into `setup` is the right call. Update the spec's Implementation Plan: "Move `.manage(ModelManager::new(app_handle))` into the existing `.setup(|app| { ... })` closure; remove the eager `.manage(ModelManager::new())`."

### Concrete spec changes (apply before execution)

- [ ] **Soften the panic-safety framing in One Sentence and Architecture diagram.** Replace "panic-safe inference" with "Rust-panic-recoverable inference". Add a one-line caveat citing whisper.cpp's `GGML_ASSERT` behavior.
- [ ] **Add lock-free status field to ModelManager.** `status: Arc<RwLock<ModelStatus>>`. Snapshot reads it without touching `cached`. Update Field-by-field diff to include it.
- [ ] **Codify `should_preload(old, new) -> bool`.** Compare `(engine, model_path)` only.
- [ ] **Codify event order inside `with_engine`.** Preload path: `LoadingStarted → load → LoadingCompleted → Ready`. Transcribe path: `LoadingStarted → load → LoadingCompleted → Inferring → use_engine → Ready` (or Error on failure). Add the four panic-path emissions (`Unloaded { PanicRecovered }`, `LoadingFailed`).
- [ ] **Decide `translate`: add to FE settings schema with default `false`, OR drop from v1 config.** As written, the setConfig effect references a key that does not exist.
- [ ] **Add `#[specta(type = Number<u64>)]` to `UnloadReason::Idle.idle_secs` and `LoadingCompleted.elapsed_ms`.** Or use u32. Don't ship bigint to TS.
- [ ] **Move `.manage(ModelManager::new(app_handle))` into `.setup()`.** Eager `.manage()` at builder time cannot pass an AppHandle.
- [ ] **Add sample sanitization at Rust boundary** (mono f32, 16kHz, non-empty, length cap, no NaN/Inf) before passing into whisper.cpp, to reduce GGML_ASSERT crash surface. Owner: `transcription::mod.rs` between `read_artifact_samples` and `spawn_blocking`.
- [ ] **Document the listen-vs-snapshot ordering risk** in `local-model.svelte.ts` as a code comment; do not add sequence numbers.
- [ ] **Add Checkpoint C verification:** `rg 'services/transcription/local/' apps/whispering/src` returns zero matches.
- [ ] **Update `bindings.test-d.ts` / `commands.test-d.ts`** alongside `bindings:tauri` regen.
- [ ] **Specify Moonshine variant parse failure mode in Rust.** Either a new error variant or folded into `ModelLoadError`.

### Overall

**GO WITH CHANGES.** No design-level blocker. The five claims hold (one with a critical caveat the spec must acknowledge, one with a buried implementation gap the spec must close). The core decision: extend ModelManager, ambient config, events with snapshot: is right. Execute after applying the checklist above.

## Review

**Completed**: 2026-05-27
**Branch**: `braden-w/rust-transcription-service`

### Summary

Extended `ModelManager` in place with ambient `TranscriptionConfig`, a lock-free `ModelStatus` snapshot field, an `AppHandle`-backed event emitter on `transcription://model-state`, sample sanitization at the Rust/FFI boundary, and a `parse_moonshine_variant` helper that moves wire-format inference out of the FE. `transcribe_recording` lost its per-call `config: TranscribeRequest` argument; the FE now pushes a single `setTranscriptionConfig` once per change from a layout `$effect`, and a `getTranscriptionState` snapshot covers late-mounted observers. The deleted state machine from the predecessor spec stays deleted: the predecessor's invariant ("slot is None during inference") had no consumer, while hold-lock with status emission gives the FE everything it actually needs.

### Deviations from Spec

- **Dropped `catch_unwind`** machinery. `[profile.release] panic = "abort"` makes it a no-op in production, and `GGML_ASSERT` C aborts are uncatchable anyway. Existing `lock_cached` poisoning recovery covers the recoverable cases.
- **Dropped `translate` field** from `TranscriptionConfig`. The `transcription.translate` KV does not exist in the workspace schema; the spec deferred this to "NOT in scope" anyway, so the cleanest move was to omit it from v1.
- **Restructured `UnloadPolicy`** as flat serde-tagged variants (`Never`, `Immediately`, `AfterFiveMinutes`, `AfterThirtyMinutes`) with renames matching the FE wire strings. Drops the imperative `from_wire` string parser in favor of plain serde deserialization.
- **Moved `UnloadPolicy`** out of `model_manager.rs` into `config.rs` to keep config types co-located.
- **Hand-edited `bindings.gen.ts`** rather than regenerating via `bindings:tauri`: the local Homebrew Rust 1.90 cannot compile specta-2.0.0-rc.25 (needs Rust 1.91 stable for `debug_closure_helpers`). CI will pick the regen up; my hand-edit matches specta's expected output shape so TS typechecks today.

### Follow-up Work

1. **Register `ModelStateEvent` via `tauri_specta::collect_events!`.** When CI regenerates bindings, specta will drop `ModelStateEvent` and `UnloadReason` from the output because no command returns them. Fix: add `#[derive(tauri_specta::Event)]` on `ModelStateEvent` (and its referenced types as needed) and chain `.events(tauri_specta::collect_events![ModelStateEvent])` onto `make_specta_builder()` in `lib.rs`.
2. **Wire `localModel.isBusy` into the transcribe button.** The reactive state ships; consumer UI does not.
3. **Run smoke tests on a real desktop** (each engine, settings change mid-load, second window mid-load, `immediately` unload policy).
4. **Future:** preload from recording-start (not settings-change). Documented in NOT in scope but flagged by grilling-section as a real follow-up after 5min idle eviction lapses.
5. **Future:** subprocess isolation for whisper.cpp to recover from `GGML_ASSERT` aborts. Sample sanitization is the cheap first line of defense; subprocess isolation is the only true cure.

