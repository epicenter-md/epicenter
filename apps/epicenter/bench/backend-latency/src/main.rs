//! Does static CPU transcription clear the felt-latency bar on ordinary x64
//! hardware, or does Epicenter still need the dynamic Vulkan posture?
//!
//! One measurement, run once per build posture, on identical inputs. The output
//! is one JSON line carrying the answer and everything needed to judge whether
//! the answer is admissible: how the binary was linked, whether its ISA floor
//! was pinned or tuned to the build host, which compute devices actually
//! registered, and a digest of the exact model and clip that produced it.
//!
//! It measures the real path. `Model::load_with` then a fresh `Session` per run
//! then `Session::run` is what `model_cache.rs` does for every transcription,
//! including holding the model resident between runs the way `ModelCache` does,
//! so cold and warm here mean what they mean in the app (ADR-0016).
//!
//! Not a Criterion benchmark. Criterion's value is resolving small differences
//! by resampling many cheap iterations; here one iteration is seconds long, the
//! interesting split is a single cold event versus the warm steady state, and
//! the dominant variable is the build posture rather than statistical noise.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use serde_json::{json, Map, Value};
use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, SessionOptions};

mod inputs;
mod posture;

#[cfg(not(any(
    feature = "static-cpu",
    feature = "static-metal",
    feature = "dynamic-vulkan"
)))]
compile_error!(
    "pick exactly one posture: --features static-cpu | static-metal | dynamic-vulkan. \
     There is no default on purpose: a result whose posture was chosen by accident \
     is the mistake this harness exists to prevent."
);

#[cfg(any(
    all(feature = "static-cpu", feature = "static-metal"),
    all(feature = "static-cpu", feature = "dynamic-vulkan"),
    all(feature = "static-metal", feature = "dynamic-vulkan")
))]
compile_error!("the postures are mutually exclusive; pass --no-default-features and select one");

const SCHEMA: &str = "epicenter.backend-latency/1";

const USAGE: &str = "\
backend-latency: latency falsifier for Epicenter's transcription backend collapse

USAGE
  backend-latency --model <GGUF> --audio <WAV> [options]
  backend-latency --probe

  Emits one JSON object per invocation on stdout (JSONL when appended). Exits
  non-zero on any failure, having emitted a record whose `failure` field says
  what went wrong and at which stage.

REQUIRED (unless --probe)
  --model <PATH>     GGUF model file, e.g. whisper-small-Q4_K_M.gguf
  --audio <PATH>     16000 Hz mono WAV. Not resampled; mismatches are refused
                     so no converter sits inside the measurement.

OPTIONS
  --runs <N>         warm runs after the cold pair (default 5)
  --backend <NAME>   auto | cpu | cpu-accel | metal | vulkan | cuda
                     (default auto, which is what the collapse proposes)
  --threads <N>      CPU threads; 0 uses the library default (default 0)
  --label <TEXT>     free text carried into the record, e.g. a machine name
  --json <PATH>      also append the record to this file
  --assert-comparison-key <HEX>
                     fail unless the inputs and settings hash to this key. Use
                     it across a posture matrix so a mismatched model, clip,
                     backend, or thread count fails loudly instead of quietly
                     producing an incomparable number.
  --probe            report build posture and registered devices, load nothing
  --help

READING THE RESULT
  build.isa_pinned   false on x86 means ggml compiled -march=native and the
                     number describes this build host, not a shippable binary.
  runtime.device_count
                     zero means the backends never registered; the latency
                     figure below it is meaningless.
  measurement.warm_median_rtf
                     warm median divided by audio duration. Whisper pads to a
                     fixed 30 s window, so its RTF on clips under 30 s is
                     pessimistic by construction; compare RTF only between runs
                     with the same comparison_key.
";

struct Args {
    mode: Mode,
    runs: usize,
    backend: Backend,
    threads: i32,
    label: Option<String>,
    json: Option<PathBuf>,
    expect_key: Option<String>,
}

/// What this invocation is for. An enum rather than two `Option`s plus a `bool`
/// so "measuring without inputs" is unrepresentable instead of a runtime check:
/// argument parsing is the one place that can fail on a missing path.
enum Mode {
    /// Report the posture and the registered devices. Loads nothing.
    Probe,
    Measure {
        model: PathBuf,
        audio: PathBuf,
    },
}

/// A refusal, tagged with the stage it happened in so a reader knows whether the
/// posture, the inputs, or the inference is at fault.
struct Failure {
    stage: &'static str,
    message: String,
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.is_empty() || raw.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let args = match parse_args(&raw) {
        Ok(args) => args,
        Err(message) => {
            // A usage error is the operator's problem, not a measurement, so it
            // stays on stderr and never pollutes the JSONL stream.
            eprintln!("backend-latency: {message}\n\nRun --help for usage.");
            return ExitCode::FAILURE;
        }
    };

