# Tauri Specta on the Artifact-Id Base

**Date**: 2026-05-26
**Status**: Draft
**Owner**: Braden
**Supersedes**: `specs/20260526T180000-tauri-specta-boundary-adapter.md` (the v1 boundary-adapter spec was written against the pre-collapse recorder; the inventory and the size of the hand-rolled section both change once the artifact-id refactor is in place)
**Builds on**: `apps/whispering/specs/2026-05-26-recorder-shape-investigation/REPORT.md` and the four commits on `bench/recorder-shapes-investigation` that collapsed the cpal handoff to a durable Rust-owned WAV artifact addressed by id.

## One Sentence

A single handwritten module `src/lib/tauri/commands.ts` is the only place that imports `tauri-specta`'s generated bindings; it exposes every app command to services as a Wellcrafted `Result<T, E>` (for fallible commands) or plain `Promise<T>` (for infallible ones), with exactly one hand-rolled wrapper for the only remaining raw-byte command (`encode_recording_for_upload`).

## Why a v2

The v1 spec captured the right boundary-adapter design but was written against a command surface that has since been simplified. The artifact-id refactor (already landed on `bench/recorder-shapes-investigation`) changed three things that matter to v1:

1. **`transcribe_audio` (raw IPC body in) is gone.** Replaced by `transcribe_recording(recording_id, config)` with JSON-shaped args. Specta can auto-generate this. v1 had it in the hand-rolled list; it moves to the auto-derived list.
2. **`encode_upload_audio` (raw IPC body in) is gone.** Replaced by `encode_recording_for_upload(recording_id)`. Args are JSON-shaped. The return is still raw bytes for the opus payload, so this command stays hand-rolled, but only its **return** is raw, not the input.
3. **`stop_recording` returns `RecordingArtifact`** (a small `{ id, durationMs, byteLength, mimeType }` handle), not `AudioRecording`.

Net result: the hand-rolled section of the boundary file shrinks from two functions to one. The remaining hand-rolled function only handles the raw-bytes return, not a raw-bytes argument.

## How to read this spec

```txt
Read first:
  One Sentence
  Combined Inventory
  Architecture
  Wave Plan

Read if changing the design:
  Design Decisions
  The Boundary Adapter (code)
  Edge Cases

Read if exploring rationale:
  20260526T180000-tauri-specta-boundary-adapter.md  (the v1 this supersedes)
  apps/whispering/specs/2026-05-26-recorder-shape-investigation/REPORT.md  (the artifact-id rationale)
```

## Combined Inventory

| Command | Args | Rust return | Generated TS shape | Auto or hand-rolled |
|---|---|---|---|---|
| `write_text` | `text: String` | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `simulate_enter_keystroke` | () | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `enumerate_recording_devices` | () | `Result<Vec<String>, String>` | `Promise<Result<string[], string>>` | auto |
| `init_recording_session` | `deviceIdentifier, recordingId, sampleRate?` | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `start_recording` | () | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `stop_recording` | () | `Result<RecordingArtifact, String>` | `Promise<Result<RecordingArtifact, string>>` | auto |
| `cancel_recording` | () | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `close_recording_session` | () | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `get_current_recording_id` | () | `Result<Option<String>, String>` | `Promise<Result<string \| null, string>>` | auto |
| `delete_recording` | `recordingId: String` | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `transcribe_recording` | `recordingId: String, config: TranscribeRequest` | `Result<String, TranscriptionError>` | `Promise<Result<string, TranscriptionError>>` | auto (was raw-body in v1) |
| `encode_recording_for_upload` | `recordingId: String` | raw `Response` (opus bytes) | `Promise<Result<ArrayBuffer, string>>` | **hand-rolled** |
| `set_unload_policy` | `policy: String` | `()` | `Promise<void>` | auto, passthrough |
| `execute_command` | `command: String` | `Result<CommandOutput, String>` | `Promise<Result<CommandOutput, string>>` | auto |
| `spawn_command` | `command: String` | `Result<u32, String>` | `Promise<Result<number, string>>` | auto |
| `write_markdown_files` | `directory, files` | `Result<(), String>` | `Promise<Result<void, string>>` | auto |
| `delete_files_in_directory` | `directory, filenames` | `Result<u32, String>` | `Promise<Result<number, string>>` | auto |
| `read_markdown_files` | `directoryPath` | `Result<Vec<String>, String>` | dead, remove in Wave 7 |: |
| `count_markdown_files` | `directoryPath` | `Result<usize, String>` | dead, remove in Wave 7 |: |
| `send_sigint` | `pid` | `SignalResult` | dead, remove in Wave 7 |: |

