# Whispering Recording Input Paths Clean Break

**Date**: 2026-05-29
**Status**: In Progress
**Owner**: Braden
**Branch**: `codex/recording-input-paths-clean-break`

## One Sentence

Recording is platform-owned: desktop manual recording uses CPAL for native capture, native overlay telemetry, and cloud upload preparation, and desktop is where local inference can run; browser manual recording uses Navigator for page-local capture and remote upload providers only.

## Product Sentence

Desktop manual recording is a native CPAL pipeline. Web manual recording is a browser Navigator pipeline. Desktop VAD remains browser-owned until Whispering has a native VAD backend. Transcription provider choice stays a runtime setting because it is a real user choice; manual capture backend choice does not.

## Current Shape

Manual recording still has two desktop backends. `deviceConfig` stores `recording.method` as `'cpal' | 'navigator'` in `apps/whispering/src/lib/state/device-config.svelte.ts:35`, `manual-recorder.svelte.ts` resolves CPAL vs Navigator at start time in `resolveServiceForStart()` and `buildStartParams()` (`apps/whispering/src/lib/state/manual-recorder.svelte.ts:62`, `apps/whispering/src/lib/state/manual-recorder.svelte.ts:74`), and the Tauri recorder barrel exports both implementations (`apps/whispering/src/lib/services/recorder/index.tauri.ts:1`).

