# Recorder Handoff Shape Investigation

Branch: `bench/recorder-shapes-investigation` (off `codex/whispering-recorder-artifact-collapse`)
Bench: `apps/whispering/src-tauri/tests/bench_recorder_shapes.rs`

Note: the executable benchmark was later deleted after the recorder shape
decision landed. The captured results in this report are the retained artifact;
the benchmark did not assert product behavior and should not run as a default
test.

## Question

Should we keep PR #1831's raw `Float32Array | Blob` stop output, or replace it
with one canonical progressive 16 kHz mono WAV file, path-only IPC, and a
Rust-side `transcribe_wav_path`?

## Approach

Built an integration test that times the three handoff shapes' work in Rust.
Each clip length (5 s, 30 s, 120 s) uses a synthetic 16 kHz mono 440 Hz sine
buffer as the canonical `CapturedPcm::samples` payload (the recorder always
produces samples at this rate; see `recorder/recorder.rs:38` and
`recorder/artifact.rs:18`).

Per shape, we time the post-stop critical path: stop latency, audio handoff,
local-transcription prep, cloud-upload prep. Tauri's IPC bridge cost is NOT
benched (it lives in webview-land); the bench reports the Rust-side
serialization cost, doubling that is a conservative upper bound on what the
bridge adds.

Run with:

```bash
cd apps/whispering/src-tauri
cargo test --release --test bench_recorder_shapes -- --nocapture
```

## Raw numbers (median ms on Apple Silicon, release build)

```
clip  metric                       shape          median     mean       payload
----- ---------------------------- -------------- ---------- ---------- ----------
5s    stop: pcm->binary            shape1 raw-f32     0.052ms     0.052ms   312.5 KB
5s    local: pcm->wav              shape1 raw-f32     0.052ms     0.052ms   312.5 KB
5s    local: decode_to_pcm16k      shape1 raw-f32     0.205ms     0.259ms   312.5 KB
5s    cloud: bytes->pcm            shape1 raw-f32     0.008ms     0.009ms   312.5 KB
5s    cloud: pcm->opus_ogg         shape1 raw-f32    68.824ms    69.283ms    16.0 KB
5s    stop: write+flush wav        shape2 wav-path     0.149ms     0.174ms   312.5 KB
5s    local: read+decode wav       shape2 wav-path     0.258ms     0.307ms   312.5 KB
5s    cloud: read+decode+opus      shape2 wav-path    66.198ms    66.644ms
5s    local: in-process handoff    shape3 direct      0.005ms     0.005ms   312.5 KB

30s   stop: pcm->binary            shape1 raw-f32     0.395ms     0.405ms    1.83 MB
30s   local: pcm->wav              shape1 raw-f32     0.393ms     0.402ms    1.83 MB
30s   local: decode_to_pcm16k      shape1 raw-f32     1.539ms     1.569ms    1.83 MB
30s   cloud: bytes->pcm            shape1 raw-f32     0.114ms     0.123ms    1.83 MB
30s   cloud: pcm->opus_ogg         shape1 raw-f32   394.786ms   394.772ms    95.0 KB
30s   stop: write+flush wav        shape2 wav-path     0.541ms     0.608ms    1.83 MB
30s   local: read+decode wav       shape2 wav-path     1.625ms     1.740ms    1.83 MB
30s   cloud: read+decode+opus      shape2 wav-path   396.451ms   396.862ms
30s   local: in-process handoff    shape3 direct      0.108ms     0.109ms    1.83 MB

120s  stop: pcm->binary            shape1 raw-f32     1.617ms     1.571ms    7.32 MB
120s  local: pcm->wav              shape1 raw-f32     1.692ms     1.709ms    7.32 MB
120s  local: decode_to_pcm16k      shape1 raw-f32     6.861ms     7.011ms    7.32 MB
120s  cloud: bytes->pcm            shape1 raw-f32     0.565ms     0.601ms    7.32 MB
120s  cloud: pcm->opus_ogg         shape1 raw-f32  1617.962ms  1614.778ms   377.6 KB
120s  stop: write+flush wav        shape2 wav-path     3.145ms     3.489ms    7.32 MB
120s  local: read+decode wav       shape2 wav-path     8.731ms     9.003ms    7.32 MB
120s  cloud: read+decode+opus      shape2 wav-path  1594.153ms  1597.269ms
120s  local: in-process handoff    shape3 direct      0.444ms     0.451ms    7.32 MB
```

## Summary table (median ms, critical path totals)

