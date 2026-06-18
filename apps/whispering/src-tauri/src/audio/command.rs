//! Tauri command surface for the audio module. One endpoint:
//! `encode_recording_for_upload(recording_id)` produces the mono 16 kHz PCM
//! for a recording, then re-encodes it to OGG/Opus for cloud upload. On the
//! live cloud path it takes the finalized PCM straight from the in-process
//! [`PcmHandoff`] the recorder stashed at stop; on a miss (history re-encode)
//! it falls back to decoding the durable WAV (same path the local engines use
//! via `read_artifact_samples`).

use log::warn;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use super::encode::encode_pcm_to_opus_ogg;
use super::PcmHandoff;
use crate::recorder::read_artifact_samples;

/// Compress a saved recording artifact into OGG/Opus for cloud upload.
///
/// Returns a raw IPC byte body via `tauri::ipc::Response`. tauri-specta
/// cannot generate either bindings or a runtime handler for this shape
/// because `Response` is not `specta::Type`, so the command is mounted
/// through a separate `tauri::generate_handler!` and hand-rolled at the
/// JS boundary (`src/lib/tauri/commands.ts`) where callers see
/// `Promise<Result<ArrayBuffer, string>>`.
///
/// JS call shape:
/// ```js
/// const compressed = await invoke('encode_recording_for_upload', {
///   recordingId,
/// });
/// ```
#[tauri::command]
pub async fn encode_recording_for_upload(
    recording_id: String,
    app_handle: AppHandle,
) -> Result<Response, String> {
    // Take the live PCM before moving `app_handle` into the blocking task. The
    // guard borrows `app_handle`, so resolve it to an owned `Option<Vec<f32>>`
    // here and only the samples cross into the closure.
    let handoff_samples = app_handle.state::<PcmHandoff>().take(&recording_id);
    tauri::async_runtime::spawn_blocking(move || {
        let samples = match handoff_samples {
            Some(samples) => {
                crate::timing_note!(
                    "encode.handoff hit id={recording_id} samples={}",
                    samples.len()
                );
                samples
            }
            None => {
                crate::timing_note!("encode.handoff miss id={recording_id} (decoding wav)");
                crate::timing::measure("encode.read+decode", || {
                    read_artifact_samples(&app_handle, &recording_id)
                })?
            }
        };
        // 16 kHz is the rate every recording's PCM lands on (the recorder
        // finalizes to `ARTIFACT_RATE`, and `read_artifact_samples` decodes to
        // it); pass it through so the encoder's source-to-48k resample sees the
        // right input rate.
        crate::timing::measure("encode.opus", || {
            encode_pcm_to_opus_ogg(samples, 16_000).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e
    })
}