The settings UI exposes that as a user-facing recording method selector (`apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:47`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:143`). The desktop Navigator option exists even though the UI warns that macOS global shortcuts may be unreliable when it is selected (`apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:184`).

```txt
Current:
  user setting recording.method
    -> cpal.tauri.ts OR navigator.ts
    -> artifact OR blob
    -> transcribe by recording id
```

The current code has already moved toward the target. CPAL returns a Rust-owned artifact handle, not raw bytes (`apps/whispering/src/lib/services/recorder/index.tauri.ts`). Navigator returns a `Blob` made from MediaRecorder chunks (`apps/whispering/src/lib/services/recorder/index.browser.ts`). The pipeline persists both under one recording id before transcription (`apps/whispering/src/lib/operations/pipeline.ts`).

That unified id shape is good. The runtime desktop capture choice is the part that no longer earns its keep.

## Target Shape

Tauri should never import Navigator for manual recording. The Tauri build resolves `$lib/services/recorder` to `index.tauri.ts`, which exports one manual recorder backed by CPAL. The browser build resolves the same import to `index.browser.ts`, which exports one manual recorder backed by Navigator. The choice is made by Vite filename suffixes, not by a device setting.

```txt
Target:
  Tauri build
    -> manual: CPAL recorder
    -> RecordingArtifact
       -> local: transcribeRecording(id)
       -> cloud: Opus/OGG upload
       -> overlay: mic-level events
    -> VAD: browser-owned MicVAD + MediaStream
       -> WAV blob
       -> remote upload or local desktop transcription by recording id

  Web build
    -> manual: Navigator recorder
    -> MediaRecorder Blob
    -> remote upload providers
    -> page-local feedback
```

The target recorder surface should say what the platform owns:

```ts
// Resolved at build time.
import { ManualRecorderLive } from '$lib/services/recorder';

await ManualRecorderLive.startRecording({
  recordingId,
  selectedDeviceId,
});
```

There is no `method` field in manual start params. CPAL-specific settings stay in the Tauri build. Navigator-specific bitrate stays in the browser build for manual recording. VAD keeps `recording.navigator.deviceId` because it uses browser capture, but it does not use Navigator bitrate.

VAD is different from manual recording. Today VAD is browser-owned on every platform because it depends on `@ricky0123/vad-web` and `device-stream`, not `NavigatorRecorderServiceLive`. This spec does not move VAD to CPAL. That means Navigator-like browser capture primitives still exist in the Tauri bundle for VAD, but manual recording should not be able to start `NavigatorRecorderServiceLive`.

## Implemented Shape After Wave 2

Manual recording now resolves through `ManualRecorderLive` from `$lib/services/recorder`. The Tauri implementation lives in `index.tauri.ts`; the browser implementation lives in `index.browser.ts`. The old `recording.method` key is gone from device config, migration mapping, manual recorder state, and the recording settings UI.

The pre-change "Current Shape" section remains as the historical problem statement. For live code, use this section and the implementation progress notes below.

## Recommendation

Desktop manual recording should be CPAL-only.

I did not find a desktop user behavior that only Navigator preserves and that is strong enough to keep a second manual capture backend inside Tauri. The closest candidate is immediate compressed MediaRecorder output for cloud providers. That is an implementation convenience, not product behavior. The Symphonia plus libopus spec named the CPAL cloud path, and the current Tauri build already implements it: `loadForCloudUpload` calls `encodeRecordingForUpload(recordingId)` to produce Opus/OGG. Navigator no longer owns a user-visible cloud quality or bandwidth advantage on desktop.

Navigator should not exist in the Tauri manual recording bundle. It can still exist in the repo for the browser build and for any VAD path that explicitly remains browser-owned. The important deletion is this: Tauri manual recording should not be able to start a MediaRecorder session.

Web should not support local providers. Web Navigator produces a browser `Blob`, and the browser build has no Rust model manager. Whispering already runs browser WASM inference for VAD through `@ricky0123/vad-web`; web local transcription would extend that proven pattern to a whisper-class model with model storage, worker isolation, and an acceptable latency budget. Until that plan exists, showing local transcription in web is a fake affordance. Web should keep remote upload providers, including cloud and self-hosted providers such as Speaches.

## Research Notes

Prior specs point in the same direction:

| Source | Useful fact | Implication |
| --- | --- | --- |
| `20260526T010258-build-time-platform-di.md` | Platform is a build-time fact; provider choice is a runtime fact. The recorder was left hybrid because `recording.method` still existed. | Delete the user setting and the recorder becomes a normal build-time platform service. |
| `20260526T000000-replace-ffmpeg-with-symphonia-libopus.md` | `Tauri + CPAL + local` is the hot path; `Tauri + CPAL + cloud` should encode to Opus/OGG; `Web + Navigator + cloud` uploads MediaRecorder output as-is. | The permutation matrix already has a clean CPAL desktop story. Reopen and refuse the deferred Tauri Navigator cell. |
| `2026-05-26-recorder-shape-investigation/REPORT.md` | Stop latency is not the differentiator; direct in-process local handoff is the real speed win. | Do not argue this change as a latency win. Argue it as ownership, artifact, overlay, and deletion. |
| `20260526T150401-canonical-recorder.md` | A canonical CPAL pipeline can return memory PCM for dictation and durable WAV for longform. | Use that as the desktop artifact direction, but do not turn Navigator into another arm of the same desktop abstraction. |
| `20260527T003910-transcription-providers-from-first-principles.md` | The good style is to frame the real question and refuse unearned abstractions. | The real question is capture ownership, not how to make two recorders look alike. |

External grounding:

| Source | Finding | Limit |
| --- | --- | --- |
| DeepWiki on `cjpais/Handy` | Handy is CPAL-only, uses native overlay windows, emits Rust mic-level events, and passes `Vec<f32>` to local transcription. | Handy is desktop-only and local-first. Whispering has web and cloud paths, so Handy is a comparison, not a template. |
| [Tauri calling the frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) | Tauri v2 supports backend-to-frontend events through `Emitter`, and global events are delivered to active listeners. | Events are not replayed. Late-created overlay windows still need snapshot commands for stateful data. |
| [Tauri capabilities](https://v2.tauri.app/security/capabilities/) and [core permissions](https://v2.tauri.app/reference/acl/core-permissions/) | Capabilities grant permissions to named windows and webviews; event listening requires event permissions such as `core:event:allow-listen`. | Every overlay window needs its own capability entry or an existing capability that explicitly includes its label. |
| [Tauri WebviewWindow API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/) | Tauri windows can be created and controlled, including always-on-top and cursor-ignore behavior. | A top-most webview is not automatically an OS-quality overlay. macOS all-Spaces and above-fullscreen behavior may require platform-specific native work beyond ordinary `WebviewWindow` options. |

## Artifact And Provider Matrix

| Build | Capture | Artifact at stop | Local provider | Cloud provider | Owner |
| --- | --- | --- | --- | --- | --- |
| Tauri | CPAL manual today | `RecordingArtifact` id handle for a 16 kHz mono WAV written at stop | Rust reads artifact by id and decodes to 16 kHz mono | `encodeRecordingForUpload(recordingId)` returns Opus/OGG, with raw artifact fallback on failure | Rust recorder artifact module |
| Tauri | CPAL dictation, future optional | Same id handle, with a possible in-process PCM fast lane before or alongside the write | Pass PCM directly only if the artifact write still happens or the product accepts losing durability | Encode from saved artifact, or from PCM only if the artifact contract is preserved | Rust recorder and Rust audio module |
| Tauri | CPAL longform, not built | Progressive durable WAV, likely native-rate if longform wants archival quality | Decode or stream from file | Encode WAV or decoded PCM to Opus/OGG | Future Rust recorder sink |
| Tauri | Navigator VAD today | WAV `Blob` from `utils.encodeWAV`, saved under the recording id | Rust reads artifact by id | Upload saved blob, with Tauri compression attempted when the artifact module can resolve it | Browser VAD plus artifact module |
| Web | Navigator manual | MediaRecorder `Blob`, usually WebM/Opus or MP4/AAC | Not supported | Upload blob as-is to remote providers | Browser page |
| Web | File upload | User file `Blob` | Not supported | Upload file as-is to remote providers | Browser page |
| Tauri | File upload | User file saved as recording artifact | Decode with Rust audio module | Upload as-is or normalize only when provider requires it | Artifact module plus transcription operation |

The artifact model should not pretend that `Blob`, `WAV file`, and `Vec<f32>` are the same thing. They are not. The current code has already found the smallest common invariant: a recording id. `RecordingArtifact` is the CPAL stop handle for that id, with metadata the UI and analytics may consume. Its `mimeType` is the place where WAV, WebM, OGG, or MP4 differences surface to the UI.

```txt
RecordingArtifact today:
  id
  durationMs
  byteLength
  mimeType

Physical bytes:
  cpal manual today    16 kHz mono WAV, written at stop
  navigator web        MediaRecorder blob saved under the same id
  file upload          original file blob saved under the same id
  cpal longform future progressive WAV, if longform becomes a product mode
```

The shared pipeline should continue to transcribe by recording id for history and retry. A direct PCM lane is allowed only as an optimization inside the Rust side, and only if it does not quietly remove the artifact write that makes retry, playback, deletion, and history work. The benchmark measured the local decode round trip at roughly 9 ms for a 120-second clip, so this is not the reason to make desktop CPAL-only.

## Recorder Boundary

The recorder boundary should be platform-specific, with a shared contract only where the product has a real invariant.

Keep:

```txt
start -> live session
session.stop -> stop result
session.cancel -> cancel result
session.subscribe -> recording state
enumerateDevices -> selectable microphones
```

Remove from the shared shape:

```txt
method: 'cpal' | 'navigator'
backend as a user-routable decision
nullable CpalRecorderServiceLive in web
Tauri imports of NavigatorRecorderServiceLive for manual recording
```

The shared contract should not hide artifact differences. It is fine for the Tauri `stop()` result to include a CPAL artifact and for the browser `stop()` result to include a `Blob`. The pipeline boundary should extract the recording id and keep everything downstream id-addressed.

## Transcription Boundary

Transcription provider selection stays runtime. The user really can switch from local Whisper.cpp to OpenAI to Groq without rebuilding. That switch belongs in `operations/transcribe.ts`.

Capture selection does not stay runtime. A Tauri bundle should not ask the user whether native desktop capture or browser page capture should own the microphone. The desktop product sentence already answers it.

The clean boundary is:

```txt
capture platform -> artifact
artifact -> recording id / history
recording id + provider setting -> transcription
```

For CPAL local dictation, keep the id-based lane as the product contract:

```txt
CPAL stop
  -> write RecordingArtifact(id)
  -> transcribeRecording(id)
  -> transcript
  -> persist transcript
```

A future direct lane can exist behind that contract:

```txt
CPAL stop
  -> samples already in Rust memory
  -> write RecordingArtifact(id)
  -> local model manager may consume samples directly
  -> transcript
```

That direct lane should be treated as a narrow local-inference optimization, not a new front-end `AudioArtifact` union. It requires either fusing stop and transcribe, which couples the recorder to the transcription engine, or adding a Rust-side sample cache keyed by recording id. The benchmark measured the saved decode prep at roughly 7 ms for a 120-second clip and below 1 ms for dictation-length clips. Defer it until a latency-sensitive local mode makes that ownership cost worth paying.

## Overlay Design

Desktop overlay should be native, but it should not make the recorder own phases outside recording. CPAL owns microphone telemetry and recorder state. Transcription owns model lifecycle. The front-end pipeline owns upload and delivery status.

CPAL should emit recording-owned events:

```txt
recorder:level
  recordingId
  rms
  peak
  clipped
  timestampMs

recorder:phase, successor to recorder:state-changed
  recordingId
  phase: idle | recording | stopping
```

Post-stop phases come from their real owners:

```txt
transcription://model-state
  loading | ready | inferring | error

pipeline/UI state
  uploading | delivering | done | failed
```

The overlay window composes those signals. Do not publish a broad `recorder:phase` enum that includes `transcribing` or `uploading`; that would turn the recorder into a fake workflow aggregator.

`commands.rs` already emits `recorder:state-changed` through `AppHandle.emit` (`apps/whispering/src-tauri/src/recorder/commands.rs:19`). Treat `recorder:phase` as a replacement for that channel, not a second source of truth. Migrate the existing consumers in the same wave: the CPAL listener in `index.tauri.ts`, the `WhisperingRecordingState` arktype, and tray icon mapping in `tauri.tauri.ts` / `recording-states.ts`.

If `stopping` exists, Rust must emit it before `write_artifact` in `stop_recording`. Otherwise remove `stopping` from the enum. Do not add a phase value that no path can publish.

Level telemetry is new hot-path work. Add it in the CPAL consumer worker, not inside the CPAL callback, and coalesce emissions to a UI cadence such as 30 to 60 Hz. Per-buffer `emit` would turn every audio buffer into JSON IPC to one or more webviews.

Stateful events need snapshots. Missing one level sample is fine; missing the current phase when an overlay webview mounts late is not. Mirror the existing transcription pattern: listen first, then read the current snapshot with a `get_recorder_phase` command. Events should carry a full phase snapshot, not a delta, so one missed event self-heals on the next transition. Define `RecorderLevel` and `RecorderPhase` payloads with `#[derive(specta::Type)]`, export them from `lib.rs` like `ModelStateEvent`, and consume them with typed `listen<RecorderLevel>(...)` calls.

The overlay itself should live behind a Tauri-only boundary, for example `overlayWindow.tauri.ts`, with a browser no-op if callers need a shared import. Follow the existing create-once, show-hide secondary-window lifecycle used by `transformClipboardWindow.tauri.ts`; keeping one overlay window alive also keeps listeners stable across recordings. The window needs an explicit Tauri v2 capability file for its label. Do not copy the transform clipboard capability wholesale. The overlay should be receive-only: `core:event:allow-listen` plus only the window permissions it uses, such as close, hide, and `core:window:allow-set-ignore-cursor-events` if click-through is enabled. Do not grant emit, clipboard, or notification permissions unless the implementation proves it needs them.

The first implementation target is a normal Tauri webview window with overlay-like options:

```txt
label: recording-overlay
decorations: false
transparent: true (the current Tauri config already enables macOS private API)
alwaysOnTop: true
skipTaskbar: true
focus: false
resizable: false
optional setIgnoreCursorEvents(true)
```

This is still not a guarantee of OS overlay behavior. macOS all-Spaces and above-fullscreen behavior may require NSPanel-like native work that Tauri's ordinary `WebviewWindow` API does not expose directly. Verify that before treating "native overlay" as done.

Web feedback should be page-local. Navigator may compute Web Audio levels in the page, but that is a page visualization, not the same reliability claim as CPAL telemetry. It can disappear on reload, background throttling, permissions changes, or browser capture failure. That is acceptable for web. It is not acceptable as the desktop overlay source of truth.

Do not share a fake `AudioTelemetryService` unless it owns a real invariant. The honest model is:

```txt
Desktop:
  CPAL worker loop
    -> Rust level calculation
    -> Tauri event
    -> overlay window and main window
  ModelManager
    -> transcription://model-state
    -> overlay window and main window
  pipeline
    -> upload/delivery UI state
    -> overlay window

Web:
  MediaStream
    -> optional Web Audio analyser
    -> app component state
```

## Deletion List

If Tauri desktop refuses Navigator for manual recording, these paths become unnecessary or need narrowing:

| Area | Delete or narrow | Current evidence |
| --- | --- | --- |
| Device config | Delete `recording.method`. No runtime migration is needed for the per-key setting: the orphaned localStorage entry is ignored after the definition disappears. Keep `recording.navigator.deviceId` for web and VAD. Keep `recording.navigator.bitrateKbps` for web manual only. | `apps/whispering/src/lib/state/device-config.svelte.ts:35` |
| Settings migration map | Remove the `recording.method -> recording.method` device-key migration entry. Do not recreate the deleted setting during legacy settings migration. | `apps/whispering/src/lib/migration/migrate-settings.ts:359` |
| Manual start routing | Delete `resolveServiceForStart()` and `buildStartParams()` branches over `recording.method`; each platform builds one params shape. | `apps/whispering/src/lib/state/manual-recorder.svelte.ts:62`, `apps/whispering/src/lib/state/manual-recorder.svelte.ts:74` |
| Manual device-id persistence | Replace `recording.${method}.deviceId` with a platform-fixed key: Tauri manual writes `recording.cpal.deviceId`, web manual writes `recording.navigator.deviceId`. | `apps/whispering/src/lib/operations/recording.ts:74` |
| Active bootstrap | Stop probing both Navigator and CPAL for manual recording in Tauri. Tauri probes CPAL only; web probes Navigator only. | `apps/whispering/src/lib/state/manual-recorder.svelte.ts:125` |
| Tauri recorder barrel | Stop exporting `NavigatorRecorderServiceLive` from `index.tauri.ts` for manual recording. | `apps/whispering/src/lib/services/recorder/index.tauri.ts:2` |
| Services aggregator | Stop importing `NavigatorRecorderServiceLive` directly from `./recorder/navigator`; import the platform recorder barrel instead. | `apps/whispering/src/lib/services/index.ts:7` |
| Shared recorder types | Remove `CpalRecordingParams | NavigatorRecordingParams` as a runtime union for manual recording. Use platform-resolved params or separate exported types. | `apps/whispering/src/lib/services/recorder/types.ts:206`, `apps/whispering/src/lib/services/recorder/types.ts:214`, `apps/whispering/src/lib/services/recorder/types.ts:262` |
| Recording settings UI | Delete the desktop "Recording Method" selector and CPAL vs Browser descriptions. Move the macOS Navigator shortcut warning to the VAD branch if VAD still uses browser capture on macOS. | `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:47`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:143`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:184` |
| Recording settings derived gates | Replace `isUsingNavigatorMethod` and route-local `getManualDeviceId(method)` / `setManualDeviceId(method)` helpers with platform and mode derived keys. Remove VAD copy that says it ignores the "CPAL/Browser API selection above" because that selector is gone. | `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:70`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:79`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:197`, `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:236` |
| Method-scoped device selectors | Remove method switching from manual device picker. Tauri shows CPAL devices; web shows Navigator devices. | `apps/whispering/src/lib/components/settings/selectors/ManualDeviceSelector.svelte:20` |
| Bitrate UI on desktop manual | Hide Navigator bitrate from Tauri manual recording. Keep it for web manual only. VAD emits WAV via `utils.encodeWAV` and ignores `recording.navigator.bitrateKbps`. | `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:287`, `apps/whispering/src/lib/state/vad-recorder.svelte.ts:154` |
| Sample-rate UI on web | Hide CPAL sample-rate controls from web. Keep them only in Tauri. | `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte:317` |
| Web local provider affordance | Hide local transcription providers from the web build and add a guard in `dispatchLocalTranscription` for web. Prefer a platform-resolved provider registry if the web bundle should not import local provider metadata at all. | `apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte:101`, `apps/whispering/src/lib/components/settings/TranscriptionServiceSelect.svelte:35`, `apps/whispering/src/lib/operations/transcribe.ts:216` |
| Recorder state events | Replace `recorder:state-changed` with typed recorder phase events, or explicitly keep the old channel and drop `recorder:phase`. If replacing, migrate CPAL listener, arktype recording state, and tray icon mapping in the same wave. | `apps/whispering/src-tauri/src/recorder/commands.rs:10`, `apps/whispering/src/lib/services/recorder/index.tauri.ts`, `apps/whispering/src/lib/constants/audio/recording-states.ts:6`, `apps/whispering/src/lib/tauri.tauri.ts:219` |
| Recording artifact metadata | Verify live consumers of `RecordingArtifact.durationMs` and `byteLength`. `byteLength` no longer represents upload size after cloud re-encoding. Keep only fields with named consumers. | `apps/whispering/src-tauri/src/recorder/artifact.rs:61`, `apps/whispering/src/lib/operations/transcribe.ts:63` |
| Artifact comments | Re-scope comments that mention navigator WebM as a future Tauri artifact producer. Multi-container decode remains earned by file upload and web/blob persistence, not desktop manual Navigator. | `apps/whispering/src-tauri/src/recorder/artifact.rs:34` |
| Docs | Update service README lines that describe Navigator as "browser + desktop fallback", the build-time DI spec section that preserves runtime recorder choice, and inline comments that explain CPAL nullability through `recording.method`. | `apps/whispering/src/lib/services/README.md:403`, `apps/whispering/specs/20260526T010258-build-time-platform-di.md:234`, `apps/whispering/src/lib/services/recorder/index.browser.ts:12` |
| Fallback checks | Delete CPAL null checks from Tauri manual paths. Keep build errors for impossible imports. | `apps/whispering/src/lib/state/manual-recorder.svelte.ts:63` |
| Audio artifact union ideas | Do not add a front-end `Pcm | WavFile | Blob` artifact union. Keep the id handle as the product boundary unless a separate follow-up proves direct PCM is worth it. | `apps/whispering/src-tauri/src/recorder/artifact.rs:61`, `apps/whispering/src/lib/operations/transcribe.ts:63` |

This does not delete Navigator. It deletes Navigator as a Tauri manual recording backend.

## Migration Waves

1. **Platform recorder export**
   Create a platform-resolved manual recorder export. Tauri exports CPAL only for manual recording. Browser exports Navigator only for manual recording. Update `services/index.ts` and `manual-recorder.svelte.ts` to import through that boundary.

2. **Settings cleanup**
   Remove `recording.method` from the manual recording UI, state routing, recorder param union, manual device persistence, and migration map in one atomic wave. Old per-key `recording.method` entries become ignored localStorage. Add a one-time notice or release-note callout for users who had selected desktop Browser API, because those are the users most likely to hit a CPAL device bug.

3. **Artifact boundary cleanup**
   Keep the existing id-based `RecordingArtifact` as the cross-boundary shape. Document that CPAL cloud upload already uses `encodeRecordingForUpload(recordingId)` to produce Opus/OGG. Defer direct PCM local handoff and progressive longform WAV until they have their own product trigger.

4. **Overlay and telemetry**
   Replace or explicitly retain the current `recorder:state-changed` channel. If replacing it, migrate the CPAL listener, recording state arktype, and tray mapping together. Add CPAL level events from the Rust worker loop, with throttled emission and typed payloads. Add a recorder phase snapshot command, regenerate Tauri bindings, add type pins in `commands.test-d.ts`, add a Tauri-only overlay window boundary, and add a minimal overlay capability file. Drive post-stop overlay state from transcription and pipeline owners, not from the recorder.

## Implementation Progress

**2026-05-29 slice**: Waves 1 and 2 landed as the first implementation slice.

- Platform recorder export now exposes `ManualRecorderLive`; Tauri resolves it to CPAL and web resolves it to Navigator.
- Manual recorder state imports only `ManualRecorderLive`, probes only the platform recorder for active sessions, and no longer builds or sends a `method` start parameter.
- `recording.method` was removed from device config, legacy settings migration, manual recorder routing, the settings page, and the compact manual device selector.
- Manual fallback device persistence now writes to the platform-fixed key: `recording.cpal.deviceId` on Tauri, `recording.navigator.deviceId` on web.
- VAD still uses browser-owned capture and keeps `recording.navigator.deviceId`; VAD copy no longer references the deleted CPAL versus Browser API selector.
- Browser manual recording keeps `recording.navigator.bitrateKbps`; desktop manual settings show CPAL sample rate instead.
- Web local transcription is hidden in both transcription selectors and guarded in `dispatchLocalTranscription`.

Deferred:

- Overlay and recorder level telemetry.
- Direct PCM local handoff.
- Progressive longform WAV.
- A front-end `AudioArtifact` union.

## Verification Plan

Run the checks per wave:

```txt
bun run typecheck
bun run build
```

Manual verification:

```txt
Tauri manual:
  settings has no CPAL vs Browser API selector
  device picker lists CPAL devices
  global shortcut starts CPAL recording while app is backgrounded
  stop creates a recording id and transcribes with local provider
  cloud provider uses encodeRecordingForUpload(recordingId) and uploads audio/ogg
  reload during active recording reattaches to CPAL session

Web manual:
  settings has no CPAL controls
  device picker lists Navigator devices
  stop persists MediaRecorder blob
  cloud and self-hosted remote transcription work
  local providers are not offered

Tauri VAD:
  keeps browser-owned VAD capture until there is a native VAD backend
  keeps its own navigator device selector
  does not show or use Navigator bitrate
  retains a macOS App Nap warning if global shortcuts can trigger VAD

Overlay:
  desktop overlay opens independently of main window focus
  mic levels update while recording
  recorder phase comes from recorder state
  transcription phase comes from transcription://model-state
  upload and delivery phase comes from pipeline/UI state
  overlay reads recorder phase snapshot on mount, then listens for changes
  web build has no OS overlay code in the bundle
```

Static checks:

```txt
rg "recording.method" apps/whispering/src
  expected after wave 2: zero matches in apps/whispering/src
rg "from './recorder/navigator'" apps/whispering/src/lib/services/index.ts
  expected after wave 1: zero matches
rg "navigatorRecorder" apps/whispering/src/lib/state/manual-recorder.svelte.ts
  expected after wave 1: zero matches
rg "CpalRecorderServiceLive: RecorderService | null" apps/whispering/src
rg "AudioArtifact" apps/whispering/src apps/whispering/src-tauri
```

The target is not zero `NavigatorRecorderServiceLive` references. The target is zero Tauri manual references.

## Honesty

What gets worse:

Desktop users lose the manual "Browser API" escape hatch. If CPAL has a device-specific bug, there is no in-app manual fallback. The right mitigation is better CPAL error handling, device diagnostics, and bug reports, not shipping two desktop capture stacks forever.

Desktop cloud recording loses MediaRecorder's free compressed blob. The replacement is already present in the current Tauri path: `loadForCloudUpload` calls `encodeRecordingForUpload(recordingId)` and uploads `audio/ogg`, falling back to the raw artifact only if compression fails.

The web product becomes more explicit: no local transcription providers. That may disappoint users who expect "local-first" to mean every platform. But without a WASM local inference plan, web local would be a promise the architecture cannot keep.

Desktop does not collapse to one capture stack yet. Manual recording becomes CPAL-only, but VAD remains browser-owned and keeps its own navigator device setting. That means desktop users may still choose a microphone twice: once for manual CPAL and once for VAD browser capture. This is the cost of keeping VAD on `@ricky0123/vad-web` until there is a native VAD backend.

Deferring progressive WAV keeps the recorder accumulating the full clip in RAM with no crash recovery during recording. That is acceptable at dictation lengths. The real trigger to build progressive WAV is in-flight durability plus bounded memory for long recordings, not a generic "longform mode" label.

If `encodeRecordingForUpload` fails, desktop cloud transcription falls back to uploading the uncompressed saved artifact. That can be larger than the MediaRecorder blob it replaces. The deletion is still right, but encode reliability and visible fallback logging are part of making the CPAL-only cloud path feel honest.

The overlay split creates two feedback implementations. That is correct. A native CPAL overlay and a page-local browser meter do not have the same reliability, permissions, or lifecycle. A shared abstraction would make the code look cleaner by hiding the difference the user actually feels. The native overlay itself is the riskiest part of this proposal; a standard always-on-top webview may not satisfy macOS all-Spaces or above-fullscreen expectations without platform-specific work.

Who loses behavior:

```txt
Desktop user who selected Browser API for manual cloud-only recording:
  loses that setting
  gains the existing CPAL path with Opus/OGG cloud upload preparation

Desktop user using Navigator to avoid a CPAL device bug:
  loses the workaround
  needs CPAL diagnostics or a bug fix

Web user wanting local transcription:
  still cannot use it
  now sees that as a product boundary, not an accidental missing feature

Desktop user using VAD:
  still uses browser-owned capture
  keeps separate VAD microphone settings from manual CPAL
  still needs browser-capture reliability warnings where they apply
```

What would make us revisit:

```txt
CPAL cannot reliably capture on a supported desktop class after targeted fixes.
Browser Navigator on desktop enables a user-visible capability CPAL cannot match.
Native VAD becomes real, which would let desktop delete browser capture more completely.
Web gets a real WASM local inference plan with model storage, worker isolation, and acceptable latency.
An OS overlay requires browser-owned capture data that CPAL cannot provide.
A published compatibility contract promises desktop Browser API recording.
```

No such contract exists today. Greenfield answer: delete the desktop choice.
