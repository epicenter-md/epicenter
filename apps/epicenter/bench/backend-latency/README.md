# backend-latency

A falsifier for one proposal: collapse Epicenter's transcription backend to
**one static dependency, `Backend::Auto`, Metal on Apple, CPU everywhere else**,
and delete the dynamic-backends plus Vulkan posture that Linux and x86_64
Windows ship today.

That collapse is only admissible if plain CPU inference is already fast enough
on ordinary x64 hardware that nobody can feel the difference. This crate
measures that, once per build posture, on identical inputs.

It is throwaway. It is not wired into the app build, CI, or the workspace, and
nothing in `apps/epicenter/src-tauri` can reach it. Delete the directory when
the decision is recorded.

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

## Read these three fields before any latency number

| Field | Why it decides admissibility |
| --- | --- |
| `build.isa_pinned` | `false` on x86 means ggml compiled `-march=native`. The number describes the build host, not a binary you could ship. See below. |
| `runtime.device_count` | `0` means the compute backends never registered. This is the dynamic posture's signature failure, and the latency below it is meaningless. |
| `comparison_key` | Two records are comparable only when this matches. It hashes the model content, the decoded PCM, the requested backend, the thread count, and the run count. |

Pass `--assert-comparison-key <hex>` on every run after the first and a
mismatched model, clip, backend, or thread count fails loudly instead of quietly
producing a number that looks comparable and isn't.

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
