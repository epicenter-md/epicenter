//! Falsify live preview at its real boundary: an authoritative batch must be
//! able to revoke an optional stream and acquire the same model's compute
//! lease promptly. Dual residency remains useful, but is only an optimization.

use std::path::Path;
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use transcribe_cpp::{
    Backend, CancelToken, Error, Feature, Model, ModelOptions, RunOptions, SessionOptions,
    StreamOptions, StreamUpdate,
};

use crate::inputs::{Audio, Digest};
use crate::residency;
use crate::{median, Failure};

const REVOKE_DELAY: Duration = Duration::from_millis(1);

pub struct Options {
    pub backend: Backend,
    pub threads: i32,
    pub runs: usize,
    pub chunk_ms: u32,
    pub stream_minutes: f64,
}

pub fn measure(
    model_path: &Path,
    stream_model_path: &Path,
    audio: &Audio,
    options: &Options,
) -> Result<Value, Failure> {
    let baseline = residency::sample(None, None).map_err(residency_failure)?;
    let model_options = ModelOptions {
        backend: options.backend,
        gpu_device: 0,
    };

    let model_a = Model::load_with(model_path, &model_options).map_err(|error| Failure {
        stage: "residency",
        message: format!("load model A {}: {error}", model_path.display()),
    })?;
    let after_model_a = residency::sample(Some(&model_a), None).map_err(residency_failure)?;

    let model_b = Model::load_with(stream_model_path, &model_options).map_err(|error| Failure {
        stage: "residency",
        message: format!("load model B {}: {error}", stream_model_path.display()),
    })?;
    let after_model_b =
        residency::sample(Some(&model_a), Some(&model_b)).map_err(residency_failure)?;

    let capabilities = model_b.capabilities();
    let cancellation_supported = model_b.supports(Feature::Cancellation);
    let residency_cost = residency::added_cost(&after_model_a, &after_model_b);
    let residency_record = json!({
        "study": "non-gating optimization",
        "instrument": residency::instrument(),
        "baseline": baseline,
        "after_model_a_loaded": after_model_a,
        "after_model_b_loaded": after_model_b,
        "added_cost": residency_cost,
    });

    if !capabilities.supports_streaming {
        return Ok(json!({
            "preview_available": false,
            "capability": {
                "supports_streaming": false,
                "supports_cancellation": cancellation_supported,
                "max_audio_ms": capabilities.max_audio_ms,
                "model_arch": model_b.arch(),
                "model_variant": model_b.variant(),
                "model_backend": model_b.backend(),
            },
            "residency": residency_record,
            "batch_baselines": Value::Null,
            "stream": Value::Null,
            "preemption": Value::Null,
            "long_stream": Value::Null,
            "concurrency": Value::Null,
            "unavailable_reason": "The streaming candidate reports supports_streaming=false. This is a clean capability result, not a harness failure.",
        }));
    }

    let session_options = SessionOptions {
        n_threads: options.threads,
        ..Default::default()
    };
    let model_a_batch = warm_batch(&model_a, audio, &session_options, options.runs)?;
    let model_b_batch = warm_batch(&model_b, audio, &session_options, options.runs)?;
    let chunk_samples = chunk_samples(options.chunk_ms, audio.sample_rate)?;

    let (stream_result, same_model, cross_model, while_stream_active, after_finalize) =
        concurrency_study(&model_a, &model_b, audio, &session_options, chunk_samples)?;

    let cooperative = cooperative_preemption(&model_b, audio, &session_options, chunk_samples)?;
    let forced = if cancellation_supported {
        forced_preemption(&model_b, audio, &session_options, chunk_samples)?
    } else {
        json!({
            "status": "unsupported",
            "supports_cancellation": false,
            "signal_to_lease_free_ms": Value::Null,
            "feed_outcome": Value::Null,
            "session_was_aborted": Value::Null,
            "same_model_batch_after_revocation": Value::Null,
            "rearm": Value::Null,
            "decision_note": "Feature::Cancellation is unsupported. Worst-case revocation is therefore bounded only by completion of the full in-flight feed().",
        })
    };

    let long_stream = long_stream(
        &model_b,
        audio,
        &session_options,
        chunk_samples,
        options.stream_minutes,
    )?;

    let mut residency_record = residency_record;
    residency_record["while_stream_active"] = while_stream_active;
    residency_record["after_stream_finalize"] = after_finalize;

    Ok(json!({
        "preview_available": true,
        "capability": {
            "supports_streaming": true,
            "supports_cancellation": cancellation_supported,
            "max_audio_ms": capabilities.max_audio_ms,
            "effective_max_audio_ms": long_stream["effective_max_audio_ms"],
            "model_arch": model_b.arch(),
            "model_variant": model_b.variant(),
            "model_backend": model_b.backend(),
        },
        "residency": residency_record,
        "batch_baselines": {
            "model_a_no_stream": model_a_batch,
            "model_b_streaming_candidate_no_stream": model_b_batch,
        },
        "stream": stream_result,
        "preemption": {
            "cooperative_between_feeds": cooperative,
            "forced_mid_feed": forced,
            "was_aborted_api_note": "transcribe-cpp 0.1.2 exposes was_aborted() only on Session. Stream borrows Session, while every safe release path resets the stream and clears the native flag. Error::Aborted is reported directly, but session_was_aborted is null because the flag cannot be observed through the safe Rust streaming API.",
        },
        "long_stream": long_stream,
        "concurrency": {
            "study": "non-gating optimization",
            "same_model_b": same_model,
            "cross_model_a": {
                "outcome": "succeeded",
                "latency_ms": cross_model.latency_ms,
                "transcript_digest64": digest_text(&cross_model.text),
            },
            "cross_model_no_stream_warm_median_ms": model_a_batch["warm_median_ms"],
            "cross_model_latency_ratio_vs_no_stream_warm_median":
                model_a_batch["warm_median_ms"].as_f64()
                    .map(|baseline| cross_model.latency_ms / baseline),
        },
    }))
}

