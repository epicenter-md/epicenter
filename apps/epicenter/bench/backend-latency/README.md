# backend-latency

A falsifier for one proposal: collapse Epicenter's transcription backend to
**one static dependency, `Backend::Auto`, Metal on Apple, CPU everywhere else**,
and delete the dynamic-backends plus Vulkan posture that Linux and x86_64
Windows ship today.

That collapse is only admissible if plain CPU inference is already fast enough
on ordinary x64 hardware that nobody can feel the difference. This crate
measures that, once per build posture, on identical inputs.

It also falsifies live transcription preview at its authoritative boundary:
batch transcription never fails, and never waits unboundedly, because an
optional preview exists. Preview is revocable and may simply be absent. A
second resident model is one useful optimization, not the gate.

It is throwaway. It is not wired into the app build, CI, or the workspace, and
nothing in `apps/epicenter/src-tauri` can reach it. Delete the directory when
the decision is recorded.

## Live preview go/no-go, precommitted before measurement

The invariant is: **authoritative batch transcription never fails, and never
waits unboundedly, because an optional preview exists. Preview is revocable and
may simply be absent.**

Live preview is EARNED only if all of these hold on the actual candidate
artifacts:

1. `supports_streaming` is true.
2. Cooperative and forced revoke-to-lease-free are each at most **250 ms**, and
   a same-model batch immediately after each revocation succeeds. A user is
   already waiting for the real transcription to start; adding more than a
   quarter second before inference is perceptible and not "preview" work.
   Forced revocation must actually return `Error::Aborted`. Unsupported
   `Feature::Cancellation` fails this criterion because the worst case is then
   one entire in-flight `feed()`.
3. Re-arm produces preview text within **1,000 ms** after either revocation.
   Preview is normally revoked once per dictation, so an expensive restart
   would erase its value on the next dictation.
4. A **20-minute** looped-audio run reaches its target and finalizes, total RSS
   growth is at most **256 MiB**, and the last minute's feed p95 is no more than
   **2x** the first minute's p95. These finite bounds make early termination,
   runaway memory, and context-driven latency drift explicit. Any declared
   `max_audio_ms` below 20 minutes fails this product case.
5. `stream_compute_rtf` is at most **0.5**, and time to first committed text is
   less than **half** the streaming candidate's warm batch median. Otherwise
   preview shows nothing meaningfully sooner than waiting and buys nothing.

If any gating criterion fails, live preview is deleted and not implemented.
This is a precommitment, not a hope to reinterpret the result after seeing it.

### Non-gating optimization study

The harness also reports whether two models fit, the second model's RSS and
device-memory cost, and whether model A can run batch concurrently while model
B streams. If that works, the common case need not revoke preview at all. If it
does not, preview still stands or falls on same-model preemption. Dual residency
failure does not by itself kill preview.

## The one command

```sh
cd apps/epicenter/bench/backend-latency

TRANSCRIBE_CMAKE_ARGS="-DGGML_NATIVE=OFF" \
  cargo build --release --features static-cpu

./target/release/backend-latency \
  --model /path/to/whisper-small-Q4_K_M.gguf \
  --audio /path/to/speech_15s_16k_mono.wav \
  --runs 5 --label "thinkpad-t14 static-cpu" --json results.jsonl
```

One JSON object per invocation on stdout, appended to `--json` so a posture
matrix accumulates into one comparable file. `--help` documents every flag.
`--probe` reports the posture and the registered devices without loading a
model, which is the fastest way to confirm a build is what you think it is.
Pass `--probe --model /path/to/model.gguf` to load just that model and report
`supports_streaming` without running inference.

## Read these three fields before any latency number

| Field | Why it decides admissibility |
| --- | --- |
| `build.isa_pinned` | `false` on x86 means ggml compiled `-march=native`. The number describes the build host, not a binary you could ship. See below. |
| `runtime.device_count` | `0` means the compute backends never registered. This is the dynamic posture's signature failure, and the latency below it is meaningless. |
| `comparison_key` | Two records are comparable only when this matches. It hashes the model content, the decoded PCM, the requested backend, the thread count, and the run count. |