20 commands total. 16 auto-derived. 1 hand-rolled (`encode_recording_for_upload`). 3 dead and removed in cleanup wave.

Types crossing the boundary that need `#[derive(specta::Type)]`:
- `RecordingArtifact` (recorder/artifact.rs)
- `TranscriptionError` (transcription/error.rs): already done on e628
- `TranscribeRequest` (transcription/mod.rs): currently a private enum behind `serde_json::Value`; promote to a `pub` typed argument
- `CommandOutput` (command.rs)
- `MarkdownFile` (markdown.rs)

## The Hand-Rolled Command: encode_recording_for_upload

Why it stays hand-rolled: it returns a raw opus payload via `tauri::ipc::Response::new(bytes)` for performance (avoids JSON-array-of-bytes serialization which would 3-4x the wire size and add tens of ms of parse on long clips). Specta cannot introspect `Response`. The hand-rolled wrapper is ~10 lines.

Why the alternative was rejected: returning `Vec<u8>` plain would let specta generate the binding (mapping to `Uint8Array`), but the underlying IPC then ships it as a JSON array of numbers. Measured cost: ~30-100 ms extra parse on 120 s clips, plus 3-4x wire bytes. Cloud upload latency is already user-visible; stacking parse on top is a real regression.

Why this is the local optimum: there are zero raw-bytes **input** commands left (the artifact-id refactor killed `transcribe_audio` and `encode_upload_pcm`). The one remaining raw-bytes **output** command earns its hand-roll the same way it did in v1.

Path to zero hand-rolled commands: out of scope. The future move is `transcribe_cloud(id, config) -> String` doing HTTP upload in Rust so JS never holds the opus bytes. That is a separate multi-week project, motivated by product need, not by spec purity.

## Architecture

### File layout

```txt
apps/whispering
  src-tauri/src/
    lib.rs                 ← make_specta_builder; specta_builder.invoke_handler() replaces generate_handler!
    audio/command.rs       ← #[specta::specta] on encode_recording_for_upload
    command.rs             ← #[specta::specta] on execute_command, spawn_command
    graceful_shutdown.rs   ← #[specta::specta] on send_sigint (removed in Wave 7)
    markdown.rs            ← #[specta::specta] on the four markdown commands
    recorder/artifact.rs   ← #[derive(specta::Type)] on RecordingArtifact
    recorder/commands.rs   ← #[specta::specta] on each recorder command
    transcription/error.rs ← #[derive(specta::Type)] on TranscriptionError
    transcription/mod.rs   ← #[specta::specta] on transcribe_recording, set_unload_policy
                             promote TranscribeRequest to pub + derive Type
                             drop serde_json::Value arg in favour of typed enum

  src/lib/tauri/
    bindings.gen.ts        ← generated, committed, imported only by commands.ts
    commands.ts            ← boundary; only file outside bindings.gen that touches @tauri-apps/api/core
```

### Flow

```txt
Rust command (#[tauri::command] + #[specta::specta])
        |
        +--- runtime  ---> specta_builder.invoke_handler()
        |
        +--- codegen  ---> cargo test export_types
                                |
                                v
                          src/lib/tauri/bindings.gen.ts
                                |
                                v
                          src/lib/tauri/commands.ts
                                |
                                v
                          services / +layout.svelte / materializers
```

## The Boundary Adapter (`src/lib/tauri/commands.ts`)

