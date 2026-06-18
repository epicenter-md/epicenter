# Desktop Audio Pipeline: Greenfield Direction

**Date**: 2026-06-17
**Status**: In Progress (PR 1 implemented on `feat/whispering-inprocess-pcm-handoff`, pending review)
**Owner**: Braden
**Supersedes**: `specs/transcription-latency-optimization.md` (deleted in PR 1; see "Superseded work")

> **PR 1 landed the in-process handoff + async artifact + instrumentation.** It
> measured only the component it removes (the disk round-trip); it did NOT measure
> stop→delivery, so the PR-2-vs-PR-3 call is **not yet decidable** and waits on the
> owed measurement (see "PR 1 results" and "Measurement still owed"). Promote
> "Durable decisions" to an ADR once PR 1 merges, then keep this spec In Progress
> for PR 2 / PR 3.

## One sentence

On desktop, the finalized audio for one recording lives as a single in-memory
`Vec<f32>` (mono 16 kHz) that Rust hands **in-process** to whichever consumer the
caller named (the local model, or the Opus encoder); the durable WAV is written
as a parallel side effect, never as the transcription source.

## Product sentence

The Rust `AudioEngine` owns every sample from mic to finalized PCM; manual-stop
and (eventually) VAD-endpoint both enter through one `finalize → segment` path;
the runtime's one job is to route that buffer straight to the model or the
encoder in-process. The filesystem leaves the critical path entirely. Audio bytes
never cross the JS / Tauri IPC boundary; JS keeps trafficking only the small
`RecordingArtifact` id-handle.

---

## Why now / the perceived-latency problem

"User stops speaking → transcript delivered" is the number we optimize. Today the
desktop manual path is:

```
cpal cb → mpsc → worker buffer(Vec<f32>)
  → STOP: finalize() resamples → 16k mono     ← samples are ALREADY what the model wants
  → write_artifact(): synth WAV + BufWriter + sync_all()   [BLOCKS the IPC return]
  → IPC return handle → JS pipeline → IPC transcribe_recording(id)
  → read_artifact_samples(): fs::read + Symphonia probe/decode + resample(16k→16k = identity)
  → cache.transcribe(Vec<f32>, spec)          ← takes raw PCM
  → inference → deliver
```

The WAV write → read → decode between capture and local inference is, for the cpal
path, **pure overhead recovering a buffer Rust held in RAM 20 ms earlier.**

### Verified code facts (ground truth, not assumptions)

> Re-verified against `origin/main` on 2026-06-17 before PR 1: all line numbers
> below were accurate. These describe the **pre-PR-1 baseline** (the diagnosis).
> PR 1 reverses fact (4): `stop_recording` no longer fsyncs before returning the
> handle (persist moved off the critical path), and the live path no longer
> reads + decodes the WAV (the in-process handoff feeds the model/encoder).

- `model_cache.transcribe(samples: Vec<f32>, spec)` already consumes raw mono-16k
  PCM; engines call `transcribe_with(&samples, …)`
  (`src-tauri/src/transcription/model_cache.rs:174`). The worker already holds that
  exact buffer at stop (`recorder/recorder.rs:295`, `finalize`).
- `encode_pcm_to_opus_ogg(samples, 16_000)` takes the same `Vec<f32>`
  (`src-tauri/src/audio/encode.rs:54`). `encode_recording_for_upload` only re-derives
  it by re-reading the file (`src-tauri/src/audio/command.rs:35`).
- `resample_mono` is **identity at equal rates** (`src-tauri/src/audio/resample.rs:25`),
  so `decode_to_pcm16k_mono` does **no resampling** for a cpal-written 16k WAV — it is
  `fs::read` + Symphonia container-parse + sample-copy only (`audio/decode.rs:41`).
- `stop_recording` already fsyncs the WAV (`recorder/artifact.rs:315`, `sync_all`)
  before returning the handle, serializing disk durability ahead of transcription.