Pass `--assert-comparison-key <hex>` on every run after the first and a
mismatched model, clip, backend, or thread count fails loudly instead of quietly
producing a number that looks comparable and isn't.

## The preview preemption command

`--stream-model` selects the second question and changes the record schema to
`epicenter.preview-preemption/1`. `--stream-model` is model B, the preview
candidate used for the gating same-model revoke and batch proof. `--model` is
model A for the non-gating dual-residency study. Both model paths and `--audio`
are required.

```sh
TRANSCRIBE_CMAKE_ARGS="-DGGML_NATIVE=OFF" \
  CARGO_TARGET_DIR=target-metal \
  cargo build --release --features static-metal

./target-metal/release/backend-latency \
  --model /path/to/whisper-tiny-Q8_0.gguf \
  --stream-model /path/to/parakeet-unified-en-0.6b-Q8_0.gguf \
  --audio /path/to/speech_15s_16k_mono.wav \
  --runs 5 --chunk-ms 320 --stream-minutes 2 \
  --label "apple-silicon preview smoke"
```

The default 320 ms chunk is 5,120 samples at the required 16 kHz. Chunks are
fed back-to-back without artificial sleeping. This measures compute capacity:
whether feed plus finalize can keep up with incoming live audio. It does not
simulate wall-clock realtime playback.

The default two-minute long-stream leg is the reduced smoke mode. Run the
precommitted survival gate with `--stream-minutes 20`. The harness loops the
supplied clip to reach that duration. Looped audio establishes resource
behavior, stream survival, and feed-latency drift; it does not establish
transcription quality on natural 20-minute speech. The record always reports
the requested and actual audio duration.

## Read these fields before any streaming number

| Field | Why it decides admissibility |
| --- | --- |
| `build.isa_pinned` | The same shippability check as the batch record. |
| `runtime.device_count` | The same registered-backend check as the batch record. |
| `comparison_key` | A streaming key hashes both model contents, decoded PCM, requested backend, thread count, run count, chunk size, and requested stream duration. Two streaming records are comparable only when this matches. |
| `measurement.capability.supports_streaming` | `false` ends the proposal before timing can make it look attractive. |
| `measurement.capability.supports_cancellation` | `false` means forced preemption is unsupported and the worst-case gate fails cleanly. |
| `measurement.capability.max_audio_ms` | Model limit; `0` means no practical model-level limit. |
| `measurement.capability.effective_max_audio_ms` | Effective session/stream limit after options are applied. |
| `measurement.preemption.cooperative_between_feeds.signal_to_lease_free_ms` | Request-to-free time when the host stops feeding and resets the non-authoritative stream. |
| `measurement.preemption.forced_mid_feed.signal_to_lease_free_ms` | Worst-case request-to-free time when a cancel token interrupts an in-flight feed. |
| `measurement.preemption.*.same_model_batch_after_revocation.outcome` | Must be `succeeded`; this is the proof that timing ended with a genuinely free lease. |
| `measurement.preemption.*.rearm.reset_plus_stream_to_text_ms` | Reset plus fresh stream-to-text cost after revocation. |
| `measurement.long_stream.survived` | Must be true at 20 minutes; early offset and error remain in the record otherwise. |
| `measurement.long_stream.buckets` | Per-minute feed p50/p95/max and memory snapshots expose drift and growth. |
| `measurement.residency.instrument` | Names the RSS and device-memory instruments. On macOS it states explicitly that Metal unified memory may not be fully attributed to RSS. |
| `measurement.concurrency.same_model_b.outcome` | Must be `busy`; otherwise the harness did not prove it held the stream lease. |
| `measurement.concurrency.cross_model_a.outcome` | Non-gating optimization: success means dual residency can avoid revocation in the common case. |

