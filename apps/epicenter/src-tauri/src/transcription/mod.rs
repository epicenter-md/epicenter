mod catalog;
mod config;
mod error;
mod model_cache;
mod settings;

pub use catalog::{
    delete_model, download_model, list_models, ActiveModel, CatalogError, ModelInfo,
};
pub use config::TranscriptionSpec;
pub use error::TranscriptionError;
pub use model_cache::ModelCache;
pub use settings::{LocalTranscriptionSettings, SettingsError, UnloadPolicy};

use crate::recorder::read_blob_samples;
use tauri::{AppHandle, State};

// ── Home: model administration ────────────────────────────────────────

/// The active local model's identity and whether it can run right now, or
/// `None` when nobody has chosen one.
///
/// **Administration only.** Home holds this grant because Home chooses the
/// active model and must show which one that is (ADR-0180).
#[tauri::command]
#[specta::specta]
pub fn get_active_model(model_cache: State<'_, ModelCache>) -> Option<ActiveModel> {
    model_cache
        .settings()
        .active_model_id()
        .as_deref()
        .and_then(catalog::describe)
}

/// Make `model_id` the active local model, or clear the choice with `null`.
/// Home's administration write: the only way the active model changes.
#[tauri::command]
#[specta::specta]
pub fn set_active_model(
    model_id: Option<String>,
    model_cache: State<'_, ModelCache>,
) -> Result<(), SettingsError> {
    model_cache.settings().set_active_model_id(model_id)
}

/// When the host drops the resident model.
#[tauri::command]
#[specta::specta]
pub fn get_unload_policy(model_cache: State<'_, ModelCache>) -> UnloadPolicy {
    model_cache.settings().unload_policy()
}

/// Set the unload policy. Host-owned and durable alongside the active model:
/// Rust owns the idle clock because a backgrounded webview timer throttles
/// exactly when idle eviction must fire (ADR-0012), and now owns the value too,
/// so it applies from launch instead of waiting for a webview to reconcile it.
/// It carries no model identity, so it applies whether or not a model is active.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy(
    policy: UnloadPolicy,
    model_cache: State<'_, ModelCache>,
) -> Result<(), SettingsError> {
    model_cache.settings().set_unload_policy(policy)
}

/// Canonical transcribe-by-id path. Resolves the canonical local blob,
/// decodes it, then runs inference using
/// the per-call transcription spec supplied by the frontend.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    audio_blob_id: String,
    spec: TranscriptionSpec,
    app_handle: AppHandle,
    model_cache: State<'_, ModelCache>,
) -> Result<String, TranscriptionError> {
    let samples = crate::timing::measure("transcribe.read+decode", || {
        read_blob_samples(&app_handle, &audio_blob_id)
    })
    .map_err(|e| TranscriptionError::AudioReadError {
        message: e.to_string(),
    })?;

    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.transcribe(samples, spec))
        .await
        .map_err(join_err)?
}

/// Prewarm the local model for `spec` so a following transcribe finds it
/// warm. The frontend fires this fire-and-forget at capture start (manual
/// record or VAD listen) for a local provider, overlapping the ~1 s model
/// load with the user's speech instead of paying it after they stop.
///
/// Idempotent and cheap: a no-op when the exact model is already resident.
/// Shares the one load path with `transcribe_recording` (`ModelCache::prewarm`
/// and `transcribe` both resolve through `ensure_loaded`), so the model warmed
/// here is exactly the one transcribe will use, and a mid-recording model change
/// simply reloads at transcribe time. A failure here is non-fatal: transcribe
/// will load normally and surface any real error then.
#[tauri::command]
#[specta::specta]
pub async fn prewarm_model(
    spec: TranscriptionSpec,
    model_cache: State<'_, ModelCache>,
) -> Result<(), TranscriptionError> {
    let cache = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.prewarm(&spec))
        .await
        .map_err(join_err)?
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}
