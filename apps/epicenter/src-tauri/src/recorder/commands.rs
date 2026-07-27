//! The recording command surface: the whole thing an application can reach.
//!
//! `start`, `stop`, `cancel`, `current`, and device enumeration. There is no
//! session to open or close, no lease object, and no handle: the host owns the
//! one recorder, and a recording is named by the blob id `start` returns.
//!
//! Every lifecycle command takes an injected `WebviewWindow`. Tauri supplies it
//! from the invoking window and specta renders it as nothing at all (its
//! `FunctionArg::to_datatype` returns `None`, `tauri/src/lib.rs:1130`), so the
//! caller's identity costs zero TypeScript surface and cannot be spoofed from
//! JS: window labels are assigned in Rust and the frontend never supplies one.
//!
//! Ownership here is resource correctness, not isolation. ADR-0179 grants an
//! admitted app broad same-origin and device authority on purpose; what these
//! rules prevent is one window destroying, stopping, or collecting the blob of
//! a recording another window started.

use crate::recorder::blob::{mint_blob_id, write_blob};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{Recorder, Result, TARGET_RATE};
use log::{debug, info};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// What `stop_recording` hands back: the committed blob's id and the two facts
/// only the host can state exactly.
///
/// Both are computed here rather than in JS, where they used to be a wall-clock
/// subtraction and a follow-up `stat` round trip. Wall clock measures how long
/// the user held the button, which is not the same as how much audio the blob
/// contains, and it had no answer at all after a reload.
///
/// Both are `u32` because the blob is a RIFF WAV and RIFF states its own sizes
/// in 32 bits: `write_pcm_as_wav` already refuses anything larger. So `u32` is
/// the format's real bound rather than a convenient cap, and it renders in
/// TypeScript as a plain `number` (specta widens `f64` to `number | null` to
/// leave room for NaN, a value neither of these can hold).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRecording {
    pub audio_blob_id: String,
    /// Exact duration of the committed audio: finalized sample count over the
    /// 16 kHz target rate. This is the blob's own length, so a sub-second clip
    /// padded at finalize reports the padded duration, which is what the file
    /// actually holds.
    pub duration_ms: u32,
    /// Exact length of the published file on disk.
    pub byte_length: u32,
}

/// Refresh the host's recording indicator from the recorder's own state, so the
/// tray can never disagree with whether a recording exists.
///
/// There is deliberately no companion event to the frontend. A window learns
/// its recording ended from its own `stop`/`cancel` resolving, and the only
/// host-initiated ending is the owner window being destroyed, which leaves
/// nobody to tell. A global `recorder:state-changed` broadcast would also be
/// actively wrong now: every other window would watch a recording it does not
/// own go idle and tear down its own state.
fn refresh_recording_indicator(app: &AppHandle, recorder: &Recorder) {
    crate::shell::set_tray_recording_state(app, recorder.is_recording());
}

fn lock<'a>(
    recorder: &'a State<'_, Mutex<Recorder>>,
) -> Result<std::sync::MutexGuard<'a, Recorder>> {
    recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    lock(&recorder)?.enumerate_devices()
}

/// Start recording, returning the blob id the recording will be published
/// under.
///
/// The id exists before its blob does: `stop` publishes the blob under it and
/// `cancel` burns it with no blob ever written. The host mints it so ownership
/// is decided here rather than asserted by a caller.
///
/// `device_identifier` is optional; `None` records from the system default. An
/// application with no device picker passes nothing. Fails with `Busy` when
/// another window is already recording.
#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    device_identifier: Option<String>,
    sample_rate: Option<u32>,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<String> {
    let owner_label = window.label().to_string();
    let audio_blob_id = mint_blob_id()?;
    info!(
        "Starting recording: id={audio_blob_id}, owner={owner_label}, device={device_identifier:?}, sample_rate={sample_rate:?}",
    );

    let mut recorder = lock(&recorder)?;
    recorder.start(
        device_identifier.as_deref().unwrap_or("default"),
        audio_blob_id.clone(),
        owner_label,
        sample_rate,
        app_handle.clone(),
    )?;
    refresh_recording_indicator(&app_handle, &recorder);
    Ok(audio_blob_id)
}

