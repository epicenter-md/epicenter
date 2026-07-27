//! CPAL recorder built around a two-thread pipeline.
//!
//! ```text
//! cpal callback thread          consumer worker thread
//! ┌────────────────────┐  mpsc  ┌─────────────────────┐
//! │ build_input_stream │ ─────▶ │ run_consumer        │
//! │  - downmix to mono │ chunks │  - accumulate Vec   │
//! │  - sample_tx.send  │        │  - resample (final) │
//! └────────────────────┘        │  - pad short clips  │
//!                               │  - emit mic level   │
//!                               └─────────────────────┘
//! ```
//!
//! The cpal callback never blocks: it downmixes to mono and ships
//! samples through an mpsc channel. The consumer worker accumulates,
//! resamples to 16 kHz at finalize, pads sub-1s clips, and hands the
//! resulting `Vec<f32>` (mono 16 kHz PCM) back to the command layer,
//! which writes the durable blob and returns its id over IPC.
//!
//! # One recorder, owned by the window that started it
//!
//! There is exactly one recorder for the whole host, and at most one
//! recording in flight. A recording is addressed by the blob id the host
//! minted for it and is owned by the window label that started it. Every
//! lifecycle method takes both, so an application can only ever stop or
//! cancel the recording it actually started: a competing `start` is refused
//! with [`RecorderError::Busy`] rather than silently displacing the live one.
//!
//! The label identifies a *window*, not an application: navigation across
//! `/apps/*` on the one loopback origin is permitted, so a window may change
//! which app it is showing. Under ADR-0179's full-trust model that is enough,
//! because ownership here exists for resource correctness, not isolation.
//! Labels are assigned by Rust (`Surface::id`, `app_window_label`) and cannot
//! be supplied by the frontend, which is what makes them usable at all.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream};
use log::{debug, error, info};
use serde::Serialize;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::audio::resample_mono;
use crate::recorder::error::RecorderError;

/// Recorder result type. Errors cross the IPC boundary as the internally
/// tagged `RecorderError` enum (`{ name, message }`) so the JS side switches
/// on `error.name` instead of matching message text.
pub type Result<T> = std::result::Result<T, RecorderError>;

/// Target rate for every recording. Local GGUF transcription consumes 16 kHz
/// mono; the cloud services accept Opus encoded from 48 kHz, reached via a
/// second resample step inside `audio::encode_pcm_to_opus_ogg`.
pub(crate) const TARGET_RATE: u32 = 16_000;

/// Event name for live mic levels, emitted to the window that owns the
/// recording so its meter can reflect mic activity. The JS side never sees the
/// PCM, so the level has to originate here.
///
/// The owner window is the only recipient. An application that draws the meter
/// somewhere else too (Whispering's recording overlay is a second webview)
/// forwards it from there, which is what its VAD recorder already does for its
/// own levels. The host does not name another application's windows.
const MIC_LEVEL_EVENT: &str = "mic-level";

/// Minimum gap between mic-level emits. ~20 Hz is smooth for a meter and keeps
/// the targeted Tauri event off the IPC hot path (per Tauri's guidance to
/// throttle high-frequency events). Levels between emits are averaged, not
/// dropped, so a brief loud transient still registers.
const MIC_LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// Sub-1s recordings are padded to this many samples (at 16 kHz, so
/// 1.25 s). Suppresses Whisper hallucination on near-silent short
/// clips. Empty recordings (no samples ever delivered) are left empty.
const SHORT_RECORDING_PAD_SAMPLES: usize = 20_000;

/// Worker-thread command channel.
///
/// Two variants for two genuinely different operations: `Stop` asks for the
/// captured audio back, `Cancel` discards it. Both end the worker loop, so
/// there is no third "shut down" message and no stopped-but-still-open state
/// for a caller to observe.
#[derive(Debug)]
enum RecorderCmd {
    Stop(mpsc::Sender<Result<Vec<f32>>>),
    Cancel,
}