```ts
import { invoke as rawInvoke } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { commands as gen, type TranscriptionError } from './bindings.gen';

// Mirrors the runtime shape tauri-specta emits for Result-bearing commands.
type SpectaResult<T, E> =
  | { status: 'ok'; data: T }
  | { status: 'error'; error: E };

const toResult = <T, E>(r: SpectaResult<T, E>): Result<T, E> =>
  r.status === 'ok' ? Ok(r.data) : Err(r.error);

const isSpectaResult = (v: unknown): v is SpectaResult<unknown, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  'status' in v &&
  (v.status === 'ok' || v.status === 'error');

// Type-level: Result-bearing commands get unwrapped to Wellcrafted Result.
// Infallible commands pass through unchanged.
type Wrap<F> = F extends (...args: infer A) => Promise<SpectaResult<infer T, infer E>>
  ? (...args: A) => Promise<Result<T, E>>
  : F;

type WrapAll<C> = { readonly [K in keyof C]: Wrap<C[K]> };

function wrapCommand<F extends (...args: never[]) => Promise<unknown>>(fn: F): Wrap<F> {
  const wrapped = async (...args: Parameters<F>) => {
    const result = await fn(...args);
    return isSpectaResult(result) ? toResult(result) : result;
  };
  return wrapped as Wrap<F>;
}

// Only wrap function-typed exports. tauri-specta's generated module is
// expected to be all functions today; the guard future-proofs against the
// generator adding a constant or version export.
const wrappedGen = Object.fromEntries(
  Object.entries(gen)
    .filter(([, v]) => typeof v === 'function')
    .map(([k, v]) => [
      k,
      wrapCommand(v as (...args: never[]) => Promise<unknown>),
    ]),
) as WrapAll<typeof gen>;

// Hand-rolled: the only command whose return type cannot be expressed in specta.
// Rust returns tauri::ipc::Response::new(opus_bytes) so the IPC body carries the
// raw bytes (no JSON-array-of-numbers detour). We surface the ArrayBuffer as the
// success value of a Wellcrafted Result for consumer symmetry with the
// auto-wrapped commands.
async function encodeRecordingForUpload(
  recordingId: string,
): Promise<Result<ArrayBuffer, string>> {
  try {
    return Ok(
      await rawInvoke<ArrayBuffer>('encode_recording_for_upload', { recordingId }),
    );
  } catch (e) {
    return Err(String(e));
  }
}

export const commands = {
  ...wrappedGen,
  encodeRecordingForUpload,
};

export type {
  RecordingArtifact,
  TranscriptionError,
  TranscribeRequest,
  CommandOutput,
  MarkdownFile,
} from './bindings.gen';
```

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Boundary adapter shape | 2 coherence | Single file `src/lib/tauri/commands.ts`, type-derived auto-adapter, hand-rolled escape hatch | Inherits from v1; the design is still right |
| Hand-roll count | 1 evidence | One (`encode_recording_for_upload`) | Artifact-id refactor removed the input-side raw-body commands |
| Hand-roll: bytes-out strategy | 1 evidence | Keep raw `Response`, hand-roll wrapper | Vec<u8> via specta is 3-4x wire + parse; measured at the bench |
| `TranscribeRequest` arg typing | 2 coherence | Promote to `pub`, derive `Type`, replace `serde_json::Value` in the command signature | Specta cannot introspect through `Value`; promoting the enum gives the TS side discriminated-union typing |
| Result mode | 1 evidence | `ErrorHandlingMode::Result` | Same as v1 |
| Discriminator | 2 coherence | `error !== null` (Wellcrafted) at the consumer; `status === 'ok'` only inside the adapter | Same as v1 |
| Wave ordering | 2 coherence | Build then Prove then Remove, with Wave 0 = artifact-id refactor (done) | Each wave leaves the tree green; the prerequisite is already in place |
| Generated header | 2 coherence | No `// @ts-nocheck` | Same as v1; fix generator output if it produces invalid TS |
| Rust error types | Deferred | `String` stays for everything except `TranscriptionError` | One concern per PR; typed errors per command land later as consumers earn them |
| Dead commands | Deferred | Remove `read_markdown_files`, `count_markdown_files`, `send_sigint` in Wave 7 | Same as v1 |
| Branch home | 1 evidence | Continue on `bench/recorder-shapes-investigation` (rename to a fit name on push) | Artifact-id work is already committed there; the specta wiring layers on top cleanly |

## Wave Plan

### Wave 0 (Prerequisite, DONE on `bench/recorder-shapes-investigation`)

