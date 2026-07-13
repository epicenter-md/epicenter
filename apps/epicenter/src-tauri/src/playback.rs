//! Recording-scoped suppression of other apps' audio.
//!
//! The SPA passes only the selected policy into native recording startup. The
//! recorder supplies its own session id to this manager; platform session
//! identifiers and output-device snapshots never cross IPC. Serializing every
//! mutation prevents a quick stop and restart from restoring an older effect
//! over a newer recording.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use crate::recorder::recorder::Recorder;
use serde::{Deserialize, Serialize};
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
    recording_id: Option<String>,
    effect: Option<platform::Effect>,
}

impl PlaybackSuppressionState {
    async fn release(&mut self, recording_id: &str) {
        if self.recording_id.as_deref() != Some(recording_id) {
            return;
        }
        self.restore().await;
    }

    async fn restore(&mut self) {
        self.recording_id = None;
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

impl PlaybackSuppressionManager {
    pub async fn begin_recording(
        &self,
        recording_id: String,
        mode: PlaybackSuppressionMode,
        recorder: &StdMutex<Recorder>,
    ) -> Result<(), String> {
        let active_recording_id = recorder
            .lock()
            .map_err(|error| format!("failed to inspect recorder: {error}"))?
            .get_current_recording_id();
        if active_recording_id.as_deref() != Some(recording_id.as_str()) {
            return Err("recording is no longer active".to_string());
        }

        let mut state = self.state.lock().await;
        if state.recording_id.as_deref() == Some(recording_id.as_str()) {
            return Ok(());
        }
        state.restore().await;
        state.recording_id = Some(recording_id.clone());
        match platform::suppress(mode).await {
            Ok(effect) => state.effect = Some(effect),
            Err(error) => log::warn!("playback suppression failed: {error}"),
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

    pub async fn release_recording(&self, recording_id: &str) {
        let mut state = self.state.lock().await;
        state.release(recording_id).await;
    }

    /// Restore any active suppression before the native process exits.
    pub fn restore_on_exit(&self) {
        let mut state = self.state.blocking_lock();
        state.recording_id = None;
        let Some(effect) = state.effect.take() else {
            return;
        };
        if let Err(error) = tauri::async_runtime::block_on(platform::restore(effect)) {
            log::warn!("playback restoration during exit failed: {error}");
        }
    }
}