/// The one in-flight recording: its identity, its owner, and the worker
/// carrying it.
struct ActiveRecording {
    /// The blob id the host minted at `start`. It names the blob this
    /// recording will become; `cancel` burns it without ever writing one.
    audio_blob_id: String,
    /// Label of the window that called `start`. Stop is restricted to it.
    owner_label: String,
    /// Which microphone this recording opened, so a window that reloads can be
    /// told what it is recording from without reopening anything.
    device: DeviceAcquisition,
    cmd_tx: mpsc::Sender<RecorderCmd>,
    worker: JoinHandle<()>,
}

/// CPAL-backed audio recorder.
///
/// `Option<ActiveRecording>` is the whole state machine: `Some` means a
/// recording is in flight, `None` means idle. There is no separate "session
/// opened but not recording" phase, which is why no atomic flag is needed to
/// tell the two apart.
#[derive(Default)]
pub struct Recorder {
    active: Option<ActiveRecording>,
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// List available recording devices by name.
    pub fn enumerate_devices(&self) -> Result<Vec<String>> {
        let host = cpal::default_host();
        let devices = host
            .input_devices()
            .map_err(|e| RecorderError::classify_cpal("Failed to get input devices", e))?
            // A device names itself via `description()`. Skip any that can't
            // describe themselves rather than letting `Display`/`to_string()`
            // panic on the underlying description failure.
            .filter_map(|device| device.description().ok().map(|d| d.name().to_string()))
            .collect();

        Ok(devices)
    }