Residency is sampled before either load, after model A, after model B, while the
stream is active, and after finalize. macOS RSS comes from
`ps -o rss= -p <pid>` (KiB converted to bytes); Linux reads resident pages from
`/proc/self/statm` and multiplies by `getconf PAGESIZE`.
`Model::device().memory_free` supplies the live backend snapshot for each loaded
model. Metal uses unified memory, so GPU allocations may not be fully attributed
to process RSS; read both instruments and do not add them as though they were
disjoint pools.

If the operating environment refuses the RSS instrument, snapshots retain
`rss_bytes: null` plus `rss_error` and the other measurements continue. The
memory-growth gate is then UNRUN, not silently passed and not a harness crash.

The short stream record reports every `feed()` latency plus p50, nearest-rank
p95, and max; `stream_compute_rtf` is summed feed and finalize compute divided
by clip duration. Time to first committed text is reported in both audio
consumed and wall-clock milliseconds. The final committed text and digest make
an empty or degenerate result visible.

Preemption reports two paths. Cooperative revocation uses `Stream::reset()`
after the current feed returns because preview is non-authoritative and paying
`finalize()` decode cost would delay batch for text that will be discarded.
Forced revocation installs a `CancelToken`, signals it from a second thread
while `feed()` is in flight, then resets the failed stream. Both paths
immediately run batch on the same model as the lease proof, then reset/open/feed
a fresh stream until it produces text to price re-arm.

There is an API observability defect in transcribe-cpp 0.1.2:
`Session::was_aborted()` cannot be called while `Stream` holds its mutable
session borrow, but dropping or resetting the stream clears the native
per-stream flag. The harness therefore reports the direct `Error::Aborted`
outcome and leaves `session_was_aborted` null with an explanation. It does not
turn an unobservable flag into a guessed boolean.

`supports_streaming == false` is a clean successful record:
`preview_available` is false, stream and concurrency results are null, and
`failure` remains null. It means the candidate cannot provide preview; it does
not mean the harness crashed. Actual instrument, stream begin/feed, or
concurrency failures retain the common `{ "stage", "message" }` failure shape
and exit non-zero.

## The ISA trap, which is the real finding here

A naive static build of this proposal does not measure a shippable binary.

`transcribe-cpp-sys` only forces `GGML_NATIVE=OFF` in the `dynamic-backends`
posture (`CMakeLists.txt:387`), because ggml hard-errors on native tuning
combined with feature-scored modules
(`ggml/src/ggml-cpu/CMakeLists.txt:374`). A static build gets no such treatment:
ggml defaults `GGML_NATIVE_DEFAULT=ON` whenever it is not cross-compiling and
`SOURCE_DATE_EPOCH` is unset (`ggml/CMakeLists.txt:105-123`), so `cargo build
--features static-cpu` with no environment produces a build tuned to whichever
machine ran it. Both toolchains have the hazard, by different mechanisms:

- **GNU/Clang** (Linux, macOS): `ggml/src/ggml-cpu/CMakeLists.txt:305-306`
  appends a literal `-march=native`.
- **MSVC**: `ggml/src/ggml-cpu/CMakeLists.txt:247-249` runs
  `FindSIMD.cmake` to detect the build host's instruction set at configure time.

Either way the result is tuned to the builder and can fault on an older CPU. The
dynamic Vulkan posture it would be compared against is `GGML_NATIVE=OFF` by
force. **Comparing them unpinned compares two different questions.**

There is a second-order trap in the same mechanism: `GGML_NATIVE=ON` also drives
`INS_ENB=OFF` (`ggml/CMakeLists.txt:140-145`), which turns every per-tier option
default off. So native tuning does not supplement the tier flags, it replaces
them, and a half-pinned configuration can end up with neither.

So every static build here passes `TRANSCRIBE_CMAKE_ARGS`, which the sys crate
forwards verbatim to CMake, and the harness records the string and whether it
disables native tuning at all.

**On Apple**, `-DGGML_NATIVE=OFF` is enough. Apple Silicon is uniform enough
that the floor is not contested.

**On x86_64 with GNU/Clang** (Linux), name the floor explicitly rather than
inheriting it:

