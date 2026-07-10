use crate::recorder::artifact::{
    clear_artifacts, delete_artifacts, read_artifact_bytes, write_artifact, RecordingArtifact,
};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

const RECORDER_STATE_CHANGED: &str = "recorder:state-changed";

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "UPPERCASE")]
enum RecordingState {
    Idle,
    Recording,
}

fn emit_recording_state(app: &AppHandle, state: RecordingState) {
    crate::shell::set_tray_recording_state(app, matches!(state, RecordingState::Recording));
    if let Err(e) = app.emit(RECORDER_STATE_CHANGED, state) {
        warn!(
            "Failed to emit {} = {:?}: {}",
            RECORDER_STATE_CHANGED, state, e
        );
    }
}

#[tauri::command]
#[specta::specta]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    recorder.enumerate_devices()
}

#[tauri::command]
#[specta::specta]
pub async fn init_recording_session(
    device_identifier: String,
    recording_id: String,
    sample_rate: Option<u32>,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!(
        "Initializing recording session: device={device_identifier}, id={recording_id}, sample_rate={sample_rate:?}",
    );

    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.init_session(
            device_identifier,
            recording_id,
            sample_rate,
            app_handle.clone(),
        )?;
    }
    // init_session calls close_session internally as cleanup. If the previous
    // session was actively recording, that transition is silent at the domain
    // layer; emit IDLE here so the JS state never diverges from reality.
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Starting recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.start_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Recording);
    Ok(())
}

/// Stop the recorder, write the canonical WAV artifact to
/// `<appDataDir>/recordings/{id}.wav`, return the small JSON handle.
///
/// JS never sees raw PCM samples on the wire: later operations look the
/// file up by id (`transcribe_recording`, `encode_recording_for_upload`,
/// and `delete_recording_artifacts`).
#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<RecordingArtifact> {
    info!("Stopping recording");
    let (recording_id, samples) = {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        let id = recorder
            .session_id()
            .ok_or_else(|| RecorderError::failed("no active recording session at stop"))?;
        let samples = recorder.stop_recording()?;
        (id, samples)
    };

    // Measured on the critical path on purpose: this synchronous write + fsync
    // is exactly the cost the parked handoff + async-persist optimization would
    // remove. The numbers here decide whether that optimization is worth it.
    let artifact = crate::timing::measure("stop.wav_write+fsync", || {
        write_artifact(&app_handle, &recording_id, &samples)
    })?;
    emit_recording_state(&app_handle, RecordingState::Idle);
    info!(
        "Recording stopped: id={}, duration_ms={}, bytes={}",
        artifact.id, artifact.duration_ms, artifact.byte_length,
    );
    Ok(artifact)
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Cancelling recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.cancel_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn close_recording_session(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Closing recording session");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.close_session()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_current_recording_id(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Option<String>> {
    debug!("Getting current recording ID");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    Ok(recorder.get_current_recording_id())
}

/// Delete recording artifacts by id.
///
/// This is intentionally id-based instead of path-based. The recorder
/// artifact module owns which files under the recordings directory are blobs,
/// so TypeScript callers cannot accidentally delete markdown sidecars or
/// arbitrary files. Missing artifacts are ignored to keep cleanup retryable.
#[tauri::command]
#[specta::specta]
pub async fn delete_recording_artifacts(
    recording_ids: Vec<String>,
    app_handle: AppHandle,
) -> Result<u32> {
    info!("Deleting {} recording artifacts", recording_ids.len());
    tokio::task::spawn_blocking(move || delete_artifacts(&app_handle, &recording_ids))
        .await
        .map_err(|e| RecorderError::failed(format!("Task join error: {e}")))?
}

/// Delete every recording artifact while preserving markdown sidecars.
///
/// Used by the blob store's `clear()` path. The Rust layer owns the directory
/// scan because it has the same artifact matching rule used by targeted
/// deletion and transcription lookup.
#[tauri::command]
#[specta::specta]
pub async fn clear_recording_artifacts(app_handle: AppHandle) -> Result<u32> {
    info!("Clearing recording artifacts");
    tokio::task::spawn_blocking(move || clear_artifacts(&app_handle))
        .await
        .map_err(|e| RecorderError::failed(format!("Task join error: {e}")))?
}

/// Read one recording artifact as a raw IPC byte body.
///
/// This command deliberately accepts an app-owned id rather than a path. Its
/// raw response lives outside tauri-specta and has a handwritten TypeScript
/// wrapper, matching `encode_recording_for_upload`.
#[tauri::command]
pub async fn read_recording_artifact(
    recording_id: String,
    app_handle: AppHandle,
) -> std::result::Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_artifact_bytes(&app_handle, &recording_id))
        .await
        .map_err(|e| format!("background artifact read failed: {e}"))?
        .map(Response::new)
        .map_err(|e| e.to_string())
}