    /// Open the input stream and begin capturing, in one step.
    ///
    /// Returns [`RecorderError::Busy`] when a recording is already in flight,
    /// so a competing start is refused instead of displacing a recording some
    /// other window is relying on.
    ///
    /// The device is resolved here rather than by the caller. A caller that
    /// picked a device from a stale list would otherwise have to enumerate,
    /// compare, and choose a substitute before it could start, duplicating a
    /// decision the host has to be able to make anyway. The returned
    /// [`DeviceAcquisition`] names the device actually opened, so an
    /// application can tell the person what it fell back to and persist it.
    ///
    /// The cpal stream is built inside the worker (macOS requires the stream and
    /// the run loop driving it to share a thread) and its outcome is reported
    /// back over `ready_rx`, so a stream that fails to open surfaces as the real
    /// classified error rather than as a dropped channel.
    pub fn start(
        &mut self,
        requested_device: Option<&str>,
        audio_blob_id: String,
        owner_label: String,
        preferred_sample_rate: Option<u32>,
        app_handle: AppHandle,
    ) -> Result<DeviceAcquisition> {
        if let Some(active) = &self.active {
            return Err(RecorderError::busy(format!(
                "a recording ({}) started by window '{}' is already in flight",
                active.audio_blob_id, active.owner_label
            )));
        }

        let host = cpal::default_host();
        let (device, acquisition) = resolve_device(&host, requested_device)?;
        let config = get_optimal_config(&device, preferred_sample_rate)?;
        let sample_format = config.sample_format();
        let device_rate = config.sample_rate();
        let device_channels = config.channels();

        let stream_config = cpal::StreamConfig {
            channels: device_channels,
            sample_rate: device_rate,
            buffer_size: cpal::BufferSize::Default,
        };

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        let meter_label = owner_label.clone();
        let failure_app = app_handle.clone();
        let failure_blob_id = audio_blob_id.clone();

        let worker = thread::spawn(move || {
            let stream = match build_input_stream(
                &device,
                stream_config,
                sample_format,
                device_channels,
                sample_tx,
                failure_app,
                failure_blob_id,
            )
            .and_then(|stream| {
                stream
                    .play()
                    .map_err(|e| RecorderError::classify_cpal("Failed to start stream", e))?;
                Ok(stream)
            }) {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    stream
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };

            info!("Audio stream started successfully");
            // Capture begins the moment the stream plays. Samples produced
            // before the loop is entered wait in `sample_rx`, so nothing
            // between `play()` and the first iteration is lost.
            run_consumer(sample_rx, cmd_rx, device_rate, &meter_label, app_handle);
            drop(stream);
        });

        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(error);
            }
            Err(error) => {
                let _ = worker.join();
                return Err(RecorderError::failed(format!(
                    "recorder worker exited before reporting stream readiness: {error}"
                )));
            }
        }

        info!(
            "Recording started: id={audio_blob_id}, owner={owner_label}, device={}, {device_rate} Hz, {device_channels} channels",
            acquisition.device_id(),
        );
        self.active = Some(ActiveRecording {
            audio_blob_id,
            owner_label,
            device: acquisition.clone(),
            cmd_tx,
            worker,
        });
        Ok(acquisition)
    }

    /// End the recording named by `audio_blob_id` because its capture stream
    /// died, returning the window that owned it so the host can tell it.
    ///
    /// Matched on the blob id, not just the owner: a stream error can arrive
    /// after the owner already started a second recording, and killing that one
    /// because its predecessor's hardware failed would be its own bug. A
    /// non-matching id makes this a no-op, which also makes it idempotent when
    /// cpal reports the same failure more than once.
    pub fn abandon(&mut self, audio_blob_id: &str) -> Option<String> {
        let active = self
            .active
            .take_if(|active| active.audio_blob_id == audio_blob_id)?;
        let owner_label = active.owner_label.clone();
        discard(active);
        Some(owner_label)
    }

    /// Stop the recording named by `audio_blob_id` and consume its mono 16 kHz
    /// PCM. Restricted to the window that started it: only the owner may turn a
    /// recording into a blob it can read.
    pub fn stop(&mut self, audio_blob_id: &str, caller_label: &str) -> Result<Vec<f32>> {
        self.require_owned(audio_blob_id, caller_label)?;
        // Taken before the round trip: whether the worker answers or dies, this
        // recording is over and the slot must be free for the next start.
        let active = self.active.take().expect("ownership was just verified");

        let (reply_tx, reply_rx) = mpsc::channel();
        let sent = active.cmd_tx.send(RecorderCmd::Stop(reply_tx));
        let samples = match sent {
            Ok(()) => reply_rx
                .recv()
                .map_err(|e| RecorderError::failed(format!("Worker dropped stop reply: {e}")))?,
            Err(e) => Err(RecorderError::failed(format!(
                "Failed to send stop command: {e}"
            ))),
        };
        let _ = active.worker.join();
        samples
    }

    /// Cancel the recording named by `audio_blob_id`, discarding its audio.
    ///
    /// Restricted to the owner window, for the same reason `stop` is: a
    /// recording another window is relying on must not vanish under it. The
    /// host cancels through [`Recorder::cancel_owned_by`] instead, which is not
    /// reachable over IPC.
    pub fn cancel(&mut self, audio_blob_id: &str, caller_label: &str) -> Result<()> {
        self.require_owned(audio_blob_id, caller_label)?;
        let active = self.active.take().expect("ownership was just verified");
        discard(active);
        Ok(())
    }

    /// Cancel the in-flight recording if `owner_label` owns it, returning the
    /// burnt blob id. The host's own path, used when the owner window is
    /// destroyed: the recording it owns can no longer be stopped by anyone, so
    /// holding the single recorder slot for it would wedge every other window.
    pub fn cancel_owned_by(&mut self, owner_label: &str) -> Option<String> {
        let active = self
            .active
            .take_if(|active| active.owner_label == owner_label)?;
        let audio_blob_id = active.audio_blob_id.clone();
        discard(active);
        Some(audio_blob_id)
    }

    /// The blob id of the recording `caller_label` owns, if any.
    ///
    /// Scoped to the caller rather than global: a window learns about its own
    /// recording and nothing else. This is load-bearing, not recovery sugar.
    /// Reloading a window does not destroy it, so a window that reloads
    /// mid-recording still owns a live recording and needs the id back to stop
    /// or cancel it.
    pub fn current(&self, caller_label: &str) -> Option<(String, DeviceAcquisition)> {
        self.active
            .as_ref()
            .filter(|active| active.owner_label == caller_label)
            .map(|active| (active.audio_blob_id.clone(), active.device.clone()))
    }

    /// Whether any recording is in flight, for the host's tray indicator.
    pub fn is_recording(&self) -> bool {
        self.active.is_some()
    }

    /// The one ownership rule, in one place: the named recording must be live
    /// and must belong to the calling window.
    ///
    /// Both failures collapse to `NotRecording`. The caller cannot act
    /// differently on "no such recording" versus "not yours" (both mean "this
    /// window has nothing to stop"), and the distinguishing detail still
    /// travels in `message` for diagnostics.
    fn require_owned(&self, audio_blob_id: &str, caller_label: &str) -> Result<()> {
        let Some(active) = &self.active else {
            return Err(RecorderError::not_recording(format!(
                "no recording is in flight; '{audio_blob_id}' has already ended"
            )));
        };
        if active.audio_blob_id != audio_blob_id {
            return Err(RecorderError::not_recording(format!(
                "the in-flight recording is not '{audio_blob_id}'"
            )));
        }
        if active.owner_label != caller_label {
            return Err(RecorderError::not_recording(format!(
                "recording '{audio_blob_id}' is owned by window '{}', not '{caller_label}'",
                active.owner_label
            )));
        }
        Ok(())
    }
}

