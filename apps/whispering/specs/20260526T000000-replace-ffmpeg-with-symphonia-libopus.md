# Replace FFmpeg with Symphonia + libopus

**Date**: 2026-05-26
**Status**: Wave 1 merged (PR #1826). Waves 2-4 in PR #1828 (encoder, unconditional compression, FFmpeg sidecar removal).
**Owner**: Braden
**Branch**: TBD (separate from `braden-w/ffmpeg-stdin-input`)

## One Sentence

Collapse the 3-tier `audio_data → samples` conversion into a single in-process Rust pipeline using Symphonia + libopus, deleting the external FFmpeg dependency, and add an Opus encoder so cpal-recorded WAV can be compressed before cloud upload.

## How to read this spec

```txt
Read first:
  One Sentence
  Permutation Matrix
  Target Shape
  Implementation Plan

Read if changing the architecture:
  Research Findings
  Design Decisions
  Module Layout
  Open Questions

Historical only:
  Prior perf commit (95d08439c) notes in References
```

## Overview

Whispering today shells out to a user-installed FFmpeg binary for any audio it can't decode in pure Rust (Tier 3 of `convert_audio_to_pcm16k_mono`). This spec replaces that with `symphonia` (container demux + non-Opus decode) and `audiopus` (libopus FFI for Opus encode + decode), plus `ogg` for muxing on the upload path. Net: ~1 MB binary growth, ~30 MB of external-install pain deleted, one canonical decode path instead of three tiers, and a new compression option for cloud upload.

## Motivation

### Current state

`apps/whispering/src-tauri/src/transcription/audio.rs` implements a 3-tier strategy:

```rust
fn convert_audio_to_pcm16k_mono(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    if is_valid_wav_format(&audio_data) { return Ok(audio_data); }       // Tier 1
    match convert_audio_rust(audio_data.clone()) {                       // Tier 2 (WAV-only via hound+rubato)
        Ok(converted) => return Ok(converted),
        Err(_) => { /* fall through */ }
    }
    convert_audio_with_ffmpeg(audio_data)                                // Tier 3 (sidecar binary)
}
```

Tier 3 (`convert_audio_with_ffmpeg`) requires the user to have `ffmpeg` on `PATH`. If missing, the app surfaces `TranscriptionError::FfmpegNotFoundError` with install instructions.

A separate concern: `recorder.rs` (cpal) writes uncompressed WAV. On cloud transcription paths the user uploads ~960 KB/min of audio data, which is wasteful given that Opus would compress voice ~20× with no perceptible quality loss for Whisper.

### Problems

1. **External-binary dependency.** Users hit `FfmpegNotFoundError` and have to leave the app, install FFmpeg, restart. Many never figure it out.
2. **Three implementations of one operation.** Tier 2 and Tier 3 both produce the same "16 kHz mono i16 WAV"; they coexist only because Tier 2 can't handle compressed formats. One unified decoder removes the dispatch and the dead-branch fallback.
3. **Upload bandwidth.** cpal-recorded WAV is uncompressed. A 5-min recording uploaded to OpenAI Whisper is ~5 MB instead of ~250 KB.
4. **Cross-platform install instructions are second-class.** The "install FFmpeg" docs differ per OS and rot. Removing the dependency removes the docs.

### Desired state

```rust
// Single canonical decode for any container we'll ever see.
pub fn decode_to_pcm16k_mono(bytes: &[u8]) -> Result<Vec<f32>, AudioError>;

// New: compress for cloud upload. Tauri-only; web uses MediaRecorder's
// already-compressed output.
pub fn encode_wav_to_opus_ogg(wav_bytes: &[u8], bitrate_bps: u32) -> Result<Vec<u8>, AudioError>;
```

Zero references to FFmpeg in `src-tauri/`. Zero references to `FfmpegNotFoundError`. The 3-tier function and `convert_audio_rust` both deleted.

## Permutation Matrix

The full space of capture × upload × inference paths, with what each cell actually needs from the audio module:

```txt
                         Inference engine
                         ┌─────────────────────────┬─────────────────────────────────┐
                         │ local (Tauri only)      │ cloud                           │
┌────────────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Tauri  + cpal record   │ HOT PATH                │ HOT-ish PATH                    │
│                        │ WAV at 16k mono         │ WAV → Opus/OGG → upload         │
│                        │ → samples (trivial)     │ (Opus encode wanted, 20× win)   │
│                        │ no decode, no encode    │ encoder needed                  │
├────────────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Tauri  + nav record    │ COLD                    │ COLD                            │
│  (user opted in)       │ WebM/Opus → decode      │ upload as-is                    │
│                        │ Symphonia+libopus       │ no decode, no encode            │
├────────────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Tauri  + file upload   │ COLD                    │ COLD                            │
│                        │ MP3/M4A/etc → decode    │ upload as-is                    │
│                        │ Symphonia(+libopus      │ no decode, no encode            │
│                        │  if container is Opus)  │                                 │
├────────────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Web    + nav record    │ N/A (no Rust on web)    │ HOT PATH (web)                  │
│                        │                         │ WebM/Opus upload as-is          │
│                        │                         │ no Rust involvement             │
├────────────────────────┼─────────────────────────┼─────────────────────────────────┤
│ Web    + file upload   │ N/A                     │ HOT-ish (web)                   │
│                        │                         │ upload as-is                    │
│                        │                         │ (file extension is multipart    │
│                        │                         │  content-type)                  │
└────────────────────────┴─────────────────────────┴─────────────────────────────────┘
```

**Read this table this way:** the new Rust audio module's decoder fires for any cell that crosses "decode": that's three Tauri cells. The encoder fires for one Tauri cell (cpal → cloud). Web never touches Rust audio code.

The cpal default + local default mean the most-common cell is `Tauri + cpal + local`, which needs neither decoder nor encoder. The new code earns its keep on the secondary cells, not on the hot path. That's fine. The deletion of FFmpeg is the win, not throughput.

## Research findings

### Symphonia (pure Rust, `#![forbid(unsafe_code)]`)

| Codec | Symphonia | Notes |
| --- | --- | --- |
| WAV / PCM | ✅ default | |
| FLAC | ✅ default | |
| MP3 | ⚠️ feature `mp3` | |
| AAC-LC | ⚠️ feature `aac` | |
| Vorbis | ✅ default | |
| ALAC | ⚠️ feature `alac` | low priority for us |
| **Opus** | ❌ "in development" | **the gap libopus fills** |

| Container | Symphonia | Notes |
| --- | --- | --- |
| WAV (RIFF) | ✅ default | |
| OGG | ✅ default | |
| WebM (MKV) | ✅ default | |
| ISO MP4 | ⚠️ feature `isomp4` | |
| AIFF / CAF | optional | low priority |

Key finding (verified via DeepWiki on `pdeljanov/Symphonia`): `FormatReader::next_packet()` returns raw codec packets. For Opus tracks inside WebM or OGG, the Opus identification header lands in `track.codec_params.extra_data`. **This means we can use Symphonia as a pure demuxer and hand the packets to libopus.** Symphonia's own incomplete Opus decoder is bypassed.

### libopus (via `audiopus` crate)

- Encode + decode for Opus only.
- Vendors libopus C source (~300 KB compiled per platform), built via `cc` crate. No cmake or autoconf required at build time.
- Mozilla / WebRTC / Signal / Discord / Zoom all ship it. Cross-platform safety is a solved problem.

### ogg crate (pure Rust)

- Tiny (~30-50 KB). Reads and writes OGG containers.
- We only need the writer side, to wrap libopus-encoded packets into an OGG file uploadable to Whisper/Deepgram/etc.

### Cloud Whisper accepted formats

Per OpenAI's transcriptions API: `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`. `.ogg` containing Opus is accepted (this is what `opusenc` produces). Some providers also accept `.opus` directly.

### Comparison: how other Tauri voice apps handle this

| App | Capture | Decode | Encode for upload |
| --- | --- | --- | --- |
| **Handy** (cpais) | cpal only (Tauri-only, no web) | none: captured PCM goes direct to local Whisper | n/a (no cloud path) |
| **Whispering today** | cpal default + navigator opt-in | Tier 1/2/3 (hound + rubato → FFmpeg sidecar) | none (uploads uncompressed WAV) |
| **Whispering target (this spec)** | cpal + navigator (unchanged) | Symphonia + libopus + rubato | libopus + ogg |

Handy's architecture is the inspiration for cpal-default capture, but Handy refuses the file-upload + cloud-engine permutations entirely. Whispering keeps those, which is why we need decode/encode where Handy doesn't.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Decoder library | 1 evidence | `symphonia` for demux + non-Opus codecs, `audiopus` for Opus | Verified Symphonia exposes pure-demux API with Opus packets in `extra_data`; libopus is the world's reference Opus implementation |
| Opus FFI wrapper | 3 taste | `audiopus` over `opus` | `audiopus_sys` builds vendored libopus with `cc` only (no cmake); easier cross-platform Tauri build |
| Encoder container | 3 taste | OGG (via `ogg` crate) | Smaller than WebM muxer; accepted by every Whisper-compatible API |
| Keep Tier 1 WAV fast-path | 2 coherence | **Delete it** | Symphonia is fast enough for WAV; one fewer code path |
| Keep `convert_audio_rust` (Tier 2) | 2 coherence | **Delete it** | Symphonia handles WAV natively; hound + rubato dance is replaced |
| Where the new module lives | 3 taste | New `src-tauri/src/audio/{decode,encode}.rs`; old `transcription/audio.rs` deleted | `transcription/` is engine-specific; decode/encode are app-wide concerns |
| Resampler | 1 evidence | Keep `rubato` (already in deps) | Symphonia gives us the codec's native sample rate; rubato resamples to 16k |
| Opus encoder bitrate | 3 taste | 24 kbps VBR default, configurable | Opus quality at 24 kbps is transparent for speech and matches WebRTC voice defaults |
| TS-side encode option | Deferred | Tauri command `invoke('encode_upload_audio', ...)` exposed to TS, behind a setting | Web build can't use the Rust encoder; web continues to upload MediaRecorder output as-is |
| Refuse navigator backend on Tauri | Deferred | Leave it as opt-in setting | Out of scope; see Open Questions |
| Symphonia features enabled | 1 evidence | `["mp3", "aac", "isomp4"]` on top of defaults | Covers MediaRecorder Safari output (MP4/AAC) + the common file-upload formats |

## Architecture

### Target module layout

```txt
apps/whispering/src-tauri/src/
├── audio/                          NEW module
│   ├── mod.rs                      pub use decode::*, encode::*, errors
│   ├── decode.rs                   bytes → Vec<f32> @ 16k mono
│   ├── encode.rs                   Vec<f32> @ 16k mono → Opus/OGG bytes
│   └── error.rs                    AudioError (decode/encode failure modes)
├── recorder/
│   └── recorder.rs                 unchanged (cpal)
├── transcription/
│   ├── mod.rs                      calls audio::decode_to_pcm16k_mono
│   ├── audio.rs                    [DELETED]
│   └── error.rs                    FfmpegNotFoundError variant [REMOVED]
└── command.rs                      new Tauri command: encode_upload_audio
```

### Decode pipeline (replaces all 3 tiers)

```txt
bytes (any container, any codec we support)
  │
  ▼
symphonia probe
  ├─ codec = Opus  ──► symphonia demux ──► opus packets ──► libopus decode ──► f32 frames
  └─ codec = other ──► symphonia demux + decode          ─────────────────────► f32 frames
                                                                                  │
                                                                                  ▼
                                                                          rubato resample
                                                                          (if != 16000 Hz)
                                                                                  │
                                                                                  ▼
                                                                          channel downmix
                                                                          (if > 1 channel)
                                                                                  │
                                                                                  ▼
                                                                          Vec<f32> @ 16k mono
```

### Encode pipeline (new)

```txt
WAV bytes (from cpal recorder file)
  │
  ▼
hound read ──► Vec<f32> @ recorded rate
  │
  ▼
rubato resample to 48k (libopus internal rate)
  │
  ▼
libopus encode (24 kbps VBR, voice mode, 20 ms frames)
  │
  ▼
ogg mux (one Opus stream)
  │
  ▼
Vec<u8>  →  Tauri command result  →  TS upload as multipart .ogg
```

### Before / after at the call site

**Before** (`transcription/mod.rs:154`):

```rust
let Some(samples) = prepare_samples_for_transcription(audio_data, engine_label)? else {
    return Ok(empty_transcript());
};
```

The function dispatches across the 3 tiers. After this spec, the same call site still works, but `prepare_samples_for_transcription` becomes a one-liner around `audio::decode_to_pcm16k_mono`, or the call site is inlined and `prepare_samples_for_transcription` itself is deleted.

**After** (likely shape):

```rust
let samples = audio::decode_to_pcm16k_mono(&audio_data)
    .map_err(TranscriptionError::from)?;
if samples.is_empty() {
    return Ok(empty_transcript());
}
```

## The new dependency catalog

```toml
# apps/whispering/src-tauri/Cargo.toml additions

symphonia = { version = "0.5", default-features = true, features = ["mp3", "aac", "isomp4"] }
audiopus  = "0.3"                  # libopus FFI, vendored libopus C source via cc
ogg       = "0.9"                  # pure-Rust OGG muxer
# rubato, hound already present
```

| Dep | Purpose | Net binary impact | Notes |
| --- | --- | --- | --- |
| `symphonia` | container demux, non-Opus decode | ~200-300 KB | pure Rust, `#![forbid(unsafe_code)]` |
| `audiopus` | Opus encode + decode | ~300-400 KB | vendored C, cc-built |
| `ogg` | mux Opus packets for upload | ~30-50 KB | pure Rust |

**Total new binary cost: ~600 KB - 1 MB.** Replaces 30 MB of external FFmpeg install pain.

### Candidates considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Pure-Rust Opus decoder | None production-ready as of 2026; Symphonia's own is "in development" |
| `opus` crate (vs `audiopus`) | Both wrap libopus, but `audiopus_sys` has a cleaner cc-only build |
| Bundle minimal FFmpeg as Tauri sidecar | Custom FFmpeg builds are a maintenance trap per-platform |
| WebCodecs AudioEncoder in browser | Firefox lacks support as of 2026; would need fallback anyway |
| `libsndfile` FFI | No Opus support; just shifts the dependency |
| Hand-rolled WAV → Opus via WebRTC libs | Reinvents libopus; pointless |

## Call sites: before and after

### Call site 1: transcription dispatch

`apps/whispering/src-tauri/src/transcription/mod.rs:154`

**Before**:
```rust
use audio::prepare_samples_for_transcription;
// ...
let Some(samples) = prepare_samples_for_transcription(audio_data, engine_label)? else {
    return Ok(empty_transcript());
};
```

**After**:
```rust
use crate::audio;
// ...
let samples = audio::decode_to_pcm16k_mono(&audio_data)?;
if samples.is_empty() {
    return Ok(empty_transcript());
}
```

**Semantic shifts to flag**:
- `engine_label` parameter goes away (it was logging-only; the new decoder logs uniformly)
- Return type changes from `Option<Vec<f32>>` to `Vec<f32>`: empty-input check moves to call site
- `TranscriptionError::FfmpegNotFoundError` no longer reachable; remove that variant and any TS-side error handling for it

### Call site 2: cloud upload (new)

`apps/whispering/src/lib/services/transcription/<provider>.ts` (depending on provider)

**Before** (today, uncompressed):
```ts
const audioBlob = new Blob([wavBytes], { type: 'audio/wav' });
const form = new FormData();
form.append('file', audioBlob, 'recording.wav');
// ~960 KB/min
```

**After** (with the new encoder, behind an `uploadCompression` setting):
```ts
const uploadBytes = settings.uploadCompression === 'opus'
    ? await invoke<Uint8Array>('encode_upload_audio', { wavBytes, format: 'opus' })
    : wavBytes;
const mime = settings.uploadCompression === 'opus' ? 'audio/ogg' : 'audio/wav';
const ext  = settings.uploadCompression === 'opus' ? 'ogg' : 'wav';
const form = new FormData();
form.append('file', new Blob([uploadBytes], { type: mime }), `recording.${ext}`);
// ~50 KB/min with opus
```

**Semantic shifts to flag**:
- New setting: `settings.transcription.uploadCompression: 'opus' | 'wav'` (default: `'opus'` on Tauri, forced `'wav'`-equivalent on web because web sends MediaRecorder output unchanged)
- Each cloud transcription provider's request code needs the same update; consider extracting the "prepare upload bytes + headers" step into a shared helper before this lands

### Call site 3: error handling

`apps/whispering/src/lib/services/transcription/utils.ts` and any TS-side `TranscriptionError` discriminant matches.

**Before**:
```ts
if (error.name === 'FfmpegNotFoundError') {
    return { /* show install-ffmpeg toast */ };
}
```

**After**:
```ts
// Branch deleted: variant no longer exists in Rust.
```

Grep `FfmpegNotFoundError` across `src/` to find every site.

## Implementation plan

Wave ordering follows Build → Prove → Remove. Old code stays on disk and unused until the new path is proven, so any phase is one revert away from working state.

### Wave 1: Build the new decoder

- [x] **1.1** Add `symphonia`, `audiopus`, `ogg` to `apps/whispering/src-tauri/Cargo.toml`. Verify `cargo build` on macOS, Linux, Windows in CI. (PR #1826 added symphonia + audiopus; PR #1828 added ogg.)
- [x] **1.2** Create `src-tauri/src/audio/mod.rs`, `audio/decode.rs`, `audio/error.rs`.
- [x] **1.3** Implement `audio::decode_to_pcm16k_mono(&[u8]) -> Result<Vec<f32>, AudioError>`:
  - Symphonia probe + format reader
  - Dispatch: Opus codec → libopus path; other codecs → Symphonia decoder
  - Concatenate decoded frames into a single `Vec<f32>`
  - Downmix to mono if `channels > 1`
  - Resample to 16 kHz with rubato if source rate != 16 kHz
- [x] **1.4** Add focused tests in `audio/decode.rs` (subset: in-memory WAV fixtures cover 16k mono, 48k stereo, garbage, and empty input. Compressed-format fixtures deferred until we add real audio files to `tests/fixtures/`.)
- [x] **1.5** Make sure log output uses `log::debug!`/`warn!` consistently with the rest of `transcription/`.

### Wave 2: Build the new encoder

- [x] **2.1** Implement `audio::encode_wav_to_opus_ogg(&[u8]) -> Result<Vec<u8>, AudioError>` (bitrate hardcoded at 24 kbps until a UI knob earns it). PR #1828.
- [x] **2.2** Add a Tauri command `encode_upload_audio` in `command.rs` (raw IPC body, no bitrate param yet). PR #1828.
- [x] **2.3** Tests: encode-then-decode roundtrip on a 5 s sine; duration within ±50 ms, peak frequency within 10 Hz.

### Wave 3: Prove (switch consumers to the new path; old code still on disk)

- [x] **3.1** `transcription/mod.rs` calls `audio::decode_to_pcm16k_mono`. (PR #1826 went further and deleted the old `transcription/audio.rs`; Wave 4.1/4.2 were folded into PR 1.)
- [x] **3.2** Added `transcription.uploadCompression` setting (`'opus'` default everywhere, no-op on web) and a UI toggle (`UploadCompressionToggle.svelte`) on the transcription settings page. PR #1828.
- [x] **3.3** + **3.5** Rolled to every upload provider in one shot (OpenAI, Groq, ElevenLabs, Deepgram, Mistral, Speaches) via orchestrator-side compression in `transcribeBlob`. PR #1828.
- [ ] **3.4** Smoke-test locally on each platform: blocking on manual verification before PR #1828 merges.

### Wave 4: Remove

- [x] **4.1** `src-tauri/src/transcription/audio.rs` deleted (PR #1826).
- [x] **4.2** `TranscriptionError::FfmpegNotFoundError` variant removed (PR #1826).
- [x] **4.3** TS-side `FfmpegNotFoundError` handling removed across `src/`.
- [x] **4.4** FFmpeg install instructions removed from docs / onboarding / error toasts.
- [x] **4.5** Rolled to every cloud provider in PR #1828 (orchestrator-side compression in `transcribeBlob`).
- [x] **4.6** Final sweep complete. Deleted: `desktopServices.ffmpeg`, `desktopRpc.ffmpeg`, `check-ffmpeg.ts`, the `install-ffmpeg` route, the `transcription.compressionEnabled` / `transcription.compressionOptions` workspace KV entries and migration map rows. Only remaining `ffmpeg` mentions are dev tooling in `docs/audio-test-fixtures.md` (regenerating decoder fixtures) and historical references in older specs.

### Wave 5 (optional): Refuse navigator backend on Tauri

Out of scope for this spec. See Open Questions.

## Edge cases

### Very short clips (< 20 ms)

1. User taps record-stop instantly.
2. cpal writes a near-empty WAV; decoder produces `Vec<f32>` with < 320 samples.
3. Expected: caller's existing "empty transcript" branch catches it. Verify decoder does not panic on `samples_f32.is_empty()` before rubato.

### Variable-bitrate MP3 with seek index missing

1. Some MP3 encoders omit the Xing/VBRI header.
2. Symphonia handles this; duration may be approximate, but decoded sample count is exact.
3. No code change required: note as a known property.

### WebM with multiple audio tracks

1. Browser MediaRecorder shouldn't produce these, but a file upload might.
2. Pick `format.default_track()`; ignore others.
3. Document the behavior; do not error.

### Sample rate above 48 kHz on upload

1. User uploads a 96 kHz studio recording.
2. Symphonia decodes; rubato downsamples to 16 kHz.
3. rubato's max ratio is 8.0 (see existing Tier 2 code); 96 kHz / 16 kHz = 6.0 is fine. Anything > 128 kHz would fail: guard with an explicit error.

### Encoder called on non-WAV input

1. TS sends arbitrary bytes to `encode_upload_audio`.
2. hound parse fails → return `AudioError::EncodeInputNotWav`.
3. TS catches and falls back to uncompressed upload.

### libopus build failure on a weird platform

1. CI on, e.g., a musl Linux variant might fail to build `audiopus_sys`.
2. Mitigation: pin a known-good `audiopus` version; add CI matrix coverage for macOS / Ubuntu / Windows from the start; document the failure mode in the build README.

## Open questions

1. **Should we refuse navigator backend on Tauri entirely?**
   - Options: (a) keep as opt-in setting (status quo), (b) deprecate with a warning, (c) remove option entirely.
   - **Recommendation**: defer. The decoder works for both paths, so deletion is pure UX simplification, not a blocker for this spec. Revisit after a quarter of telemetry showing navigator-on-Tauri usage.

2. **Default `uploadCompression` value?**
   - Options: (a) `'opus'` by default on Tauri, (b) `'wav'` by default with a "save bandwidth" toggle, (c) auto based on connection type.
   - **Recommendation**: `'opus'` default. Voice users want it; the toggle is for the rare audiophile who insists on lossless upload.

3. **Should the encoder live in `audio/` or under `upload/`?**
   - Options: (a) `src-tauri/src/audio/encode.rs` (this spec's choice), (b) `src-tauri/src/upload/encode.rs` (separates "for transcription" from "for sending").
   - **Recommendation**: (a). Both decode and encode are codec operations; cohesion wins over cross-cutting concern naming.

4. **Should we drop `is_valid_wav_format` (Tier 1) entirely, or keep as a fast-path skip into hound?**
   - Symphonia's WAV decode is fast (~10 ms for a 1-min clip). The branch is probably noise.
   - **Recommendation**: delete it. One fewer path.

5. **Whisper.cpp / Parakeet / Moonshine sample format expectations.**
   - The current code returns f32 PCM at 16 kHz mono. Verify all three engines still take that. Symphonia's `SampleBuffer<f32>` produces interleaved samples; check the channel layout matches what `extract_samples_from_wav` (deleted) was producing.
   - **Recommendation**: add an explicit assertion in Wave 1.4 that the new decoder produces bit-identical (within float precision) output to the old Tier 2 path on a 48 kHz stereo WAV fixture.

6. **Web build: is local inference ever planned?**
   - If yes, we'd need a WASM build of a decoder (libopus.wasm + symphonia-wasm? or just refuse local inference on web).
   - **Recommendation**: defer; punt to a separate spec if/when it lands.

## Success criteria

- [ ] `cargo test` passes on macOS, Linux, Windows
- [x] Zero references to `ffmpeg` in `apps/whispering/src-tauri/` after Wave 4
- [x] `TranscriptionError::FfmpegNotFoundError` removed; TS handlers cleaned up
- [x] Decoder fixture tests cover: WAV, MP3, M4A/AAC, WebM/Opus, OGG/Opus
- [x] Encoder roundtrip: 5 s sine wave at 16 kHz → Opus/OGG → decode → < 50 ms duration delta, peak frequency within 10 Hz
- [ ] Manual smoke test: cpal + cloud upload payload < 1/10 the size of the WAV equivalent
- [ ] Binary size delta < 1.5 MB per platform (vs current build without FFmpeg sidecar)
- [ ] No regression on local-inference happy path (cpal + local engine should be unchanged perceptually)
- [x] FFmpeg install instructions removed from docs and onboarding

## References

- `apps/whispering/src-tauri/src/transcription/audio.rs`: current 3-tier conversion (to be deleted)
- `apps/whispering/src-tauri/src/transcription/mod.rs:154`: primary call site
- `apps/whispering/src-tauri/src/transcription/error.rs`: `FfmpegNotFoundError` to remove
- `apps/whispering/src-tauri/src/recorder/recorder.rs`: cpal recorder (unchanged, but feeds the new decoder)
- `apps/whispering/src/lib/state/device-config.svelte.ts:38`: `recording.method` default
- `apps/whispering/src/lib/services/recorder/navigator.ts:237-246`: browser mime-type fallback list
- Commit `95d08439c`: recent Tier 3 perf optimization (stdin streaming); becomes dead code in Wave 4
- DeepWiki: `pdeljanov/Symphonia`: verified demuxer-only API and Opus packet handling
- DeepWiki: `cjpais/Handy`: reference architecture for cpal-based capture
- OpenAI transcriptions API docs: accepted formats include `.ogg` (verified for Wave 2.3 pilot)