    let mut record = Map::new();
    record.insert("schema".into(), json!(SCHEMA));
    record.insert("label".into(), json!(args.label));
    record.insert("build".into(), posture::build());

    let outcome = observe(&args, &mut record);

    let failed = match outcome {
        Ok(()) => {
            record.insert("failure".into(), Value::Null);
            false
        }
        Err(failure) => {
            record.insert(
                "failure".into(),
                json!({ "stage": failure.stage, "message": failure.message }),
            );
            true
        }
    };

    emit(&Value::Object(record), args.json.as_deref());
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// Establish the posture, then either stop there (`--probe`) or measure.
fn observe(args: &Args, record: &mut Map<String, Value>) -> Result<(), Failure> {
    posture::initialize_backends().map_err(|message| Failure {
        stage: "backends",
        message,
    })?;
    record.insert(
        "runtime".into(),
        posture::runtime(args.backend, args.threads),
    );

    let Mode::Measure { model, audio } = &args.mode else {
        record.insert("probe".into(), json!(true));
        return Ok(());
    };

    // Ask the library whether the request is satisfiable before spending a model
    // load on it. This is the probe that turns `--backend vulkan` on a machine
    // or build without Vulkan into a clear refusal rather than a failed load.
    if !transcribe_cpp::backend_available(args.backend) {
        return Err(Failure {
            stage: "backends",
            message: format!(
                "backend {:?} is not available in the {} posture on this machine; \
                 registered devices: {}",
                posture::backend_name(args.backend),
                posture::POSTURE,
                transcribe_cpp::devices()
                    .iter()
                    .map(|device| format!("{} ({})", device.name, device.kind))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }

    let (model_path, audio_path) = (model.as_path(), audio.as_path());
    let (model_digest, model_bytes) =
        inputs::digest_file(model_path).map_err(|message| Failure {
            stage: "inputs",
            message,
        })?;
    let audio = inputs::load_wav(audio_path).map_err(|message| Failure {
        stage: "inputs",
        message,
    })?;

    record.insert(
        "model".into(),
        json!({
            "path": model_path.display().to_string(),
            "file_bytes": model_bytes,
            "digest64": model_digest,
        }),
    );
    record.insert(
        "audio".into(),
        json!({
            "path": audio_path.display().to_string(),
            "sample_rate": audio.sample_rate,
            "channels": audio.channels,
            "frames": audio.samples.len(),
            "duration_s": audio.duration_s,
            "digest64": audio.digest,
        }),
    );

    // Everything a comparison must hold constant, in one field. Two records are
    // comparable exactly when their keys match; the posture is deliberately
    // excluded, because differing postures is the entire point.
    let comparison_key = comparison_key(&model_digest, &audio.digest, args);
    record.insert("comparison_key".into(), json!(comparison_key));
    if let Some(expected) = &args.expect_key {
        if expected != &comparison_key {
            return Err(Failure {
                stage: "comparison",
                message: format!(
                    "comparison key {comparison_key} does not match the required \
                     {expected}; the model, clip, backend, thread count, or run \
                     count differs from the rest of this matrix"
                ),
            });
        }
    }

    record.insert("measurement".into(), measure(model_path, &audio, args)?);
    Ok(())
}

/// One cold load, one cold run, then `runs` warm runs against the resident model.
///
/// Mirrors the app: the model stays resident between transcriptions (`ModelCache`)
/// while each transcription opens its own session (`run_gguf`). So the cold pair
/// is what a first dictation after eviction pays, and the warm median is what
/// prewarm is meant to leave you with.
fn measure(model_path: &Path, audio: &inputs::Audio, args: &Args) -> Result<Value, Failure> {
    let options = ModelOptions {
        backend: args.backend,
        gpu_device: 0,
    };

    let load_start = Instant::now();
    let model = Model::load_with(model_path, &options).map_err(|error| Failure {
        stage: "model-load",
        message: format!("load {}: {error}", model_path.display()),
    })?;
    let cold_load_ms = load_start.elapsed().as_secs_f64() * 1000.0;

    let session_options = SessionOptions {
        n_threads: args.threads,
        ..Default::default()
    };

    let mut samples = Vec::with_capacity(args.runs + 1);
    let mut last = None;
    for _ in 0..=args.runs {
        let started = Instant::now();
        let mut session = model
            .session_with(&session_options)
            .map_err(|error| Failure {
                stage: "session",
                message: format!("open session: {error}"),
            })?;
        let transcript = session
            .run(&audio.samples, &RunOptions::default())
            .map_err(|error| Failure {
                stage: "inference",
                message: format!("run inference: {error}"),
            })?;
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        last = Some(transcript);
    }

    // The first element is the cold run: the load above populated nothing but the
    // weights, so first inference still pays graph and kernel warmup.
    let cold_run_ms = samples[0];
    let warm = &samples[1..];

    let transcript = last.expect("at least one run always executes");
    let mut text_digest = inputs::Digest::new();
    text_digest.write(transcript.text.as_bytes());

    Ok(json!({
        "cold_load_ms": cold_load_ms,
        "cold_run_ms": cold_run_ms,
        "cold_total_ms": cold_load_ms + cold_run_ms,
        "warm_runs": warm.len(),
        "warm_run_ms": warm,
        "warm_median_ms": median(warm),
        "warm_min_ms": warm.iter().copied().fold(f64::INFINITY, f64::min),
        "warm_max_ms": warm.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "warm_mean_ms": mean(warm),
        "warm_median_rtf": median(warm).map(|ms| ms / 1000.0 / audio.duration_s),
        "model_backend": model.backend(),
        "model_arch": model.arch(),
        "model_variant": model.variant(),
        // transcribe.cpp's own stage split for the final run, so an anomalous
        // total can be attributed to mel, encode, or decode rather than guessed at.
        "last_run_library_timings": {
            "load_ms": transcript.timings.load_ms,
            "mel_ms": transcript.timings.mel_ms,
            "encode_ms": transcript.timings.encode_ms,
            "decode_ms": transcript.timings.decode_ms,
        },
        // Proof the run actually transcribed something. An empty transcript means
        // the decoder produced no tokens, which is fast and worthless.
        "transcript_chars": transcript.text.chars().count(),
        "transcript_digest64": text_digest.hex(),
        "transcript_head": transcript.text.chars().take(160).collect::<String>(),
    }))
}

/// Median of an odd or even sample, `None` when there were no warm runs.
fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    Some(if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    })
}

fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

fn comparison_key(model_digest: &str, audio_digest: &str, args: &Args) -> String {
    let mut digest = inputs::Digest::new();
    for part in [
        model_digest,
        audio_digest,
        posture::backend_name(args.backend),
        &args.threads.to_string(),
        &args.runs.to_string(),
    ] {
        digest.write(part.as_bytes());
        digest.write(b"\0");
    }
    digest.hex()
}

/// One line to stdout, and the same line appended to `--json` when given.
/// Appending rather than truncating is what makes a posture matrix accumulate
/// into one comparable file.
fn emit(record: &Value, json_path: Option<&Path>) {
    let line = record.to_string();
    println!("{line}");
    if let Some(path) = json_path {
        use std::io::Write;
        let appended = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| writeln!(file, "{line}"));
        if let Err(error) = appended {
            eprintln!(
                "backend-latency: could not append to {}: {error}",
                path.display()
            );
        }
    }
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut args = Args {
        // Replaced below once the flags have been read; a bare invocation is
        // already handled as a usage error by the caller.
        mode: Mode::Probe,
        runs: 5,
        backend: Backend::Auto,
        threads: 0,
        label: None,
        json: None,
        expect_key: None,
    };
    let mut model = None;
    let mut audio = None;
    let mut probe = false;

    let mut index = 0;
    while index < raw.len() {
        let flag = raw[index].as_str();
        // Every flag but --probe takes a value; pull it here so each arm below
        // reads as one assignment.
        let value = || -> Result<&str, String> {
            raw.get(index + 1)
                .map(String::as_str)
                .filter(|next| !next.starts_with("--"))
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--probe" => {
                probe = true;
                index += 1;
                continue;
            }
            "--model" => model = Some(PathBuf::from(value()?)),
            "--audio" => audio = Some(PathBuf::from(value()?)),
            "--label" => args.label = Some(value()?.to_string()),
            "--json" => args.json = Some(PathBuf::from(value()?)),
            "--assert-comparison-key" => args.expect_key = Some(value()?.to_string()),
            "--backend" => args.backend = posture::parse_backend(value()?)?,
            "--runs" => {
                let text = value()?;
                args.runs = text
                    .parse()
                    .map_err(|_| format!("--runs expects a non-negative integer, got {text:?}"))?;
            }
            "--threads" => {
                let text = value()?;
                args.threads = text
                    .parse()
                    .map_err(|_| format!("--threads expects an integer, got {text:?}"))?;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
        index += 2;
    }

    // The one place a missing input can be reported, so nothing downstream has
    // to re-check it.
    args.mode = match (probe, model, audio) {
        (true, _, _) => Mode::Probe,
        (false, Some(model), Some(audio)) => Mode::Measure { model, audio },
        (false, _, _) => {
            return Err("--model and --audio are both required unless --probe is passed".into())
        }
    };
    Ok(args)
}