```sh
TRANSCRIBE_CMAKE_ARGS="-DTRANSCRIBE_X86_CONSERVATIVE=ON \
  -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON \
  -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON"
```

**On x86_64 with MSVC** (Windows), the tier list is shorter, because MSVC selects
one `/arch:` level from an `elseif` chain and `/arch:AVX2` already implies FMA and
F16C (`ggml/src/ggml-cpu/CMakeLists.txt:287-289`). `GGML_FMA` and `GGML_F16C` are
not even declared as options under MSVC (`ggml/CMakeLists.txt:164-166`), so
passing them is inert noise:

```
-DTRANSCRIBE_X86_CONSERVATIVE=ON -DGGML_AVX2=ON -DGGML_BMI2=ON
```

`TRANSCRIBE_X86_CONSERVATIVE=ON` defaults `GGML_NATIVE` and every x86 SIMD tier
to OFF (`CMakeLists.txt:290-298`), and it is a default rather than a clamp: the
explicit `-DGGML_*=ON` arguments reach the CMake command line through the sys
crate's escape hatch (`bindings/rust/sys/build.rs:190-197`), land in the cache
before `CMakeLists.txt` is processed, and so survive the block's
`if(NOT DEFINED CACHE{...})` guard. The result is an AVX2-era floor stated in one
place, which matches the promise Epicenter has not made (support for pre-AVX2 x64
CPUs). Bare `-DGGML_NATIVE=OFF` also produces an AVX2-ish floor, because
`INS_ENB` then flips ON and ggml enables its per-tier defaults, but it produces it
by inheritance. For a release posture, say it.

**The floor is a real cost of the collapse, and it is enforced, not merely
conventional.** `GGML_CPU_ALL_VARIANTS` (runtime-scored per-ISA CPU modules)
fatals without `GGML_BACKEND_DL` (`ggml/src/CMakeLists.txt:371-373`), and
`GGML_BACKEND_DL` fatals without `BUILD_SHARED_LIBS`
(`ggml/src/CMakeLists.txt:188-189`). Two hard errors in a chain: a static build
*cannot* have runtime ISA selection and must ship exactly one floor for every
machine. That is the promise being refused. To price it, build `static-cpu` twice
on the same host with different floors and compare:

```sh
# AVX2 floor, the proposed release posture
TRANSCRIBE_CMAKE_ARGS="-DTRANSCRIBE_X86_CONSERVATIVE=ON -DGGML_SSE42=ON -DGGML_AVX=ON \
  -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON" \
  CARGO_TARGET_DIR=target-avx2 cargo build --release --features static-cpu

# Baseline x86-64, what the conservative switch alone gives you
TRANSCRIBE_CMAKE_ARGS="-DTRANSCRIBE_X86_CONSERVATIVE=ON" \
  CARGO_TARGET_DIR=target-baseline cargo build --release --features static-cpu
```

## The three postures

Exactly one must be selected. There is no default, because a result whose
posture was picked up by accident is the mistake this harness exists to prevent;
selecting two is a compile error.

| Feature | What it builds | Where it builds |
| --- | --- | --- |
| `static-cpu` | static link, CPU only. The proposed Linux/Windows posture. | everywhere |
| `static-metal` | static link, Metal plus the CPU floor. The proposed and current Apple posture. | Apple only |
| `dynamic-vulkan` | shared link, loadable backend modules, Vulkan. **The current Linux and x86_64 Windows posture.** | Linux, Windows x86_64 |

Use a separate `CARGO_TARGET_DIR` per posture so switching does not force a full
native rebuild each time. `dynamic-vulkan` fails at CMake configure on macOS
(`Could NOT find Vulkan`), which is correct: the comparison it belongs to only
exists on Linux and Windows.

## Native runner commands

Both legs on one machine, same inputs, guarded against accidental mismatch.

### Linux x86_64

Needs a Vulkan SDK or `libvulkan-dev` plus `glslc` for the dynamic leg only.