/// Stop the recording named by `audio_blob_id`, publish its blob, and report
/// the committed audio.
///
/// Restricted to the window that started it: only the owner can turn its
/// recording into bytes it can then read. A caller that names a recording which
/// has already ended, is not the live one, or belongs to another window gets
/// `NotRecording`, which makes an idempotent stop (push-to-talk releasing after
/// its recording was already supplanted) a clean typed no-op.
#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    audio_blob_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<StoppedRecording> {
    info!("Stopping recording {audio_blob_id}");
    let samples = {
        let mut recorder = lock(&recorder)?;
        // The recorder slot is released by `stop` itself, before the blob is
        // written. The write below is the slow part (fsync), and holding the
        // one host recorder across it would block every other window's start
        // for no benefit: the samples are already in hand and the next
        // recording gets a different id, so nothing can collide.
        let stopped = recorder.stop(&audio_blob_id, window.label());
        // Refreshed before the result is propagated, not after, because the
        // two disagree. An ownership refusal leaves the recording running,
        // while a worker that dies mid-handoff fails *and* ends it. Reading
        // the recorder rather than the result gets both right.
        refresh_recording_indicator(&app_handle, &recorder);
        stopped?
    };

    // Bounded by the same RIFF limit the writer enforces: a sample count that
    // fits in `u32` is at most ~3.1 days of 16 kHz audio.
    let duration_ms = (samples.len() as f64 / TARGET_RATE as f64 * 1000.0).round() as u32;
    // Measured on the critical path on purpose: this synchronous write + fsync
    // is exactly the cost the parked handoff + async-persist optimization would
    // remove. The numbers here decide whether that optimization is worth it.
    //
    // A failure here loses the recording. There is nothing to retry against
    // (the samples are consumed and the slot is already free), so it surfaces
    // as an error rather than pretending a blob exists.
    let byte_length = crate::timing::measure("stop.wav_write+fsync", || {
        write_blob(&app_handle, &audio_blob_id, &samples)
    })?;

    info!("Recording stopped: id={audio_blob_id}, {duration_ms} ms, {byte_length} bytes");
    Ok(StoppedRecording {
        audio_blob_id,
        duration_ms,
        byte_length,
    })
}

/// Cancel the recording named by `audio_blob_id`, discarding its audio.
///
/// Owner-only, and it produces nothing: the minted blob id is burnt and no blob
/// is ever written under it. The host cancels by another route entirely (the
/// owner window being destroyed, wired in `lib.rs`), which needs no command and
/// therefore no grant.
#[tauri::command]
#[specta::specta]
pub async fn cancel_recording(
    audio_blob_id: String,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<()> {
    info!("Cancelling recording {audio_blob_id}");
    let mut recorder = lock(&recorder)?;
    let cancelled = recorder.cancel(&audio_blob_id, window.label());
    refresh_recording_indicator(&app_handle, &recorder);
    cancelled
}

/// The blob id of the recording this window owns, or `null`.
///
/// Reload does not destroy a window, so a window that reloads mid-recording
/// still owns a live recording and would otherwise have no way to name it. This
/// is the only reason the single recorder cannot wedge until the owner window
/// is destroyed.
#[tauri::command]
#[specta::specta]
pub async fn current_recording(
    recorder: State<'_, Mutex<Recorder>>,
    window: WebviewWindow,
) -> Result<Option<String>> {
    debug!("Reading the current recording for {}", window.label());
    Ok(lock(&recorder)?.current(window.label()))
}

/// Cancel whatever recording `owner_label` owns, because that window is gone.
///
/// Not a command: the host calls this from its window-destroyed hook. A
/// destroyed window can never stop or cancel its own recording, so leaving it
/// in flight would hold the one recorder slot until the process exits.
///
/// This runs on the main thread and joins the capture worker, which is safe for
/// two reasons worth stating, because both could quietly stop being true. The
/// wait is bounded: the worker checks its command channel every loop and
/// otherwise blocks for at most 20 ms on samples, so a cancel is noticed within
/// roughly that. And the worker's only main-thread interaction is
/// `Emitter::emit_to` for the mic level, which posts to the event loop without
/// waiting for it. That second point holds only while Tauri's `tracing` feature
/// is off: with it on, `eval_script` switches to a variant that blocks on a
/// reply from the main thread (`tauri-runtime-wry/src/lib.rs:1838-1851`), and a
/// worker emitting while the main thread joins it would deadlock. Nothing in
/// this dependency graph enables that feature; if something ever does, move
/// this call off the main thread.
pub fn cancel_recording_owned_by(app: &AppHandle, owner_label: &str) {
    let Some(recorder) = app.try_state::<Mutex<Recorder>>() else {
        return;
    };
    let Ok(mut recorder) = recorder.lock() else {
        return;
    };
    if let Some(audio_blob_id) = recorder.cancel_owned_by(owner_label) {
        info!("Window '{owner_label}' was destroyed; cancelled recording {audio_blob_id}");
    }
    refresh_recording_indicator(app, &recorder);
}