Durable Rust-owned `RecordingArtifact`, id-addressed commands, `Float32Array | Blob` recorder union collapsed. Four commits on the branch. Bench and report at `apps/whispering/specs/2026-05-26-recorder-shape-investigation/REPORT.md`.

### Wave 1 (Build): Rust specta wiring, no behaviour change

- [ ] **1.1** Add `specta = "=2.0.0-rc.25"`, `specta-typescript = "=0.0.12"`, `tauri-specta = { version = "=2.0.0-rc.25", features = ["derive", "typescript"] }` to `apps/whispering/src-tauri/Cargo.toml`.
- [ ] **1.2** Add `#[specta::specta]` to every `#[tauri::command]` in the post-collapse command set (see Architecture for files).
- [ ] **1.3** Derive `specta::Type` on `RecordingArtifact`, `TranscriptionError`, `CommandOutput`, `MarkdownFile`. Keep all existing `Serialize`/`Deserialize` attributes. If specta refuses `mime_type: &'static str` on `RecordingArtifact` (uncertain; v1 spec says it should work but the wire value is currently a literal `"audio/wav"`), switch the field to `String` and pay one short allocation per artifact write; the JS side is unchanged.
- [ ] **1.4** Promote `TranscribeRequest` to `pub`, add `#[derive(Deserialize, specta::Type)]` while keeping the existing `#[serde(tag = "engine", rename_all = "lowercase")]` attributes. Replace the `config: serde_json::Value` arg in `transcribe_recording` with `config: TranscribeRequest` and drop the `serde_json::from_value` call. Verify the generated TS shows the engine-tagged discriminated union; if specta does not honour `#[serde(tag = ...)]` (it should, per its serde compat layer), fall back to a flat struct with an `engine: TranscribeEngine` enum field.
- [ ] **1.5** Add `fn make_specta_builder<R: tauri::Runtime>() -> tauri_specta::Builder<R>` in `lib.rs` collecting every annotated command via `collect_commands![...]`, configured with `ErrorHandlingMode::Result`.
- [ ] **1.6** Add `cargo test export_types` in `lib.rs`'s `#[cfg(test)] mod export_bindings` that writes `../src/lib/tauri/bindings.gen.ts`.
- [ ] **1.7** Add `"bindings:tauri": "cargo test --manifest-path src-tauri/Cargo.toml export_types"` to `apps/whispering/package.json`.
- [ ] **1.8** Run `bun run --cwd apps/whispering bindings:tauri`. Commit `bindings.gen.ts`.
- [ ] **1.9** `bun run --cwd apps/whispering typecheck` passes; the committed bindings file is currently unused.

### Wave 2 (Build): Handler swap and boundary module

- [ ] **2.1** Replace `tauri::generate_handler![...]` in `lib.rs` with `make_specta_builder().invoke_handler()`. Keep the legacy non-app handlers as needed.
- [ ] **2.2** Smoke-run the Tauri app (`bun run --cwd apps/whispering dev:local`). Verify boot and that every existing call site still works through raw `invoke()`.
- [ ] **2.3** Add `src/lib/tauri/commands.ts` per The Boundary Adapter section.
- [ ] **2.4** Type tests (inline `expectTypeOf` or `.test-d.ts`) asserting:
  - `commands.stopRecording` returns `Promise<Result<RecordingArtifact, string>>`
  - `commands.setUnloadPolicy` returns `Promise<void>` (not wrapped)
  - `commands.transcribeRecording` returns `Promise<Result<string, TranscriptionError>>`
  - `commands.encodeRecordingForUpload` returns `Promise<Result<ArrayBuffer, string>>`

### Wave 3 (Build): Pilot migration

- [x] **3.1** Migrate `tauri.tauri.ts:command.execute` to `commands.executeCommand`. One call site, one obvious smoke test.
- [ ] **3.2** Hit the path in-app (ffmpeg version check or equivalent).
- [ ] **3.3** If the migration looks wrong (positional args feel awkward, error mapping clunky), pause and revisit the adapter before bulk migration.

### Wave 4 (Build): Bulk migrate JSON-arg consumers