fn concurrency_study(
    model_a: &Model,
    model_b: &Model,
    audio: &Audio,
    session_options: &SessionOptions,
    chunk_samples: usize,
) -> Result<(Value, Value, TimedRun, Value, Value), Failure> {
    let mut stream_session = model_b
        .session_with(session_options)
        .map_err(|error| failure("stream-begin", format!("open streaming session: {error}")))?;
    let mut same_model_session = model_b
        .session_with(session_options)
        .map_err(|error| failure("concurrency", format!("open same-model session: {error}")))?;
    let mut cross_model_session = model_a
        .session_with(session_options)
        .map_err(|error| failure("concurrency", format!("open cross-model session: {error}")))?;
    let mut stream = stream_session
        .stream(&RunOptions::default(), &StreamOptions::default())
        .map_err(|error| failure("stream-begin", format!("begin stream: {error}")))?;
    let while_active =
        residency::sample(Some(model_a), Some(model_b)).map_err(residency_failure)?;

    let same_model = match timed_run(&mut same_model_session, audio) {
        Err(Error::Busy(message)) => json!({
            "outcome": "busy",
            "busy": true,
            "message": message,
        }),
        Err(error) => {
            return Err(failure(
                "concurrency",
                format!("same-model batch returned {error:?}, not Error::Busy"),
            ));
        }
        Ok(run) => {
            return Err(failure(
                "concurrency",
                format!(
                    "same-model batch unexpectedly succeeded in {:.3} ms while streaming",
                    run.latency_ms
                ),
            ));
        }
    };

    let barrier = Arc::new(Barrier::new(2));
    let stream_started = Instant::now();
    let (feed_result, cross_outcome) = thread::scope(|scope| {
        let cross_barrier = Arc::clone(&barrier);
        let cross = scope.spawn(move || {
            cross_barrier.wait();
            timed_run(&mut cross_model_session, audio)
        });
        barrier.wait();
        let feed_result = feed_chunks(&mut stream, audio, chunk_samples, stream_started);
        (
            feed_result,
            cross
                .join()
                .expect("scoped cross-model batch thread panicked"),
        )
    });

    let stream_result = finalize_stream(&mut stream, audio, stream_started, feed_result?)?;
    let after_finalize =
        residency::sample(Some(model_a), Some(model_b)).map_err(residency_failure)?;
    let cross_run = cross_outcome.map_err(|error| {
        failure(
            "concurrency",
            format!("cross-model batch failed while model B streamed: {error}"),
        )
    })?;
    Ok((
        stream_result,
        same_model,
        cross_run,
        while_active,
        after_finalize,
    ))
}

