//! Recording-scoped suppression of other apps' audio.
//!
//! Whispering passes only recording ids. Platform session identifiers and
//! output-device snapshots stay in this host-owned manager, which serializes
//! every mutation so a quick stop and restart cannot restore an older epoch
//! over a newer recording.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use crate::recorder::recorder::Recorder;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::PlaybackSuppressionMode;

    pub struct Effect;

    pub async fn suppress(_mode: PlaybackSuppressionMode) -> Result<Effect, String> {
        Ok(Effect)
    }

    pub async fn restore(_effect: Effect) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackSuppressionMode {
    Duck,
    Mute,
    Pause,
}

const DUCK_TARGET: f32 = 0.2;

#[derive(Default)]
struct PlaybackSuppressionState {
    active: HashSet<String>,
    effect: Option<platform::Effect>,
}

impl PlaybackSuppressionState {
    async fn release(&mut self, recording_id: &str) {
        if !self.active.remove(recording_id) || !self.active.is_empty() {
            return;
        }
        let Some(effect) = self.effect.take() else {
            return;
        };
        if let Err(error) = platform::restore(effect).await {
            log::warn!("playback restoration failed: {error}");
        }
    }
}

#[derive(Clone, Default)]
pub struct PlaybackSuppressionManager {
    state: Arc<Mutex<PlaybackSuppressionState>>,
}

/// Suppress other apps' audio for `recording_id`. Idempotent per recording, so
/// a reloaded webview reconnecting to an already-active native recording never
/// starts a second suppression epoch.
#[tauri::command]
#[specta::specta]
pub async fn begin_playback_suppression(
    recording_id: String,
    mode: PlaybackSuppressionMode,
    manager: State<'_, PlaybackSuppressionManager>,
    recorder: State<'_, StdMutex<Recorder>>,
) -> Result<(), String> {
    let active_recording_id = recorder
        .lock()
        .map_err(|error| format!("failed to inspect recorder: {error}"))?
        .get_current_recording_id();
    if active_recording_id.as_deref() != Some(recording_id.as_str()) {
        return Err("recording is no longer active".to_string());
    }

    let mut state = manager.state.lock().await;
    let starts_epoch = state.active.is_empty();
    state.active.insert(recording_id.clone());
    if starts_epoch {
        match platform::suppress(mode).await {
            Ok(effect) => state.effect = Some(effect),
            Err(error) => log::warn!("playback suppression failed: {error}"),
        }
    }

    let still_active = recorder
        .lock()
        .map_err(|error| format!("failed to recheck recorder: {error}"))?
        .get_current_recording_id()
        .as_deref()
        == Some(recording_id.as_str());
    if !still_active {
        state.release(&recording_id).await;
        return Err("recording ended while suppressing playback".to_string());
    }
    Ok(())
}

/// End suppression for `recording_id`. Unknown and duplicate ids are harmless;
/// only the final active recording restores the platform state Epicenter
/// changed.
#[tauri::command]
#[specta::specta]
pub async fn end_playback_suppression(
    recording_id: String,
    manager: State<'_, PlaybackSuppressionManager>,
) -> Result<(), String> {
    let mut state = manager.state.lock().await;
    state.release(&recording_id).await;
    Ok(())
}

impl PlaybackSuppressionManager {
    pub async fn release_recording(&self, recording_id: &str) {
        let mut state = self.state.lock().await;
        state.release(recording_id).await;
    }

    /// Restore any active suppression before the native process exits.
    pub fn restore_on_exit(&self) {
        let mut state = self.state.blocking_lock();
        state.active.clear();
        let Some(effect) = state.effect.take() else {
            return;
        };
        if let Err(error) = tauri::async_runtime::block_on(platform::restore(effect)) {
            log::warn!("playback restoration during exit failed: {error}");
        }
    }
}