- [ ] **4.1** `tauri.tauri.ts:text.writeText` → `commands.writeText` / `commands.simulateEnterKeystroke`.
- [ ] **4.2** `src/lib/services/recorder/cpal.tauri.ts` → migrate every recorder command (init, start, stop, cancel, close, getCurrent, delete). Delete the local `invoke<T>()` wrapper at the bottom of the file. Drop `RecorderError.InvokeFailed` from `types.ts` if no remaining caller.
- [ ] **4.3** `src/lib/services/blob-store/file-system.tauri.ts:deleteFilesInDirectory` → `commands.deleteFilesInDirectory`.
- [ ] **4.4** `src/lib/services/recording-materializer.ts` → `commands.writeMarkdownFiles`, `commands.deleteFilesInDirectory`.
- [ ] **4.5** `+layout.svelte` unload-policy effect → `commands.setUnloadPolicy(policy)` (passthrough, no Result destructure).
- [ ] **4.6** `src/lib/services/transcription/local/local-transcription.ts:transcribeRecording` → call `commands.transcribeRecording(id, config)`. The current `tryAsync` wrapper + arktype-based error parse goes away because the error is now typed at the boundary. Simplify `mapLocalTranscriptionError` to switch on `error.name` directly.

### Wave 5 (Build): Migrate the hand-rolled command

- [x] **5.1** Delete the upload-encoding namespace and inline at its sole call site in `src/lib/operations/transcribe.ts:loadForCloudUpload`, which imports `commands.encodeRecordingForUpload` directly.

### Wave 6 (Prove): Verification

- [ ] **6.1** `bun run --cwd apps/whispering typecheck` passes.
- [ ] **6.2** App boots; recorder enumerates and records a 3 s clip; local transcription completes on a model engine.
- [ ] **6.3** Cloud transcription completes against at least one provider (OpenAI or Groq) with the new `encodeRecordingForUpload` boundary.
- [ ] **6.4** Recording delete and history retry work.
- [ ] **6.5** `set_unload_policy` propagates from the layout effect.
- [ ] **6.6** Bench test still builds and runs (`cargo test --release --test bench_recorder_shapes`).

### Wave 7 (Remove): Cleanup and guardrails

- [ ] **7.1** Grep: no `from '@tauri-apps/api/core'` imports outside `src/lib/tauri/commands.ts`, excluding Tauri plugin APIs (fs, shell, autostart, global-shortcut, clipboard, dialog, notification, log, opener, process, http).
- [ ] **7.2** CI step: `bun run bindings:tauri && git diff --exit-code apps/whispering/src/lib/tauri/bindings.gen.ts`.
- [ ] **7.3** Remove dead Rust commands (`read_markdown_files`, `count_markdown_files`, `send_sigint`) from their files and from `collect_commands!`. Regenerate bindings.
- [ ] **7.4** Note in `apps/whispering/AGENTS.md`: new app commands require `#[tauri::command] + #[specta::specta]`, regenerate via `bun run bindings:tauri`, consume via `$lib/tauri/commands`.
- [ ] **7.5** Drop `RecorderError.InvokeFailed` if Wave 4 left no consumers.

## Edge Cases

### Positional vs named args

`tauri-specta`'s default generator emits positional args (`executeCommand(cmd: string)`), not a named object. The wire still uses the named object internally; specta packs args by parameter name. Verify each multi-arg call carefully. Highest risk: `init_recording_session` (3 args after `deviceIdentifier, recordingId, sampleRate?`).

### `tauri::State<'_, _>`, `AppHandle`, `Request<'_>` invisible to specta

The recorder commands take `State<'_, Mutex<Recorder>>` and `AppHandle`. Specta correctly omits these. Same for any `Request<'_>` arg. After Wave 0, no command uses `Request<'_>` for an arg (only for the return on `encode_recording_for_upload`).

### Async vs sync commands

`set_unload_policy` is a synchronous `fn` returning `()`. The generated TS still returns `Promise<void>` because IPC is async. Document in the Wave 4 migration of that effect.

### Error shape for `encode_recording_for_upload`

The hand-rolled wrapper does `catch (e) { return Err(String(e)); }`. Rust returns `Result<Response, String>`. On error, Tauri rejects with the error string. The boundary converts it. Verify with an intentional `Err` (e.g. invalid recording id).