```sh
cd apps/epicenter/bench/backend-latency
MODEL=/path/to/whisper-small-Q4_K_M.gguf
AUDIO=/path/to/speech_15s_16k_mono.wav
FLOOR="-DTRANSCRIBE_X86_CONSERVATIVE=ON -DGGML_SSE42=ON -DGGML_AVX=ON \
  -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON"

# Leg 1: the proposal.
TRANSCRIBE_CMAKE_ARGS="$FLOOR" CARGO_TARGET_DIR=target-cpu \
  cargo build --release --features static-cpu
./target-cpu/release/backend-latency --model "$MODEL" --audio "$AUDIO" \
  --runs 5 --label "$(uname -sm) static-cpu" --json results.jsonl

# Note the comparison_key it printed, then require it for every later run.
KEY=$(tail -1 results.jsonl | python3 -c 'import json,sys;print(json.load(sys.stdin)["comparison_key"])')

# Leg 2: what ships today.
TRANSCRIBE_CMAKE_ARGS="$FLOOR" CARGO_TARGET_DIR=target-vulkan \
  cargo build --release --no-default-features --features dynamic-vulkan
./target-vulkan/release/backend-latency --model "$MODEL" --audio "$AUDIO" \
  --runs 5 --label "$(uname -sm) dynamic-vulkan" --json results.jsonl \
  --assert-comparison-key "$KEY"
```

### Windows x86_64 (PowerShell)

The dynamic leg additionally needs SPIRV-Headers through vcpkg on
`CMAKE_PREFIX_PATH`; the production manifest documents the same requirement.

```powershell
cd apps\epicenter\bench\backend-latency
$Model = "C:\models\whisper-small-Q4_K_M.gguf"
$Audio = "C:\audio\speech_15s_16k_mono.wav"
# MSVC picks one /arch: level and AVX2 already implies FMA and F16C, so the
# tier list is shorter here than on Linux. See the ISA section.
$Floor  = "-DTRANSCRIBE_X86_CONSERVATIVE=ON -DGGML_AVX2=ON -DGGML_BMI2=ON"

$env:TRANSCRIBE_CMAKE_ARGS = $Floor
$env:CARGO_TARGET_DIR = "target-cpu"
cargo build --release --features static-cpu
.\target-cpu\release\backend-latency.exe --model $Model --audio $Audio `
  --runs 5 --label "windows-x64 static-cpu" --json results.jsonl

$Key = (Get-Content results.jsonl -Tail 1 | ConvertFrom-Json).comparison_key

$env:CARGO_TARGET_DIR = "target-vulkan"
cargo build --release --no-default-features --features dynamic-vulkan
.\target-vulkan\release\backend-latency.exe --model $Model --audio $Audio `
  --runs 5 --label "windows-x64 dynamic-vulkan" --json results.jsonl `
  --assert-comparison-key $Key
