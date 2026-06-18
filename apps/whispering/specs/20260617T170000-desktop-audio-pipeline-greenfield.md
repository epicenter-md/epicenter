# Desktop Audio Pipeline: Greenfield Direction

**Date**: 2026-06-17
**Status**: In Progress (measurement pending; timing tool on `feat/whispering-timing-instrumentation`, optimization parked on `feat/whispering-pcm-handoff-optimization`, both gated on the owed measurement)
**Owner**: Braden
**Supersedes**: `specs/transcription-latency-optimization.md` (deletion staged on the work branches; lands with whatever merges first, or a docs-only cleanup; see "Superseded work")

> **Deliberate split (decided 2026-06-18): measure before optimizing, and don't
> merge "just timing."** The original PR 1 bundled instrumentation + the
> in-process handoff + async persist. We split them, because the spec's own logic
> is "the instrumentation justifies the optimization", so shipping both at once
> merges an unproven change. We then went further: the timing is a **measurement
> tool, not a standalone production change**, so it is not merged on its own. Now:
>
> - **Timing tool** lives on `feat/whispering-timing-instrumentation` (off by
>   default, zero behavior change). You **measure off the branch** — no merge
>   needed. Its only job is to settle, on real hardware, whether the disk
>   round-trip / fsync tail and the cold model load are worth removing.
> - **The handoff + async-persist optimization is fully designed and implemented,
>   parked** on `feat/whispering-pcm-handoff-optimization`, **gated on the
>   measurement.** It carries its own copy of the timing, so if it lands, the
>   instrumentation rides into production **with the change it justifies** (where
>   instrumentation belongs), not on its own. If the measurement says "not worth
>   it," nothing standalone merges.
> - A permanent latency-diagnostic knob (merge a trimmed timing module on its own
>   merits) is an optional, separate product call, not part of this work.
>
> Promote "Durable decisions" to an ADR once the direction is locked; keep this
> spec In Progress through PR 2 / PR 3.

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

> Re-verified against `origin/main` on 2026-06-17: all line numbers below were
> accurate, and they remain true after PR 1 (instrumentation only changes no
> behavior). The **parked optimization** is what reverses fact (4):
> `stop_recording` would stop fsyncing before returning (persist off the critical
> path) and the live path would skip read + decode (the in-process handoff feeds
> the model/encoder).

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
| WAV encode + write + **fsync** | 2–8 ms | 3–12 ms | 5–30 ms (spikes 50–100+) | PR 1b parked (off critical path) |
| read + Symphonia decode (no resample) | 2–8 ms | 3–15 ms | 10–50 ms | PR 1b parked |
| Opus compress (16k→48k + libopus) | 10–40 ms | 30–120 ms | 100–400 ms | PR 1b parked (cloud) |
| **model load (cold)** | 0.3–2 s | 0.3–2 s | 0.3–5 s | PR 2 (hide under speech) |
| local inference (Metal) | 0.3–1.5 s | 0.5–3 s | 2–10 s | — (refused: streaming) |
| cloud upload + provider | 0.5–3 s | 0.6–3 s | 1–6 s | — (network-bound) |
| delivery to clipboard/cursor | 10–100 ms | 10–100 ms | 10–100 ms | — |

The file round-trip the parked optimization removes is single-digit-to-tens of ms plus
a variable fsync spike — real, but mostly swallowed by inference unless the model was
cold or the disk was contended. **Cold model load (0.3–5 s) is the single largest
removable number, and PR 2 owns it.** PR 1 (instrumentation) is what tells us, on real
hardware, which of these actually dominates before we remove anything.

---

## Durable decisions (promote to an ADR once the direction locks, then delete this section)

> These are the **direction**, not all shipped yet. PR 1 (instrumentation) ships
> none of (1)–(3) as behavior; decisions 1 and 3 are realized in the parked
> optimization and only land if the measurement justifies it. (2), (4), (5) are
> standing constraints that already hold.

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

## Orchestration: measure first, then three optimizations

The original plan bundled the handoff + async-persist into "PR 1". We split it so the
instrument lands first and the optimization lands only if the numbers earn it.

### PR 1 — Instrumentation as a measurement tool (NOT merged standalone)