/// End a recording without producing anything: tell the worker to drop its
/// buffer, then join it so the cpal stream is released before returning.
fn discard(active: ActiveRecording) {
    // A send failure means the worker is already gone, which is the same
    // outcome by another route, so it is not an error to report.
    let _ = active.cmd_tx.send(RecorderCmd::Cancel);
    let _ = active.worker.join();
    debug!("Recording {} cancelled", active.audio_blob_id);
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            discard(active);
        }
    }
}

/// Consumer worker entrypoint. Accumulates mono samples, resamples to
/// 16 kHz at finalize, pads short clips, returns the samples. While recording,
/// also emits a throttled RMS level to the owner window so its meter can
/// reflect live mic activity.
fn run_consumer(
    sample_rx: mpsc::Receiver<Vec<f32>>,
    cmd_rx: mpsc::Receiver<RecorderCmd>,
    device_rate: u32,
    owner_label: &str,
    app_handle: AppHandle,
) {
    use std::sync::mpsc::RecvTimeoutError;

    let mut buffer: Vec<f32> = Vec::new();
    // Mic-level metering accumulators, averaged and flushed on an interval.
    let mut level_sumsq = 0f64;
    let mut level_count = 0usize;
    let mut last_level_emit = Instant::now();

    loop {
        // Command channel has priority. Stop should respond fast even
        // when audio frames are arriving back-to-back.
        match cmd_rx.try_recv() {
            Ok(RecorderCmd::Stop(reply)) => {
                let result = crate::timing::measure("finalize", || {
                    finalize(std::mem::take(&mut buffer), device_rate)
                });
                let _ = reply.send(result);
                return;
            }
            Ok(RecorderCmd::Cancel) => return,
            // The command sender is gone without a stop or a cancel, so nobody
            // is left to receive this audio.
            Err(mpsc::TryRecvError::Disconnected) => return,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                for &sample in &samples {
                    level_sumsq += (sample as f64) * (sample as f64);
                }
                level_count += samples.len();
                buffer.extend_from_slice(&samples);

                if last_level_emit.elapsed() >= MIC_LEVEL_EMIT_INTERVAL && level_count > 0 {
                    let rms = (level_sumsq / level_count as f64).sqrt() as f32;
                    // A targeted emit, never a broadcast: a level is about one
                    // window's recording, and every other window is entitled
                    // not to hear it. Not an error if the owner window is
                    // hidden or gone, and never fatal.
                    let _ = app_handle.emit_to(owner_label, MIC_LEVEL_EVENT, rms);
                    level_sumsq = 0.0;
                    level_count = 0;
                    last_level_emit = Instant::now();
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Resample to 16 kHz if needed, pad short clips, build the samples.
fn finalize(buffer: Vec<f32>, device_rate: u32) -> Result<Vec<f32>> {
    let samples = if device_rate == TARGET_RATE {
        buffer
    } else {
        resample_mono(buffer, device_rate, TARGET_RATE)
            .map_err(|e| RecorderError::failed(format!("resample failed: {e}")))?
    };

    let mut samples = samples;
    let samples_per_second = TARGET_RATE as usize;
    if !samples.is_empty()
        && samples.len() < samples_per_second
        && samples.len() < SHORT_RECORDING_PAD_SAMPLES
    {
        samples.resize(SHORT_RECORDING_PAD_SAMPLES, 0.0);
    }

    Ok(samples)
}

/// Which microphone a recording actually opened, and whether that was the one
/// asked for.
///
/// Serialized to match `DeviceAcquisitionOutcome` in `@epicenter/recorder`,
/// which the browser recorder already produces, so both platforms report device
/// acquisition in one shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeviceAcquisition {
    /// The requested device was found and opened.
    Success { device_id: String },
    /// A different device was opened. `device_id` is what actually recorded, so
    /// an application can say which microphone it is using and persist it.
    Fallback {
        reason: FallbackReason,
        device_id: String,
    },
}

impl DeviceAcquisition {
    pub fn device_id(&self) -> &str {
        match self {
            Self::Success { device_id } | Self::Fallback { device_id, .. } => device_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackReason {
    /// No device was requested, so the system default was used.
    NoDeviceSelected,
    /// The requested device is not present, so the system default was used.
    PreferredDeviceUnavailable,
}

/// Resolve the microphone to record from, falling back to the system default.
///
/// Falling back rather than failing is deliberate and preexisting: a saved
/// device that is merely unplugged should not turn the record button into an
/// error, and the application reports the substitution and persists it. What
/// changed when this moved into Rust is only the fallback *target*. The
/// TypeScript version fell back to whichever device cpal happened to enumerate
/// first; this uses the system default, which is the device the person has
/// actually chosen at the OS level. Both are silent substitutions reported the
/// same way, so the user-visible contract is unchanged.
fn resolve_device(
    host: &cpal::Host,
    requested: Option<&str>,
) -> Result<(Device, DeviceAcquisition)> {
    let default_device = || {
        host.default_input_device().ok_or_else(|| {
            RecorderError::no_input_device("No microphone is available to record from")
        })
    };

    let Some(requested) = requested else {
        let device = default_device()?;
        let device_id = device_name(&device)?;
        return Ok((
            device,
            DeviceAcquisition::Fallback {
                reason: FallbackReason::NoDeviceSelected,
                device_id,
            },
        ));
    };

    let devices: Vec<_> = host
        .input_devices()
        .map_err(|e| RecorderError::classify_cpal("Failed to list input devices", e))?
        .collect();
    for device in devices {
        if device.description().is_ok_and(|d| d.name() == requested) {
            return Ok((
                device,
                DeviceAcquisition::Success {
                    device_id: requested.to_string(),
                },
            ));
        }
    }

    let device = default_device()?;
    let device_id = device_name(&device)?;
    Ok((
        device,
        DeviceAcquisition::Fallback {
            reason: FallbackReason::PreferredDeviceUnavailable,
            device_id,
        },
    ))
}

/// The name a device calls itself, which is also the id every other layer uses
/// to refer to it. A device that cannot describe itself cannot be persisted as
/// a choice, so this refuses rather than inventing a placeholder.
fn device_name(device: &Device) -> Result<String> {
    device
        .description()
        .map(|description| description.name().to_string())
        .map_err(|e| RecorderError::classify_cpal("Failed to read the input device name", e))
}

/// Get the best supported configuration for voice recording.
///
/// Prefers mono at the target rate (16 kHz default), falls back to stereo
/// at the target rate, then to the closest supported rate.
fn get_optimal_config(
    device: &Device,
    preferred_sample_rate: Option<u32>,
) -> Result<cpal::SupportedStreamConfig> {
    let target_sample_rate = preferred_sample_rate.unwrap_or(TARGET_RATE);

    // A device that yields no input configs is unusable as an input, whether the
    // query *errors* or returns *empty*: both mean "this mic can't tell us how to
    // record from it," so both classify as NoInputDevice ("connect a microphone")
    // rather than a generic Failed the user can't act on.
    //
    // A query error here means the device can't describe how to record from it,
    // which for the user is indistinguishable from "no mic," so collapse it to
    // NoInputDevice. cpal 0.18 types a true denial as PermissionDenied and often
    // routes a vanished-mic config query to a generic kind (macOS sends the
    // OSStatus failure to BackendError), so only a Failed is remapped; a
    // PermissionDenied passes through untouched.
    let configs: Vec<_> = device
        .supported_input_configs()
        .map_err(
            |e| match RecorderError::classify_cpal("Failed to query input configs", e) {
                RecorderError::Failed { message } => RecorderError::NoInputDevice { message },
                classified => classified,
            },
        )?
        .collect();
    if configs.is_empty() {
        return Err(RecorderError::no_input_device(
            "No supported input configurations",
        ));
    }

    let supported_formats = [SampleFormat::F32, SampleFormat::I16, SampleFormat::U16];
    let compatible_configs: Vec<_> = configs
        .iter()
        .filter(|config| supported_formats.contains(&config.sample_format()))
        .collect();
    if compatible_configs.is_empty() {
        return Err(RecorderError::failed(
            "No configurations with supported sample formats (F32, I16, U16)",
        ));
    }

    // Mono at target rate if possible.
    for config in &compatible_configs {
        if config.channels() == 1 {
            let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
            if min <= target_sample_rate && max >= target_sample_rate {
                return Ok(config.with_sample_rate(target_sample_rate));
            }
        }
    }

    // Any channel count at target rate.
    for config in &compatible_configs {
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        if min <= target_sample_rate && max >= target_sample_rate {
            return Ok(config.with_sample_rate(target_sample_rate));
        }
    }

    // Closest-rate fallback, preferring mono.
    let mut best_config: Option<cpal::SupportedStreamConfig> = None;
    let mut best_diff = u32::MAX;
    for config in &compatible_configs {
        if config.channels() != 1 {
            continue;
        }
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        let closest = if target_sample_rate < min {
            min
        } else if target_sample_rate > max {
            max
        } else {
            target_sample_rate
        };
        let diff = (closest as i32 - target_sample_rate as i32).unsigned_abs();
        if diff < best_diff {
            best_diff = diff;
            best_config = Some(config.with_sample_rate(closest));
        }
    }

    // No mono config matched a rate window above; fall back to the first
    // compatible config. `compatible_configs` is non-empty here (guarded
    // earlier), so a config always exists: there is no "no suitable
    // configuration" failure left to model.
    Ok(best_config.unwrap_or_else(|| {
        let config = compatible_configs[0];
        let (min, max) = (config.min_sample_rate(), config.max_sample_rate());
        let rate = if min <= target_sample_rate && max >= target_sample_rate {
            target_sample_rate
        } else {
            min
        };
        config.with_sample_rate(rate)
    }))
}

/// Build the cpal input stream. The callback's only job is to downmix to
/// mono f32 and send the chunk down `sample_tx`; the consumer worker owns
/// everything else.
fn build_input_stream(
    device: &Device,
    config: cpal::StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    sample_tx: mpsc::Sender<Vec<f32>>,
    failure_app: AppHandle,
    failure_blob_id: String,
) -> Result<Stream> {
    // A live stream error used to be logged and nothing else, which left the
    // one recorder slot occupied, the tray claiming a recording, and the owner
    // window waiting for audio that would never arrive. Now a terminal error
    // ends the recording and tells the owner why.
    //
    // Only a terminal error: `ended::classify` returns `None` for the
    // conditions cpal documents as survivable, so a routine audio-route change
    // (plugging in headphones) no longer looks like a dead microphone.
    //
    // The cleanup runs on its own thread because it locks the recorder and
    // joins the capture worker, neither of which may happen on the audio
    // callback. This fires at most once per stream death and never on the
    // sample path.
    let err_fn = move |error: cpal::Error| {
        let Some(reason) = crate::recorder::ended::classify(&error) else {
            debug!("Audio stream reported a survivable condition, continuing: {error}");
            return;
        };
        error!("Audio stream ended the recording: {error}");
        let app = failure_app.clone();
        let audio_blob_id = failure_blob_id.clone();
        thread::spawn(move || {
            crate::recorder::commands::abandon_recording(&app, &audio_blob_id, reason);
        });
    };
    let n_channels = channels as usize;

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _: &_| {
                    let _ = sample_tx.send(downmix_f32(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build F32 stream", e))?,
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _: &_| {
                    let _ = sample_tx.send(downmix_i16(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build I16 stream", e))?,
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _: &_| {
                    let _ = sample_tx.send(downmix_u16(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| RecorderError::classify_cpal("Failed to build U16 stream", e))?,
        _ => {
            return Err(RecorderError::failed(format!(
                "Unsupported sample format: {sample_format:?}"
            )))
        }
    };

    Ok(stream)
}

fn downmix_f32(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_i16(interleaved: &[i16], channels: usize) -> Vec<f32> {
    let scale = 1.0 / i16::MAX as f32;
    if channels <= 1 {
        return interleaved.iter().map(|&s| s as f32 * scale).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().map(|&s| s as f32 * scale).sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_u16(interleaved: &[u16], channels: usize) -> Vec<f32> {
    // u16 PCM: midpoint is 32768. Normalize to [-1, 1] via (x / max) * 2 - 1.
    let half = u16::MAX as f32 * 0.5;
    let to_f32 = |s: u16| (s as f32 / half) - 1.0;
    if channels <= 1 {
        return interleaved.iter().copied().map(to_f32).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().copied().map(to_f32).sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand up an `ActiveRecording` without opening a microphone.
    ///
    /// The ownership rules are pure state, so they are tested against real
    /// `Recorder` state rather than through cpal: a test that needs an input
    /// device cannot run in CI, and the rules being checked have nothing to do
    /// with audio.
    ///
    /// The stand-in worker exits on its first command, which is what
    /// `run_consumer` does for both `Stop` and `Cancel`. That detail is
    /// load-bearing rather than incidental: `discard` sends `Cancel` and then
    /// joins while still holding `cmd_tx`, so a worker that looped waiting for
    /// a second command would never see its channel close and the join would
    /// hang forever.
    fn recording_owned_by(recorder: &mut Recorder, audio_blob_id: &str, owner_label: &str) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();
        let worker = thread::spawn(move || {
            let _ = cmd_rx.recv();
        });
        recorder.active = Some(ActiveRecording {
            audio_blob_id: audio_blob_id.to_string(),
            owner_label: owner_label.to_string(),
            device: DeviceAcquisition::Success {
                device_id: "Test Microphone".to_string(),
            },
            cmd_tx,
            worker,
        });
    }

    fn error_name(error: &RecorderError) -> &'static str {
        match error {
            RecorderError::PermissionDenied { .. } => "PermissionDenied",
            RecorderError::NoInputDevice { .. } => "NoInputDevice",
            RecorderError::Busy { .. } => "Busy",
            RecorderError::NotRecording { .. } => "NotRecording",
            RecorderError::Failed { .. } => "Failed",
        }
    }

    #[test]
    fn a_fresh_recorder_is_idle_and_owns_nothing() {
        let recorder = Recorder::new();
        assert!(!recorder.is_recording());
        assert_eq!(recorder.current("whispering"), None);
    }

    #[test]
    fn current_is_scoped_to_the_owning_window() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        assert_eq!(
            recorder.current("app-notes").map(|(id, _)| id).as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
        // A window that owns no recording learns nothing about one that exists.
        assert_eq!(recorder.current("whispering"), None);
    }

    #[test]
    fn a_non_owner_cannot_stop_or_cancel_and_the_recording_survives() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        let stop = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "whispering")
            .expect_err("a non-owner must not stop another window's recording");
        assert_eq!(error_name(&stop), "NotRecording");

        let cancel = recorder
            .cancel("blob_aaaaaaaaaaaaaaaaaaaaa", "whispering")
            .expect_err("a non-owner must not cancel another window's recording");
        assert_eq!(error_name(&cancel), "NotRecording");

        // The refusals left the owner's recording completely untouched.
        assert!(recorder.is_recording());
        assert_eq!(
            recorder.current("app-notes").map(|(id, _)| id).as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
    }

    #[test]
    fn the_owner_cannot_stop_an_id_that_is_not_the_live_recording() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        let error = recorder
            .stop("blob_bbbbbbbbbbbbbbbbbbbbb", "app-notes")
            .expect_err("a stale id must not stop whatever happens to be live");
        assert_eq!(error_name(&error), "NotRecording");
        assert!(recorder.is_recording());
    }

    #[test]
    fn the_owner_can_cancel_and_the_slot_is_released() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        recorder
            .cancel("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect("the owner may cancel its own recording");

        assert!(!recorder.is_recording());
        assert_eq!(recorder.current("app-notes"), None);
    }

    #[test]
    fn destroying_the_owner_window_cancels_only_its_own_recording() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        // A different window closing leaves the recording alone.
        assert_eq!(recorder.cancel_owned_by("whispering"), None);
        assert!(recorder.is_recording());

        assert_eq!(
            recorder.cancel_owned_by("app-notes").as_deref(),
            Some("blob_aaaaaaaaaaaaaaaaaaaaa"),
        );
        assert!(!recorder.is_recording());
    }

    /// The wedge this exists to prevent: before capture death released the
    /// slot, a dead stream left `active` occupied forever, so no window could
    /// ever start another recording and the tray kept claiming one was running.
    #[test]
    fn a_dead_capture_releases_the_slot_and_names_its_owner() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        assert_eq!(
            recorder.abandon("blob_aaaaaaaaaaaaaaaaaaaaa").as_deref(),
            Some("app-notes"),
            "abandoning must report the owner so the host can tell it"
        );
        assert!(
            !recorder.is_recording(),
            "the slot must be free for the next start"
        );
        assert_eq!(recorder.current("app-notes"), None);
    }

    /// A stream error can arrive after its recording already ended and the
    /// owner started another one. Matching on the id keeps the late failure
    /// from killing the innocent successor, and makes a repeated report a
    /// no-op rather than a second teardown.
    #[test]
    fn abandoning_a_stale_id_leaves_the_live_recording_alone() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_bbbbbbbbbbbbbbbbbbbbb", "app-notes");

        assert_eq!(recorder.abandon("blob_aaaaaaaaaaaaaaaaaaaaa"), None);
        assert!(recorder.is_recording());
        assert_eq!(
            recorder.current("app-notes").map(|(id, _)| id).as_deref(),
            Some("blob_bbbbbbbbbbbbbbbbbbbbb"),
        );

        // And the second report of the same failure finds nothing to do.
        assert_eq!(
            recorder.abandon("blob_bbbbbbbbbbbbbbbbbbbbb").as_deref(),
            Some("app-notes")
        );
        assert_eq!(recorder.abandon("blob_bbbbbbbbbbbbbbbbbbbbb"), None);
    }

    /// A recovered recording has to be able to say which microphone is running,
    /// or a window that reloaded would show a meter for a device it cannot name.
    #[test]
    fn current_reports_the_device_the_recording_opened() {
        let mut recorder = Recorder::new();
        recording_owned_by(&mut recorder, "blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes");

        let (_, device) = recorder.current("app-notes").expect("a live recording");
        assert_eq!(device.device_id(), "Test Microphone");
    }

    #[test]
    fn stopping_a_recording_that_already_ended_is_a_typed_refusal() {
        let mut recorder = Recorder::new();
        let error = recorder
            .stop("blob_aaaaaaaaaaaaaaaaaaaaa", "app-notes")
            .expect_err("there is nothing to stop");
        assert_eq!(error_name(&error), "NotRecording");
    }

    #[test]
    fn downmix_stereo_to_mono_averages_pairs() {
        let stereo = vec![0.5_f32, -0.5, 1.0, -1.0];
        let mono = downmix_f32(&stereo, 2);
        assert_eq!(mono, vec![0.0, 0.0]);
    }

    #[test]
    fn downmix_mono_is_identity() {
        let input = vec![0.1_f32, 0.2, 0.3];
        let mono = downmix_f32(&input, 1);
        assert_eq!(mono, input);
    }

    #[test]
    fn short_clips_are_padded_and_empty_ones_are_left_alone() {
        let padded = finalize(vec![0.1; 100], TARGET_RATE).expect("finalize a short clip");
        assert_eq!(padded.len(), SHORT_RECORDING_PAD_SAMPLES);

        let empty = finalize(Vec::new(), TARGET_RATE).expect("finalize an empty clip");
        assert!(empty.is_empty());

        // Anything at or over a second is returned as captured.
        let long = finalize(vec![0.1; TARGET_RATE as usize], TARGET_RATE).expect("finalize");
        assert_eq!(long.len(), TARGET_RATE as usize);
    }
}