```

No installer, no bundle, and no Tauri build is involved in either leg. That is
deliberate: this measures inference, and the packaging consequences of the two
postures are already known from `src-tauri/build.rs`.

## Inputs

**Model.** Any GGUF the catalog lists. The decision case is **Whisper Small
Q4_K_M** (`handy-computer/whisper-small-gguf`), because it is the heaviest
default-plausible model, and **Parakeet TDT 0.6B v3 Q4_K_M**
(`handy-computer/parakeet-tdt-0.6b-v3-gguf`).

**Audio.** 16000 Hz mono WAV, 16-bit int or 32-bit float. Anything else is
refused rather than converted: a resampler inside the measurement means every
posture comparison silently also compares whatever the resampler did.

Supply real speech. The repo's only audio fixtures are 2-second 440 Hz sine
tones for the decode tests, and they are useless here: a tone produces almost no
tokens, so decode cost collapses and the measurement flatters whichever posture
you ran. Convert a real recording:

```sh
ffmpeg -i recording.m4a -ac 1 -ar 16000 -c:a pcm_s16le speech_15s_16k_mono.wav
```

Use one ~15 s clip and one ~60 s clip. Both matter because the two model
families scale differently, which is the next section.

## The falsifier, and where its stated form is misleading

The proposal's stated bar: **on ordinary x64 Linux/Windows hardware, the warm
median for 15 s of audio must be at most 3 seconds.** Keep that as the go/no-go.
Three corrections to how it gets read:

**1. Never compare RTF across clip lengths for Whisper.** Whisper pads to a
fixed 30 s window, so a 15 s clip and a 29 s clip cost the same encode. The bar
is really "one 30 s-window encode plus ~15 s of decode ≤ 3 s", and the same
binary will post a roughly 2x better RTF at 30 s than at 15 s while being
identically fast. Parakeet is duration-proportional and does not have this
shape. State the bar per model family; the `comparison_key` enforces the rest.

**2. The absolute bar alone cannot decide the collapse. The same-machine ratio
decides it.** What dynamic Vulkan costs is concrete: staged runtime libraries,
per-platform installer mappings, an rpath, a vcpkg dependency on Windows, and a
zero-registered-devices failure mode that yields no transcription at all. What
it buys is only whatever Vulkan actually delivers on the hardware users have. So
run both legs and read them together:

- static CPU ≤ 3 s **and** within ~2x of dynamic Vulkan → collapse is earned
  outright.
- static CPU ≤ 3 s but dynamic Vulkan is much faster → a real judgment call, not
  a falsification. Decide against the deletion, not against the number.
- static CPU > 3 s → the proposal is falsified for that model on that class of
  machine. Narrow the default model before reopening Vulkan.

**3. Say out loud what 3 s concedes.** ADR-0016 measured warm inference at about
60 ms per second of audio (Parakeet, Apple Silicon) and concluded the ~1 s cold
load was the only thing worth optimizing. 60 ms/s × 15 s is about 0.9 s, so a
3 s x64 bar accepts roughly a 3x regression against today's Apple experience.
That is probably the right trade, since prewarm already hides the load that ADR
called dominant, but it should be an accepted cost written down, not a surprise
found later.

## Preview preemption verdict: NOT EARNED

**Live preview is not implemented.** Four of the five gating criteria cleared
comfortably. The fifth did not clear, and the way it failed is the finding.

All runs: M4 Max, `-DGGML_NATIVE=OFF`, 16 kHz mono real speech (11.5 s, looped
for the long-stream leg). Preview candidate is
**parakeet-unified-en-0.6b Q8_0**; model A for the residency study is
whisper-tiny Q8_0. Whisper Small Q4_K_M and Parakeet TDT 0.6B v3 Q4_K_M are
still absent from the local cache, so this is one candidate, not the catalog.

| Gate | Bound | Measured | |
| --- | --- | --- | --- |
| 1 `supports_streaming` | true | true, and `Feature::Cancellation` also true | PASS |
| 2 revoke to lease-free | <= 250 ms, batch after must succeed | cooperative 39-88 ms, forced 39-98 ms; forced returns `Error::Aborted`; same-model batch immediately after every revocation succeeded (211-403 ms), never `Busy` | PASS |
| 3 re-arm to preview text | <= 1000 ms | 39-97 ms | PASS |
| 4 20-minute survival | reaches target, RSS growth <= 256 MiB, last-minute p95 <= 2x first | reached 1,200,000 ms and finalized; RSS 1170 -> 1334 MiB, growth **164.5 MiB**; p95 133.2 -> 133.4 ms, ratio **1.00** | PASS |
| 5 RTF and first text | RTF <= 0.5 and TTFT < half the candidate's warm batch median | RTF 0.108-0.224, comfortably clear. TTFT **straddles the threshold** | **NOT CLEARED** |

Gate 5, every leg:

| Leg | TTFT | half warm median | |
| --- | --- | --- | --- |
| static-cpu 20 min, machine busy | 115.0 ms | 105.3 ms | FAIL |
| static-cpu 2 min smoke | 109.0 ms | 107.0 ms | FAIL |
| static-cpu 20 min, machine quiet | 95.8 ms | 105.3 ms | PASS |
| static-metal 2 min smoke | 159.7 ms | 179.3 ms | PASS |

Two pass, two fail, every one of them within 10% of the line, on one machine
with identical inputs. A gate that flips on run-to-run noise has not been
cleared, and the direction of the flip is the wrong one: the failures are the
runs where the machine was busy, which is the condition a real dictation
competes under. The quiet run is the optimistic case, not the representative
one.

The one comfortable pass is the least trustworthy leg. In the `static-metal`
build the runtime registered a `metal` device and then loaded the model with
`model_backend: "CPU"` anyway, so Parakeet never ran on the GPU. That leg passes
only because its *batch* baseline is worse (358 ms against 210 ms), which raises
the threshold it is measured against. Preview did not get faster; the thing it
is compared to got slower.

Read plainly: on a short dictation the authoritative batch result already
arrives in about 210 ms, and a preview that shows its first committed text at
about 100 ms is not buying a user anything they would notice. Preview's value
should grow with recording length, and this gate deliberately compares against
the same clip's batch median, so a longer clip would be a different and more
favorable question. **That reopening is legitimate, but it must be precommitted
and run, not decided here after seeing these numbers.** Nothing in this table
licenses building preview.

### Non-gating optimization study

Dual residency works and is not what preview rests on. Both models stayed
resident; the second cost **1.03 GiB** of RSS. With a stream in flight on model
B, a batch on model B correctly returned `Error::Busy` (which is what proves the
lease is real), and a batch on model A **succeeded**, at 1.6-1.9x its
uncontended latency. So the escape does exist, and it is an optimization on top
of a preview that has not yet earned its place, not a reason to build one.

### Instrument note

The RSS figures come from a run outside the agent sandbox. `ps` is blocked
inside it, so runs made there report `rss_bytes: null` with an explicit
`rss_error`, and their memory columns establish nothing. Check that field before
quoting any memory number. Device `memory_free` is useless for this on a CPU
backend: it reports total system RAM and therefore a delta of zero.

## Measurements taken so far

Apple Silicon only, and therefore **methodology proof, not evidence for the
Linux/Windows CPU question.** Metal is not Vulkan, an M4 Max CPU is not an
ordinary x64 CPU, and the audio was macOS `say` text-to-speech, which is cleaner
and easier to decode than real dictation. Quoting these as latency evidence
would be wrong.

M4 Max, 16 threads, `-DGGML_NATIVE=OFF`, 5 warm runs, TTS audio:

| Posture | Model | Clip | Cold load | Cold run | Warm median |
| --- | --- | --- | --- | --- | --- |
| static-cpu | whisper-tiny Q8_0 | 15 s | 31 ms | 135 ms | 114 ms |
| static-metal | whisper-tiny Q8_0 | 15 s | 30 ms | 484 ms | 73 ms |
| static-cpu | parakeet-unified-en-0.6b Q8_0 | 15 s | 198 ms | 409 ms | 353 ms |
| static-metal | parakeet-unified-en-0.6b Q8_0 | 15 s | 181 ms | 387 ms | 95 ms |
| static-cpu | parakeet-unified-en-0.6b Q8_0 | 60 s | 202 ms | 1566 ms | 1543 ms |
| static-metal | parakeet-unified-en-0.6b Q8_0 | 60 s | 163 ms | 420 ms | 402 ms |

What this does and does not establish:

- **Establishes:** the harness measures real inference (non-empty transcripts,
  populated library stage timings), both static postures build and run, the
  comparison guard accepts matching inputs and rejects mismatched ones, and
  Metal is roughly 3.7x faster than CPU on this machine for Parakeet.
- **Does not establish** anything about the 3 s bar. Neither model here is the
  decision case, and neither is Whisper Small Q4_K_M, which is absent from the
  local Hugging Face cache (only a `refs/main` entry, no blob) and needs a
  download before the real runs.

Still outstanding: Whisper Small Q4_K_M and Parakeet TDT 0.6B v3 Q4_K_M model
files, real dictation audio at 15 s and 60 s, and one x64 Linux and one x64
Windows machine to run both legs on.