Implemented on `feat/whispering-timing-instrumentation`. Pure addition, off by
default, zero behavior change, one read path / one source of truth (disk). **You run
it off the branch to measure; you do not merge it on its own.** Its only job: settle,
on real hardware, which budget components actually dominate before anything is removed.
If an optimization lands, the timing rides in with it (it's on the parked branch too).

- **`timing` module** (`src-tauri/src/timing.rs`): gated by `WHISPERING_TIMING` in the
  environment, logs on target `whispering::timing`. `measure(label, f)` wraps a call;
  `timing_note!` emits a one-off note. Unset (default, incl. release) = branch-and-
  return, no clock read, no allocation.
- Spans placed on the live path: `finalize` (recorder worker), `stop.wav_write+fsync`
  (the synchronous write still on the critical path — exactly what the parked
  optimization would remove), `transcribe.read+decode`, `encode.read+decode`,
  `encode.opus`, plus `model.load COLD` / `model.load warm-reuse` / `model.inference`
  (reusing `model_cache`'s already-computed elapsed values).
- A `file_roundtrip_overhead` Rust test prints write+fsync and read+decode for
  5/15/60 s clips (lossless round-trip assertion + numbers).
- **No new runtime state, no command-signature change, no bindings change.**

Note: the timing branch also deletes the superseded `specs/transcription-latency-optimization.md`,
but since the branch isn't merged standalone, that deletion (and adding this direction
doc to `main`) rides with whatever lands first, or a tiny docs-only cleanup if `main`
should reflect the plan sooner.

Why a tool, not a feature: the instrumentation is what justifies (or kills) every later
step. Merging it on its own would put "just timing" into production for no behavior; far
cleaner to measure with it and let it ride in with the optimization it proves.

**Measured now — the file round-trip the parked optimization would remove**
(Apple-Silicon M-series, NVMe SSD; `cargo test file_roundtrip_overhead -- --nocapture`,
4 runs):

| Clip | write + fsync | read + decode | total |
|---|---|---|---|
| 5 s  | ~9–15 ms  | ~4–12 ms  | **~14–27 ms** |
| 15 s | ~8–9 ms   | ~12 ms    | **~20–22 ms** |
| 60 s | ~27–29 ms | ~48–49 ms | **~75–79 ms** |

**These are the only measured numbers, and they are component-level, not
stop→delivery.** Two caveats this clean dev box cannot capture:

- **The fsync tail is the suspected real lever and is invisible here.** This NVMe never
  spiked; the "spikes 50–100+ ms" live on contended disks (a cloud-synced recordings
  folder, Windows AV scanning the write, a spinning HDD). That is exactly what the
  owed measurement must provoke.
- On a CPU-only box inference dominates more, so the round-trip is proportionally
  smaller.

**Measurement still owed (needs a human on real hardware):** end-to-end stop→delivery,
warm vs cold model, on **Apple-Silicon** and a **CPU-only Windows box**, with
`WHISPERING_TIMING=1`, and crucially **a contended disk** (synced folder / Windows
Defender on) to provoke the fsync tail. Record 5/15/60 s clips, `grep '[timing]'`, read
`finalize`, `stop.wav_write+fsync`, `transcribe.read+decode`, `model.load`,
`model.inference`. That data decides everything below.

### PR 1b — In-process PCM handoff + async persist — DESIGNED, PARKED (gated on PR 1's data)

Fully implemented on `feat/whispering-pcm-handoff-optimization`. **Held back
deliberately** until PR 1's measurement shows the round-trip / fsync tail is worth
removing. (Reviving it is a rebase onto main plus reconciling the timing changes it
duplicates from PR 1, since the branch predates this split.) Honest framing of what it
is:

- **`audio::PcmHandoff`** is a Tauri-managed, single-slot store of the most recent
  finalized PCM, keyed by recording id. **It is not "the AudioEngine" and does not
  centralize routing** (local-vs-cloud still lives in JS). Its real job is the
  **synchronization point that makes async persistence safe**: the live consumer reads
  from memory and never races the off-path WAV write. Disk stays the single source of
  truth; a non-live miss falls back to decoding the WAV. Honest cost: it **adds a read
  path** (memory hit, else disk miss) rather than collapsing to one. The history
  re-transcribe / re-encode feature means a disk-read path is irreducible anyway; the
  question this branch answers is only whether adding the memory path is worth it.
- `artifact.rs` splits the pure handle (`artifact_handle`, deterministic `byte_length`)
  from the WAV write (`persist_artifact`), so the handle is ready before the write.
- `stop_recording` builds the handle, spawns the persist off the critical path, stashes
  the buffer, returns. Persist failure emits `recorder:persist-failed`; the FE shows a
  transient "audio not saved" toast (durable decision 3, with the relaxation noted
  above). `transcribe_recording` / `encode_recording_for_upload` take from the handoff,
  decode-from-disk on miss (added `State<PcmHandoff>`, erased from the IPC contract).

The merge criterion is in "Falsification benchmark": if the round-trip is a meaningful
share of stop→delivery, OR the fsync tail shows up on real user disks, merge it. If the
model stays warm and disks are fast, it stays parked and PR 2 is where the effort goes.

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
- **Verify every PR with numbers, not vibes.** Each *optimization* PR lands with measured
  before/after stop→delivery on at least Apple-Silicon and a CPU-only box. No PR claims a
  speedup it did not measure. (PR 1 is the instrument that produces those numbers, so it
  ships measuring the component it could, and explicitly claims no e2e speedup.)
- **Refuse out loud.** If PR 2 or PR 3 can't be done cleanly, the correct deliverable is a
  written refusal in this doc, not a forced feature.

## Falsification benchmark (what proves us wrong)

With the model already resident (default `UnloadPolicy`) and a fast engine
(distil/Parakeet) on target hardware: if the file round-trip (fsync + read + decode) is
**< ~2% of stop→delivery**, the default unload policy keeps the model warm in normal use
(so cold load is rare), **and** real user disks show no fsync tail, then **PR 1b stays
parked and PR 2 is the only thing worth shipping** — you are inference/network-bound,
and the in-process plumbing buys nothing perceptible. If cold-load shows up on most
recordings, PR 2 is vindicated as the top priority. If the fsync tail shows up on
contended disks, **merge PR 1b** regardless of PR 2. PR 1's instrumentation is what
settles all three.

## Superseded work

- `specs/transcription-latency-optimization.md` — stale (predates the id-based pipeline)
  and proposes pushing the blob through JS (`transcribeRecordingWithBlob`), which
  decision (2) refuses. Deletion is staged on the work branches (`git rm`) and lands
  with whatever merges first (or a small docs-only cleanup); git keeps the body recoverable.