### External grounding (DeepWiki, 2026-06-17)

- whisper.cpp `whisper_full(ctx, params, const float* samples, n_samples)` accepts raw
  16k mono f32 directly; **model load dominates latency for short clips**, inference
  scales with audio length. Confirms the in-process handoff needs no file and that
  prewarm targets the largest removable number.
- Silero VAD v5 ONNX: one step = **512 samples @ 16 kHz**, carries recurrent hidden
  state across chunks (`reset_states` to clear). Endpointing is the `VADIterator`
  state machine: `threshold 0.5`, `neg_threshold = threshold − 0.15` (hysteresis),
  `min_silence 100 ms`, `speech_pad 30 ms` — a ~150-line deterministic state machine.
- `ort` runs Silero v5 in Rust; `SilentKeys` already ships Parakeet **+** Silero on
  `ort`. A native desktop VAD is feasible, not research.

### Rough latency budget (ranges, Apple-Silicon, SSD, distil/Parakeet)

| Component | 5 s | 15 s | 60 s | Removable by |
|---|---|---|---|---|
| finalize (resample; identity if dev=16k) | 0–10 ms | 0–30 ms | 0–100 ms | — |
| WAV encode + write + **fsync** | 2–8 ms | 3–12 ms | 5–30 ms (spikes 50–100+) | PR 1 (off critical path) |
| read + Symphonia decode (no resample) | 2–8 ms | 3–15 ms | 10–50 ms | PR 1 |
| Opus compress (16k→48k + libopus) | 10–40 ms | 30–120 ms | 100–400 ms | PR 1 (cloud) |
| **model load (cold)** | 0.3–2 s | 0.3–2 s | 0.3–5 s | PR 2 (hide under speech) |
| local inference (Metal) | 0.3–1.5 s | 0.5–3 s | 2–10 s | — (refused: streaming) |
| cloud upload + provider | 0.5–3 s | 0.6–3 s | 1–6 s | — (network-bound) |
| delivery to clipboard/cursor | 10–100 ms | 10–100 ms | 10–100 ms | — |

The file round-trip PR 1 removes is single-digit-to-tens of ms plus a variable fsync
spike — real, but mostly swallowed by inference unless the model was cold. **Cold
model load (0.3–5 s) is the single largest removable number, and PR 2 owns it.**

---

## Durable decisions (promote to an ADR when PR 1 lands, then delete this section)

1. **The WAV is a side effect, not the transcription source.** Local inference and
   cloud encoding consume the in-memory finalized PCM in-process. `read_artifact_samples`
   survives only for history re-transcribe / re-encode, never the live path.