### `RecordingArtifact.mimeType` is currently always `'audio/wav'`

The Rust struct uses `&'static str`. Specta will surface this as TS `string`. The field is forward-compat: when navigator-in-Tauri unifies through Rust (future PR), other producers may emit different mimes.

### `Result<Option<String>, String>` for `get_current_recording_id`

Becomes `Result<string | null, string>` in TS. Wellcrafted's `error !== null` discriminator correctly distinguishes `Ok(null)` from `Err`.

### Tauri rejections vs app errors

With `ErrorHandlingMode::Result`, Rust `Err(...)` returns through the data channel. Tauri itself can still reject the promise for infrastructure reasons (panic, deserialize failure, app handle gone). The auto-adapter does not catch these. They propagate as thrown exceptions. Consumers using `commands.*` should not need to wrap in `try/catch`; infrastructure failures should surface in the panic/crash log, not get swallowed into a string. Revisit if observed behaviour contradicts.

## Open Questions

1. **Should the boundary file be `commands.ts` (co-located) or `index.ts` (folder index)?**
   - Recommendation: `commands.ts`. Pairs naturally with `bindings.gen.ts`. Importers write `import { commands } from '$lib/tauri/commands'`. Matches v1.

2. **What happens to `src/lib/tauri.tauri.ts`?**
   - It still owns Tauri-only capability namespaces (fs, permissions, window, tray, globalShortcuts, autostart) that are not `#[tauri::command]` functions. Those stay. The `audioEncoder` namespace is gone; upload encoding uses `commands.encodeRecordingForUpload`.

3. **Upstream `ErrorHandlingMode::DataError`** (request drafted at `specs/tauri-specta-data-error-mode-request.md`).
   - Independent of this spec. If it lands upstream, the adapter file shrinks to just the hand-rolled `encodeRecordingForUpload`. Worth tracking; not a blocker.

4. **Branch and PR organisation.**
   - The artifact-id refactor (`bench/recorder-shapes-investigation`) is unmerged. The specta wiring (`braden-w/audio-encoder-opus` on `e628`) is unmerged. Recommendation: continue on `bench/recorder-shapes-investigation`, layer the specta wiring on top as Waves 1-7 of this spec, then open one PR for the combined direction. The e628 specta work has not committed bindings.gen.ts yet; nothing is lost by re-doing the decorations on top of the artifact-collapsed command set.

## Success Criteria

- [ ] `bindings.gen.ts` is committed; regeneration is reproducible; CI fails on drift.
- [ ] Every app-owned command is callable through `commands.*` with the matching shape from the inventory table.
- [ ] Zero `from '@tauri-apps/api/core'` imports outside `src/lib/tauri/commands.ts` (Tauri plugin APIs excepted).
- [ ] `bun run --cwd apps/whispering typecheck` passes.
- [ ] Manual smoke (Wave 6) passes on macOS: record, transcribe local, transcribe cloud, delete, retry.
- [ ] Dead Rust commands removed.
- [ ] `apps/whispering/AGENTS.md` documents the command-authoring rule.

## References

- `specs/20260526T180000-tauri-specta-boundary-adapter.md`: v1 of this spec.
- `specs/20260513T105808-tauri-specta-bindings.md`: earlier planning draft.
- `specs/tauri-specta-data-error-mode-request.md`: upstream feature request.
- `apps/whispering/specs/2026-05-26-recorder-shape-investigation/REPORT.md`: the artifact-id rationale.
- `apps/whispering/src-tauri/src/recorder/artifact.rs`: `RecordingArtifact` definition.
- `apps/whispering/src-tauri/src/recorder/commands.rs`: the post-collapse recorder command set.
- `apps/whispering/src-tauri/src/transcription/mod.rs`: `transcribe_recording`, `TranscribeRequest`.
- `apps/whispering/src-tauri/src/audio/command.rs`: the lone hand-rolled `encode_recording_for_upload`.
- `apps/whispering/src/lib/tauri.tauri.ts`: the Tauri-only capability namespace.
- `apps/whispering/src/lib/services/recorder/cpal.tauri.ts`: the local `invoke<T>()` wrapper that gets deleted in Wave 4.