| Shape | 5 s stop+local+cloud | 30 s stop+local+cloud | 120 s stop+local+cloud | Code delta (est.) | Crash safety | Cloud support |
|---|---|---|---|---|---|---|
| **Shape 1: raw f32 IPC** (PR #1831, current) | 0.05 + 0.26 + 68.8 | 0.40 + 1.93 + 394.9 | 1.62 + 8.55 + 1618.5 | baseline | none, lost on crash | clean: f32 → libopus, one hop |
| **Shape 2: progressive WAV, path-only IPC** | 0.15 + 0.26 + 66.2 | 0.54 + 1.63 + 396.5 | 3.15 + 8.73 + 1594.2 | +~200 / -~300 lines | clip on disk continuously, recoverable | adds 1 Symphonia hop (~7 ms @ 120 s, dominated by Opus encode) |
| **Shape 3: direct in-process local** (additive on top of #1831) | 0.005 + 0 + 68.8 | 0.11 + 0 + 394.8 | 0.44 + 0 + 1618.0 | +~60 / -0 lines | unchanged | unchanged |

Notes on the numbers:
- "stop" = work between worker handing back samples and the JS side
  unblocking; for shape 2 this is `write+flush wav` to a fresh tempfile per
  iteration (upper bound; progressive writes overlap with recording).
- "local" = wrap/parse + `decode_to_pcm16k_mono`. Shape 3 is zero because
  the engine consumes the in-memory `Vec<f32>` directly.
- "cloud" = bytes-to-pcm parse + `encode_pcm_to_opus_ogg` for shape 1/3;
  file read + decode + opus for shape 2.
- The Opus encode dominates cloud at all clip lengths (it is the same
  function call across all three shapes); the difference between shapes
  there is noise.

## Findings

1. **Stop latency is not a real differentiator.** Even at 120 s, all three
   shapes land under 4 ms. Shape 2's "write + flush a 7.3 MB WAV to disk"
   takes 3.1 ms median on this machine; progressive writes during recording
   would push the at-stop portion lower. Shape 1's `to_binary` is 1.6 ms.
   Shape 3 is functionally zero. **Delta across shapes ≪ 50 ms,
   confirming the user's hunch.**

2. **Local-prep latency for shape 2 is essentially identical to shape 1.**
   At 120 s, shape 1 is 8.55 ms (pcm-to-wav + Symphonia decode), shape 2 is
   8.73 ms (file read + Symphonia decode). The savings shape 1 gets from
   skipping a file read are eaten by JS-side WAV synthesis.

3. **Shape 3 is the actual speed win, not shape 2.** Going direct
   `Vec<f32> → engine` skips the entire 8-9 ms decode prep at 120 s. For
   local transcription this is the only path that materially changes the
   critical path.

4. **Cloud-prep delta is noise.** Opus encode is the same 1.6 s call across
   all three shapes; the ±20 ms variation between shape 1 and shape 2 here
   is wall-clock noise on a single-machine run.

## What the bench does NOT model

- **Tauri IPC bridge memcpy.** Raw IPC body crossing into webview-land
  costs an extra ~memory-bandwidth-limited memcpy. For a 7.3 MB shape-1
  payload that is ~1.5 ms additional one-way. Worst case shape 1 is
  ~3 ms heavier than reported; still well under 50 ms.
- **Streaming resampler.** Shape 2 needs the consumer worker to resample
  on-the-fly (currently `resample_mono` is one-shot at finalize). Either
  refactor `rubato::SincFixedIn` to stateful + persistent across chunks,
  or sidestep by writing WAV at the device sample rate (e.g. 48 kHz f32
  mono = ~192 kB/s, three times the on-disk size but no resampler change).
- **Disk write latency under load.** On SSD this is fast. On a stressed
  laptop or HDD, shape 2's stop+flush could spike. Progressive writes
  during recording absorb most of this, but a hostile FS or full disk
  is a new failure mode.
- **Real audio decode complexity.** Bench uses synthetic 16 kHz mono
  f32. The Symphonia path costs more on Opus-in-WebM (Opus packet decode
  via libopus) than on f32 WAV, but both shapes 1 and 2 land on f32 WAV
  for the cpal recorder output, so this is fair.

## Code-delta detail

### Shape 2 (progressive WAV, path-only IPC) — net deletion

**Deletes** (≈300 lines, dominantly JS-side):
- `apps/whispering/src/lib/services/recorder/pcm-to-wav.ts` (54 lines).
- `parsePcmIpcBody` + `RecorderError.InvalidPcmIpc` in `cpal.tauri.ts` (~25 lines).
- The `Float32Array` branch + parse in `prepareForService` (`operations/transcribe.ts:71-97`, ~30 lines).
- `encode_upload_pcm` Tauri command + the JS `encodePcmToOpusOgg` wrapper (~70 lines across `audio/command.rs` and `tauri.tauri.ts`).
- `CapturedPcm::to_binary` (artifact.rs is gone or shrinks dramatically; the 35-line file collapses).
- The `Float32Array | Blob` union in `RecorderAudio` becomes just `Blob` or `string`, simplifying every consumer.

**Adds** (≈200 lines):
- WAV writer in `recorder/recorder.rs` consumer worker: `hound::WavWriter<BufWriter<File>>` open at `start_recording`, append per-chunk inside `run_consumer`, `finalize()` inside the `Stop` arm (~60 lines).
- Either a streaming `SincFixedIn` resampler in the worker (~50 lines) OR a "write-at-device-rate, resample-at-decode" path that lets `decode_to_pcm16k_mono` do the rate fixup (no new code, larger files).
- New Tauri command(s) that take a path:
  - `transcribe_audio_path(path, config)`: `fs::read` + existing `decode_to_pcm16k_mono` + inference (~30 lines).
  - `encode_upload_audio_path(path)`: `fs::read` + existing `encode_wav_to_opus_ogg` (~20 lines).
- Or a single `read_recording_artifact(path) -> bytes` and let the existing commands keep their byte bodies (~15 lines).
- JS side: pass path strings through `transcribeAudio` instead of `RecorderAudio` (~30 lines net simpler).
- Recovery scan on startup for orphaned WAV files (cheap, ~20 lines).

### Shape 3 (additive `stop_and_transcribe_local`) — purely additive

**Adds** (≈60 lines):
- New command `stop_and_transcribe_local(config)` in `transcription/mod.rs`:
  takes the config header, calls `recorder.stop_recording()` internally,
  passes the `Vec<f32>` straight into `run_transcription` after a short
  shim that skips `decode_to_pcm16k_mono` (the samples are already at the
  decoder's output shape). ~40 Rust lines.
- JS side: local-transcription dispatch checks if input is `Float32Array`
  and invokes the new command instead of `transcribe_audio` + WAV
  wrapping. ~20 TS lines.
- Leaves PR #1831 + cloud path untouched.

### Hybrid (memory PCM + progressive WAV) — net add

Keep PR #1831's PCM IPC for cloud (no decode hop), add progressive WAV
on disk for crash-safety + a `transcribe_audio_path` for local. ~+200/-50.
Two artifacts to keep in sync; the worst of both worlds unless crash
safety is the dominant goal.

## Recommendation

**Add `stop_and_transcribe_local` on top of PR #1831 (shape 3 hybrid).**

Reasoning:
- Shape 3 is the only one that materially changes the post-stop critical
  path. Skipping the 7-9 ms decode prep at 120 s is a real, measurable
  win for the most latency-sensitive path (dictation → local model).
- It is purely additive: PR #1831's data model stays, no migration, no
  breaking JS-side change, no Tauri permission/scope work.
- The cloud path is already optimal in PR #1831 (raw f32 → libopus, one
  hop). Adding shape 2 there gives up the explicit fast lane for a
  decode hop that buys nothing measurable.

**Do not switch to shape 2 for the speed.** The bench rules out the
~150-300 ms ghost the original PR comment imagined: stop and local-prep
deltas are well under 50 ms.

**Switch to shape 2 only if crash safety + one-artifact simplicity is
the real product goal.** The numbers don't punish that decision, and the
~300 lines of deletion on the JS side is a real architectural win. But
that's a taste call, not a perf call — it should be argued on data-model
grounds, not on the (non-existent) latency win.

## Files

- Bench: `apps/whispering/src-tauri/tests/bench_recorder_shapes.rs`
- Existing code referenced:
  - `apps/whispering/src-tauri/src/recorder/artifact.rs:18`
  - `apps/whispering/src-tauri/src/recorder/recorder.rs:38,179,239-289`
  - `apps/whispering/src-tauri/src/recorder/commands.rs:82-96`
  - `apps/whispering/src-tauri/src/audio/decode.rs:38`
  - `apps/whispering/src-tauri/src/audio/encode.rs:57,78`
  - `apps/whispering/src-tauri/src/transcription/mod.rs:154-239`
  - `apps/whispering/src/lib/services/recorder/cpal.tauri.ts:32-42,148-168`
  - `apps/whispering/src/lib/services/recorder/types.ts:256`
  - `apps/whispering/src/lib/services/recorder/pcm-to-wav.ts`
  - `apps/whispering/src/lib/operations/transcribe.ts:64-129`

## Commands run

```bash
cd /Users/braden/.codex/worktrees/32b9/epicenter
git checkout -b bench/recorder-shapes-investigation
# wrote tests/bench_recorder_shapes.rs
cd apps/whispering/src-tauri
cargo test --release --test bench_recorder_shapes -- --nocapture
```