2. **Audio bytes never cross the JS/Tauri boundary.** JS sees the id-handle only. (This
   is why the superseded spec's `transcribeRecordingWithBlob(blob)` is rejected.)
3. **The transcript never waits on disk.** Artifact persistence runs concurrently with
   inference. The in-memory `PcmHandoff` is what makes this safe: on the live path the
   stash is a **guaranteed hit** (the `put` happens-before the return, before JS can
   call `transcribe`), so the live consumer never reads disk and never races the async
   write. If persist fails, a non-blocking "audio not saved" warning fires but the
   transcript still lands. (This weakens the old "recording saved before transcription"
   guarantee on purpose.)
   - **Honest relaxation of "owned until persist acks":** the single-slot store evicts
     on the next `put`, not on the persist ack. The only way the live path misses is a
     pathological rapid-fire (stop A, fully start+stop B, then A transcribes) that
     evicts A before its consumer runs. That degrades to a fall-back disk decode that
     may briefly race A's write and surface a **graceful transcription error, never
     corruption**. We accept this rather than gold-plate an id-keyed persist-tracking
     map for a race a human cannot realistically trigger (persist is a few ms; starting
     and stopping another recording is human-time).
4. **Refuse streaming / chunked partial transcription.** The user controls stop;
   prewarm + in-process + warm inference makes it unnecessary, and chunk/stitch carries
   a permanent boundary-accuracy tax. Reconsider only if instrumentation shows long-clip
   inference dominating on slow hardware — and weigh "faster model" first.
5. **Web keeps browser VAD forever** (no Rust). Desktop browser-VAD is the interim per
   `recording-input-paths-clean-break.md` until the native VAD (PR 3) lands.

## The hard tension to respect (do not paper over)

`model-lifecycle-lazy-collapse.md` deliberately **deleted eager model preload** to kill
the `model_generation` token machinery (out-of-order async loads were the hardest code
in the backend). It explicitly traded away "a warm model before the first transcription."

PR 2 (prewarm) must **not** resurrect that. The distinction the implementer must hold:

- **Eager preload (refused, keep refused):** load when the user *selects* a model in
  settings → selection can change mid-load → needs generation tokens.
- **Prewarm-on-record-start (proposed):** load the *currently-selected* model at the
  moment recording begins, through the existing guarded lazy-load path (Handy-style
  `LoadingGuard` RAII, one load at a time), adding **zero** generation/version reasoning.

If prewarm cannot be done without reintroducing generation tokens, **PR 2 is a documented
refusal**, not a feature. The collapse wins.

---

## Orchestration: three PRs, each the best version of itself

### PR 1 — In-process PCM handoff + async artifact (the asymmetric win) + instrumentation

The headline. Mostly subtraction.

- Add timing spans across the seven budget components (behind a log flag) so the PR
  proves itself with before/after numbers on Apple-Silicon **and** a CPU-only Windows box.
- `stop_recording` keeps its finalized `Vec<f32>` and routes it in-process: local →
  `cache.transcribe(samples, spec)`; cloud → `encode_pcm_to_opus_ogg(samples, 16_000)`
  (Rust returns opus bytes, JS still does the network upload).
- `spawn` `write_artifact` off the critical path; own the samples until the persist acks.
- `read_artifact_samples` / `encode_recording_for_upload(id)` demote to the history
  re-transcribe / re-encode fallback only.
- Land it in the shape it wants long-term: one consumer-routed surface (the embryonic
  `AudioEngine`), not a second bespoke path. Don't build a separate "unify" PR later.
- **Delete `specs/transcription-latency-optimization.md`** in this PR.

Why first: highest confidence, least contended, consumers already take `Vec<f32>`, and
the instrumentation it adds is what justifies (or kills) PR 2 and PR 3.

#### PR 1 results (implemented)

Shape, as built (a few refinements on the sketch above):

- **`audio::PcmHandoff`** (`src-tauri/src/audio/handoff.rs`): a Tauri-managed,
  single-slot store of the most recent finalized PCM, keyed by recording id.
  `put` at stop, `take` (consume-once) at transcribe/encode. **Call it what it is:
  this is not "the AudioEngine" and it does not centralize routing** (local-vs-cloud
  selection still lives in JS). It is the **synchronization point that makes async
  persistence safe**: it guarantees the live consumer reads from memory, never racing
  the off-path WAV write. Disk stays the source of truth, so a non-live miss falls
  back to decoding the WAV; the store self-evicts on the next stop (memory bounded to
  one recording). Honest cost: this **adds a path** (memory hit ?? disk miss) per
  consumer rather than collapsing to one. That extra path pays for itself, because it
  is the only way to move the blocking write off the critical path without a
  read-before-write race.
- **`artifact.rs` split**: `artifact_handle(id, sample_count)` (pure, deterministic
  `byte_length = 44 + n*4`) is built synchronously at stop; `persist_artifact`
  (write + fsync) is spawned off the critical path. The handle no longer depends
  on the file existing, which is what lets the write leave the return path. A
  `debug_assert` + a unit test pin the computed `byte_length` to the bytes the
  writer actually emits.
- **`stop_recording`** builds the handle, `spawn_blocking`s the persist (owning its
  own copy), `put`s the live buffer into the handoff, returns immediately. On
  persist failure it logs and emits `recorder:persist-failed`; the FE shows a
  transient "audio not saved" toast (`attach-desktop-events`) — durable decision 3.
- **`transcribe_recording` / `encode_recording_for_upload`** take from the handoff
  first, decode-from-disk on miss. Both gained a `State<PcmHandoff>` (erased from
  the IPC contract: bindings unchanged except docstrings).
- **`timing` module** (`WHISPERING_TIMING=1`, target `whispering::timing`): flag-
  gated spans on finalize, persist, decode-on-miss, opus, plus handoff hit/miss
  markers and unified `model.load COLD/warm-reuse` + `model.inference` notes
  (reusing `model_cache`'s already-measured elapsed). Off by default = zero cost.

What the IPC and JS pipeline did **not** need: `stop → transcribe(id) → deliver`
is unchanged on the wire. The entire win is inside Rust. Bindings regen produced
only docstring deltas (State params erased), confirming the contract held.

**Measured — file round-trip removed from the live path** (Apple-Silicon M-series,
NVMe SSD; `cargo test file_roundtrip_overhead -- --nocapture`, 4 runs, this is
*exactly* the write+fsync + read+Symphonia-decode PR 1 takes off the critical path):

| Clip | write + fsync | read + decode | total removed |
|---|---|---|---|
| 5 s  | ~9–15 ms  | ~4–12 ms  | **~14–27 ms** |
| 15 s | ~8–9 ms   | ~12 ms    | **~20–22 ms** |
| 60 s | ~27–29 ms | ~48–49 ms | **~75–79 ms** |

This matches the spec's "single-digit-to-tens of ms" prediction and confirms the
60 s decode (~49 ms) dominates the round-trip on long clips. **These are the only
measured numbers. The end-to-end stop→delivery delta is NOT measured** (see
"Measurement still owed"), so this PR makes no claim about what fraction of
perceived latency it removes. Two honest caveats this dev-box bench cannot capture:

- **The fsync tail is the suspected real lever, and it is invisible here.** This NVMe
  SSD never spiked; the spec's "spikes 50–100+ ms" live on contended disks (a
  cloud-synced recordings folder, Windows AV scanning the write, a spinning HDD).
  Async persist removes that variable blocking write from the path regardless of how
  bad it gets. Whether that is a big lever depends entirely on the user's disk, which
  is exactly what the owed measurement must provoke.
- On a CPU-only box, inference dominates more, so the round-trip is proportionally a
  smaller share. Good thing this PR is cheap there.

**Measurement still owed (not yet run; needs a human on real hardware):**

- End-to-end stop→delivery, model warm vs cold, on **Apple-Silicon** and a
  **CPU-only Windows box**, with `WHISPERING_TIMING=1`. The agent cannot drive a
  mic + real model in CI, so it shipped the instrumentation and measured the
  removed component directly instead of asserting an e2e speedup it didn't run.
- Method: record 5 s / 15 s / 60 s clips, grep `[timing]`, read `finalize`,
  `transcribe.handoff hit`, `model.load`, `model.inference`; compare warm-model
  stop→delivery against `origin/main` (which serializes write+fsync before the
  handle and decode before inference).

#### PR-2-vs-PR-3 decision (NOT YET DECIDABLE — needs the owed measurement)

No honest call can be made from PR 1's data alone, because PR 1 only measured the
component it removes, not stop→delivery. The reasoning, with numbers kept separate
from guesses:

- **Known (measured):** the removed round-trip is 14–79 ms on a fast SSD.
- **Suspected, unmeasured:** the largest *median* removable number is **cold model
  load (0.3–5 s)**, which PR 2 owns; the largest *tail* number is the fsync spike on
  contended disks, which PR 1 already removed but which this bench could not size.

So the prior (not a decision) is **PR 2 (prewarm) likely has the bigger median win**,
*conditioned on* the owed measurement showing cold load on a meaningful share of
recordings under the default `UnloadPolicy`. The measurement settles it:

- Cold load common → PR 2 is vindicated, do it next.
- Model stays warm in normal use AND no fsync tail on real user disks → PR 1 was the
  perceptible win, PR 2 demotes to polish.
- fsync tail shows up on contended disks → PR 1 was the lever after all, independent
  of PR 2.

PR 3 (Rust VAD) stays gated on its own round-trip cost, which PR 1's instrumentation
will quantify on the VAD path.

### PR 2 — Prewarm on record-start (contended; may land as a refusal)

- Trigger the existing guarded lazy-load when `start_recording` fires for a local
  provider, overlapping load with the user's speech (the dead time we want to fill).
- Reuse `LoadingGuard`; add zero generation tokens. Respect `UnloadPolicy`.
- Benchmark cold-start stop→delivery before/after. If it can't stay clean vs
  `model-lifecycle-lazy-collapse.md`, write up the refusal and stop.

Why separate: it touches the one subsystem the repo deliberately simplified, so it needs
its own scrutiny and its own benchmark, and it must be reversible without touching PR 1.

### PR 3 — VAD in Rust on the shared cpal engine (conditional on PR 1 data)

- Only if instrumentation shows the desktop VAD round-trip is a real cost.
- `ort` + Silero v5 (512-sample windows, carried state) + the ~150-line `VADIterator`
  endpointer on the shared cpal stream; speech-end emits the same `Vec<f32>` the
  `AudioEngine` already routes.
- Deletes the JS `encodeWAV → fs save → Rust read → decode` chain and onnx-wasm on
  desktop. Web keeps vad-web. Aligns with `recording-input-paths-clean-break.md`.
- First, check whether Parakeet/Moonshine already run on `ort`; if so, Silero is a near-
  free dependency add; if it's all `whisper-rs`, you're adding a runtime — weigh that.

Why last and optional: biggest structural change, behavioral-parity risk (false triggers),
and a second native model to maintain. The win is real but gated on measurement.

---

## Mandate for the implementing agent (freedom + research + verify)

This document is a **direction, not a recipe.** You are expected to:

- **Greenfield freely.** Compatibility is not load-bearing here. If a cleaner shape than
  the one sketched above emerges (a better command surface, a better ownership split),
  take it and update this doc. The five durable decisions and the prewarm tension are the
  only fixed constraints; everything else is yours to redesign.
- **Research first, against ground truth.** Re-verify the code facts above (they drift),
  and ground external-library behavior against DeepWiki / official docs / installed types
  before changing Rust that depends on whisper.cpp, `ort`, `audiopus`, `symphonia`, `rubato`,
  or `cpal`. Load the `tauri` and `rust-errors` skills before touching the command boundary.
- **Verify every PR with numbers, not vibes.** Each PR lands with measured before/after
  stop→delivery on at least Apple-Silicon and a CPU-only box. No PR claims a speedup it
  did not measure.
- **Refuse out loud.** If PR 2 or PR 3 can't be done cleanly, the correct deliverable is a
  written refusal in this doc, not a forced feature.

## Falsification benchmark (what proves us wrong)

With the model already resident (default `UnloadPolicy`) and a fast engine
(distil/Parakeet) on target hardware: if the file round-trip (fsync + read + decode) is
**< ~2% of stop→delivery**, and the default unload policy keeps the model warm in normal
use (so cold load is rare), then **PR 2 is the only thing worth shipping** — you are
inference/network-bound, and PR 1's in-process plumbing buys nothing perceptible. If
cold-load shows up on most recordings, PR 2 is vindicated as the top priority. PR 1's
instrumentation is what settles it.

## Superseded work

- `specs/transcription-latency-optimization.md` — stale (predates the id-based pipeline)
  and proposes pushing the blob through JS (`transcribeRecordingWithBlob`), which
  decision (2) refuses. **Deleted in PR 1** (`git rm`); git keeps the body recoverable.