fn cooperative_preemption(
    model: &Model,
    audio: &Audio,
    session_options: &SessionOptions,
    chunk_samples: usize,
) -> Result<Value, Failure> {
    let mut stream_session = model
        .session_with(session_options)
        .map_err(|error| failure("preemption", format!("open cooperative session: {error}")))?;
    let mut batch_session = model.session_with(session_options).map_err(|error| {
        failure(
            "preemption",
            format!("open cooperative proof session: {error}"),
        )
    })?;
    let mut stream = stream_session
        .stream(&RunOptions::default(), &StreamOptions::default())
        .map_err(|error| failure("preemption", format!("begin cooperative stream: {error}")))?;

    // Prime to the next decode-triggering feed. This keeps the measurement on
    // the real configured chunk size while making it likely that the revoke
    // signal lands during useful work rather than a cheap buffering-only feed.
    let chunks = audio.samples.chunks(chunk_samples).collect::<Vec<_>>();
    let measured_index = ((2_000 / (chunk_samples * 1_000 / audio.sample_rate as usize)).max(1))
        .min(chunks.len().saturating_sub(1));
    let mut priming_latencies = Vec::new();
    for chunk in &chunks[..measured_index] {
        let started = Instant::now();
        stream
            .feed(chunk)
            .map_err(|error| failure("preemption", format!("prime cooperative stream: {error}")))?;
        priming_latencies.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let feed_started = Instant::now();
    let feed_outcome = thread::scope(|scope| {
        scope.spawn(move || {
            thread::sleep(REVOKE_DELAY);
            let signalled = Instant::now();
            sender.send(signalled).expect("revoke receiver exists");
        });
        let result = stream.feed(chunks[measured_index]);
        let feed_finished = Instant::now();
        let signalled = receiver.recv().expect("revoke sender exists");
        (result, signalled, feed_finished)
    });
    let (feed_result, signalled, feed_finished) = feed_outcome;
    let feed_error = feed_result.err().map(|error| error.to_string());
    let reset_started = Instant::now();
    stream.reset();
    let reset_ms = reset_started.elapsed().as_secs_f64() * 1000.0;
    let lease_free = Instant::now();
    drop(stream);

    let proof = batch_proof(&mut batch_session, audio);
    let mut rearm = rearm_preview(&mut stream_session, audio, chunk_samples, "cooperative")?;
    add_reset_to_rearm(&mut rearm, reset_ms);

    Ok(json!({
        "status": "measured",
        "release_method": "Stream::reset()",
        "release_reason": "Preview is non-authoritative, so reset abandons its tail without paying finalize decoding cost.",
        "primed_audio_ms": measured_index * chunk_samples * 1000 / audio.sample_rate as usize,
        "priming_feed_latency_ms": priming_latencies,
        "measured_feed_samples": chunks[measured_index].len(),
        "revoke_signal_during_feed": signalled < feed_finished,
        "in_flight_feed_elapsed_at_signal_ms": signalled.saturating_duration_since(feed_started).as_secs_f64() * 1000.0,
        "signal_to_feed_return_ms": feed_finished.saturating_duration_since(signalled).as_secs_f64() * 1000.0,
        "signal_to_lease_free_ms": lease_free.saturating_duration_since(signalled).as_secs_f64() * 1000.0,
        "reset_ms": reset_ms,
        "feed_error": feed_error,
        "same_model_batch_after_revocation": proof,
        "rearm": rearm,
    }))
}

fn forced_preemption(
    model: &Model,
    audio: &Audio,
    session_options: &SessionOptions,
    chunk_samples: usize,
) -> Result<Value, Failure> {
    let mut stream_session = model
        .session_with(session_options)
        .map_err(|error| failure("preemption", format!("open forced session: {error}")))?;
    let token = CancelToken::new();
    stream_session.set_cancel_token(&token);
    let mut batch_session = model
        .session_with(session_options)
        .map_err(|error| failure("preemption", format!("open forced proof session: {error}")))?;
    let mut stream = stream_session
        .stream(&RunOptions::default(), &StreamOptions::default())
        .map_err(|error| failure("preemption", format!("begin forced stream: {error}")))?;

    let (sender, receiver) = mpsc::sync_channel(1);
    let canceller_token = token.clone();
    let feed_started = Instant::now();
    let (feed_result, signalled, feed_finished) = thread::scope(|scope| {
        scope.spawn(move || {
            thread::sleep(REVOKE_DELAY);
            let signalled = Instant::now();
            canceller_token.cancel();
            sender.send(signalled).expect("cancel receiver exists");
        });
        let result = stream.feed(&audio.samples);
        let feed_finished = Instant::now();
        let signalled = receiver.recv().expect("cancel sender exists");
        (result, signalled, feed_finished)
    });

    let token_observed_cancelled = token.is_cancelled();
    let (feed_outcome, feed_error) = match feed_result {
        Err(error @ Error::Aborted { .. }) => ("aborted", Some(error.to_string())),
        Err(error) => ("other_error", Some(error.to_string())),
        Ok(_) => ("completed", None),
    };
    let cancelled_error = feed_outcome == "aborted";
    let reset_started = Instant::now();
    stream.reset();
    let reset_ms = reset_started.elapsed().as_secs_f64() * 1000.0;
    let lease_free = Instant::now();
    drop(stream);

    let proof = batch_proof(&mut batch_session, audio);
    token.reset();
    let mut rearm = rearm_preview(&mut stream_session, audio, chunk_samples, "forced")?;
    add_reset_to_rearm(&mut rearm, reset_ms);
    stream_session.clear_cancel_token();

    Ok(json!({
        "status": "measured",
        "supports_cancellation": true,
        "cancel_token_is_cancelled_after_signal": token_observed_cancelled,
        "cancel_signal_during_feed": signalled < feed_finished,
        "in_flight_feed_elapsed_at_signal_ms": signalled.saturating_duration_since(feed_started).as_secs_f64() * 1000.0,
        "signal_to_feed_return_ms": feed_finished.saturating_duration_since(signalled).as_secs_f64() * 1000.0,
        "signal_to_lease_free_ms": lease_free.saturating_duration_since(signalled).as_secs_f64() * 1000.0,
        "reset_ms": reset_ms,
        "feed_outcome": feed_outcome,
        "feed_error": feed_error,
        "error_was_aborted": cancelled_error,
        "session_was_aborted": Value::Null,
        "session_was_aborted_note": "Unobservable through transcribe-cpp 0.1.2's safe streaming API: releasing Stream resets the native per-stream flag before Session::was_aborted() can be called.",
        "release_method_after_cancel": "Stream::reset()",
        "same_model_batch_after_revocation": proof,
        "rearm": rearm,
    }))
}

fn batch_proof(session: &mut transcribe_cpp::Session, audio: &Audio) -> Value {
    match timed_run(session, audio) {
        Ok(run) => json!({
            "outcome": "succeeded",
            "busy": false,
            "latency_ms": run.latency_ms,
            "transcript_digest64": digest_text(&run.text),
        }),
        Err(Error::Busy(message)) => json!({
            "outcome": "busy",
            "busy": true,
            "message": message,
        }),
        Err(error) => json!({
            "outcome": "error",
            "busy": false,
            "message": error.to_string(),
        }),
    }
}

fn rearm_preview(
    session: &mut transcribe_cpp::Session,
    audio: &Audio,
    chunk_samples: usize,
    path: &str,
) -> Result<Value, Failure> {
    let started = Instant::now();
    let mut stream = session
        .stream(&RunOptions::default(), &StreamOptions::default())
        .map_err(|error| failure("preemption", format!("re-arm after {path}: {error}")))?;
    let mut audio_consumed = 0usize;
    let mut produced = false;
    let mut feed_error = None;
    for chunk in audio.samples.chunks(chunk_samples) {
        match stream.feed(chunk) {
            Ok(_) => {
                audio_consumed += chunk.len();
                if !stream.text().full.is_empty() {
                    produced = true;
                    break;
                }
            }
            Err(error) => {
                feed_error = Some(error.to_string());
                break;
            }
        }
    }
    let to_text_ms = produced.then(|| started.elapsed().as_secs_f64() * 1000.0);
    stream.reset();
    Ok(json!({
        "stream_call_to_text_ms": to_text_ms,
        "produced_text": produced,
        "audio_consumed_ms": audio_consumed as f64 / f64::from(audio.sample_rate) * 1000.0,
        "feed_error": feed_error,
    }))
}

fn add_reset_to_rearm(rearm: &mut Value, reset_ms: f64) {
    rearm["reset_plus_stream_to_text_ms"] = rearm["stream_call_to_text_ms"]
        .as_f64()
        .map(|stream_to_text_ms| reset_ms + stream_to_text_ms)
        .into();
}

fn long_stream(
    model: &Model,
    audio: &Audio,
    session_options: &SessionOptions,
    chunk_samples: usize,
    stream_minutes: f64,
) -> Result<Value, Failure> {
    let mut session = model
        .session_with(session_options)
        .map_err(|error| failure("long-stream", format!("open session: {error}")))?;
    let effective_max_audio_ms = session
        .limits()
        .map_err(|error| failure("long-stream", format!("query session limits: {error}")))?
        .effective_max_audio_ms;
    let target_samples = (stream_minutes * 60.0 * f64::from(audio.sample_rate)).round() as usize;
    let initial_memory = residency::sample(None, Some(model)).map_err(residency_failure)?;
    let mut stream = session
        .stream(&RunOptions::default(), &StreamOptions::default())
        .map_err(|error| failure("long-stream", format!("begin stream: {error}")))?;

    let bucket_samples = audio.sample_rate as usize * 60;
    let mut source_offset = 0usize;
    let mut reached = 0usize;
    let mut bucket_start = 0usize;
    let mut bucket_latencies = Vec::new();
    let mut buckets = Vec::new();
    let mut bucket_memory_start = initial_memory;
    let mut ended_error = None;
    let started = Instant::now();

    while reached < target_samples {
        let wanted = chunk_samples.min(target_samples - reached);
        let mut chunk = Vec::with_capacity(wanted);
        while chunk.len() < wanted {
            let available = (audio.samples.len() - source_offset).min(wanted - chunk.len());
            chunk.extend_from_slice(&audio.samples[source_offset..source_offset + available]);
            source_offset = (source_offset + available) % audio.samples.len();
        }
        let feed_started = Instant::now();
        match stream.feed(&chunk) {
            Ok(_) => {
                bucket_latencies.push(feed_started.elapsed().as_secs_f64() * 1000.0);
                reached += wanted;
            }
            Err(error) => {
                ended_error = Some(error.to_string());
                break;
            }
        }

        let crossed_bucket = reached / bucket_samples > bucket_start / bucket_samples;
        if crossed_bucket || reached == target_samples {
            let memory_end = residency::sample(None, Some(model)).map_err(residency_failure)?;
            buckets.push(latency_memory_bucket(
                bucket_start,
                reached,
                audio.sample_rate,
                &bucket_latencies,
                &bucket_memory_start,
                &memory_end,
            ));
            bucket_start = reached;
            bucket_latencies.clear();
            bucket_memory_start = memory_end;
        }
    }

    if !bucket_latencies.is_empty() || buckets.is_empty() {
        let memory_end = residency::sample(None, Some(model)).map_err(residency_failure)?;
        buckets.push(latency_memory_bucket(
            bucket_start,
            reached,
            audio.sample_rate,
            &bucket_latencies,
            &bucket_memory_start,
            &memory_end,
        ));
    }

    let finalize_error = if reached == target_samples {
        stream.finalize().err().map(|error| error.to_string())
    } else {
        stream.reset();
        None
    };
    let survived = reached == target_samples && finalize_error.is_none();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    Ok(json!({
        "input_kind": "supplied clip looped to the requested duration",
        "quality_limitation": "Looped audio establishes resource behavior and feed-latency drift. It does not establish transcription quality for natural long-form speech.",
        "target_minutes": stream_minutes,
        "target_audio_ms": target_samples as f64 / f64::from(audio.sample_rate) * 1000.0,
        "actual_audio_ms": reached as f64 / f64::from(audio.sample_rate) * 1000.0,
        "wall_clock_ms": elapsed_ms,
        "effective_max_audio_ms": effective_max_audio_ms,
        "survived": survived,
        "ended_early": reached < target_samples,
        "ended_at_audio_ms": (reached < target_samples).then(|| reached as f64 / f64::from(audio.sample_rate) * 1000.0),
        "feed_error": ended_error,
        "finalize_error": finalize_error,
        "buckets": buckets,
    }))
}

fn latency_memory_bucket(
    start_samples: usize,
    end_samples: usize,
    sample_rate: u32,
    latencies: &[f64],
    memory_start: &Value,
    memory_end: &Value,
) -> Value {
    let start_rss = memory_start["rss_bytes"].as_u64();
    let end_rss = memory_end["rss_bytes"].as_u64();
    json!({
        "audio_start_ms": start_samples as f64 / f64::from(sample_rate) * 1000.0,
        "audio_end_ms": end_samples as f64 / f64::from(sample_rate) * 1000.0,
        "feed_count": latencies.len(),
        "feed_latency_ms": {
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "max": latencies.iter().copied().reduce(f64::max),
        },
        "memory": {
            "start": memory_start,
            "end": memory_end,
            "rss_growth_bytes": start_rss.zip(end_rss).map(|(start, end)| i128::from(end) - i128::from(start)),
        },
    })
}

struct TimedRun {
    latency_ms: f64,
    text: String,
}

fn warm_batch(
    model: &Model,
    audio: &Audio,
    session_options: &SessionOptions,
    runs: usize,
) -> Result<Value, Failure> {
    let mut samples = Vec::with_capacity(runs + 1);
    let mut last_text = String::new();
    for _ in 0..=runs {
        let mut session = model
            .session_with(session_options)
            .map_err(|error| failure("concurrency", format!("open batch session: {error}")))?;
        let run = timed_run(&mut session, audio)
            .map_err(|error| failure("concurrency", format!("batch baseline failed: {error}")))?;
        samples.push(run.latency_ms);
        last_text = run.text;
    }
    let warm = &samples[1..];
    Ok(json!({
        "cold_run_ms": samples[0],
        "warm_runs": warm.len(),
        "warm_run_ms": warm,
        "warm_median_ms": median(warm),
        "transcript_digest64": digest_text(&last_text),
        "transcript_head": last_text.chars().take(160).collect::<String>(),
    }))
}

fn timed_run(session: &mut transcribe_cpp::Session, audio: &Audio) -> Result<TimedRun, Error> {
    let started = Instant::now();
    let transcript = session.run(&audio.samples, &RunOptions::default())?;
    Ok(TimedRun {
        latency_ms: started.elapsed().as_secs_f64() * 1000.0,
        text: transcript.text,
    })
}

struct FeedObservation {
    chunk_samples: usize,
    latencies: Vec<f64>,
    updates: Vec<Value>,
    first_committed: Option<Value>,
}

fn feed_chunks(
    stream: &mut transcribe_cpp::Stream<'_>,
    audio: &Audio,
    chunk_samples: usize,
    stream_started: Instant,
) -> Result<FeedObservation, Failure> {
    let mut latencies = Vec::new();
    let mut updates = Vec::new();
    let mut first_committed = None;
    for chunk in audio.samples.chunks(chunk_samples) {
        let started = Instant::now();
        let update = stream
            .feed(chunk)
            .map_err(|error| failure("stream-feed", format!("feed stream: {error}")))?;
        let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
        latencies.push(latency_ms);
        updates.push(update_json(update, latency_ms));
        if first_committed.is_none() && !stream.text().committed.is_empty() {
            first_committed = Some(json!({
                "audio_consumed_ms": update.input_received_ms,
                "wall_clock_ms": stream_started.elapsed().as_secs_f64() * 1000.0,
            }));
        }
    }
    Ok(FeedObservation {
        chunk_samples,
        latencies,
        updates,
        first_committed,
    })
}

fn finalize_stream(
    stream: &mut transcribe_cpp::Stream<'_>,
    audio: &Audio,
    stream_started: Instant,
    mut feed: FeedObservation,
) -> Result<Value, Failure> {
    let finalize_started = Instant::now();
    let final_update = stream
        .finalize()
        .map_err(|error| failure("stream-feed", format!("finalize stream: {error}")))?;
    let finalize_ms = finalize_started.elapsed().as_secs_f64() * 1000.0;
    let text = stream.text();
    if feed.first_committed.is_none() && !text.committed.is_empty() {
        feed.first_committed = Some(json!({
            "audio_consumed_ms": final_update.input_received_ms,
            "wall_clock_ms": stream_started.elapsed().as_secs_f64() * 1000.0,
        }));
    }
    let feed_compute_ms: f64 = feed.latencies.iter().sum();
    let total_compute_ms = feed_compute_ms + finalize_ms;
    Ok(json!({
        "feed_mode": "back-to-back with no artificial sleeping; this measures compute capacity, not realtime playback",
        "chunk_samples": feed.chunk_samples,
        "chunk_ms_requested": feed.chunk_samples as f64 / f64::from(audio.sample_rate) * 1000.0,
        "feed_latency_ms": {
            "samples": feed.latencies,
            "p50": percentile(&feed.latencies, 0.50),
            "p95": percentile(&feed.latencies, 0.95),
            "max": feed.latencies.iter().copied().reduce(f64::max),
        },
        "feed_updates": feed.updates,
        "finalize_update": update_json(final_update, finalize_ms),
        "feed_compute_ms": feed_compute_ms,
        "finalize_compute_ms": finalize_ms,
        "stream_compute_rtf": total_compute_ms / 1000.0 / audio.duration_s,
        "time_to_first_committed_text": feed.first_committed,
        "final_text": {
            "committed": text.committed,
            "tentative": text.tentative,
            "full": text.full,
            "committed_digest64": digest_text(&text.committed),
            "committed_chars": text.committed.chars().count(),
        },
    }))
}

fn chunk_samples(chunk_ms: u32, sample_rate: u32) -> Result<usize, Failure> {
    usize::try_from(chunk_ms)
        .ok()
        .and_then(|ms| ms.checked_mul(sample_rate as usize))
        .map(|samples_ms| samples_ms / 1000)
        .filter(|&samples| samples > 0)
        .ok_or_else(|| {
            failure(
                "stream-feed",
                format!("--chunk-ms {chunk_ms} cannot produce a non-empty chunk"),
            )
        })
}

fn update_json(update: StreamUpdate, latency_ms: f64) -> Value {
    json!({
        "latency_ms": latency_ms,
        "result_changed": update.result_changed,
        "is_final": update.is_final,
        "revision": update.revision,
        "input_received_ms": update.input_received_ms,
        "audio_committed_ms": update.audio_committed_ms,
        "buffered_ms": update.buffered_ms,
        "committed_changed": update.committed_changed,
        "tentative_changed": update.tentative_changed,
    })
}

fn percentile(values: &[f64], quantile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = (quantile * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.saturating_sub(1).min(sorted.len() - 1)])
}

fn digest_text(text: &str) -> String {
    let mut digest = Digest::new();
    digest.write(text.as_bytes());
    digest.hex()
}

fn failure(stage: &'static str, message: String) -> Failure {
    Failure { stage, message }
}

fn residency_failure(message: String) -> Failure {
    failure("residency", message)
}
