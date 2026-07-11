//! Recording-scoped suppression of background audio.
//!
//! Whispering receives only an opaque lease. Platform session identifiers and
//! output-device snapshots stay in this host-owned manager, which serializes
//! every mutation so a quick stop and restart cannot restore an older epoch
//! over a newer recording.

use std::collections::HashMap;
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

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackSuppressionLease {
    id: String,
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
struct LeaseRegistry {
    by_recording: HashMap<String, String>,
    next_id: u64,
}

impl LeaseRegistry {
    fn acquire(&mut self, recording_id: &str) -> (PlaybackSuppressionLease, bool) {
        if let Some(id) = self.by_recording.get(recording_id) {
            return (PlaybackSuppressionLease { id: id.clone() }, false);
        }

        let starts_epoch = self.by_recording.is_empty();
        self.next_id += 1;
        let id = format!("playback-suppression-{}", self.next_id);
        self.by_recording
            .insert(recording_id.to_string(), id.clone());
        (PlaybackSuppressionLease { id }, starts_epoch)
    }

    fn release(&mut self, lease: &PlaybackSuppressionLease) -> bool {
        let recording_id = self
            .by_recording
            .iter()
            .find_map(|(recording_id, id)| (id == &lease.id).then(|| recording_id.clone()));
        let Some(recording_id) = recording_id else {
            return false;
        };
        self.by_recording.remove(&recording_id);
        true
    }

    fn is_empty(&self) -> bool {
        self.by_recording.is_empty()
    }
}

#[derive(Default)]
struct PlaybackSuppressionState {
    leases: LeaseRegistry,
    effect: Option<platform::Effect>,
}

impl PlaybackSuppressionState {
    async fn release(&mut self, lease: &PlaybackSuppressionLease) {
        if !self.leases.release(lease) || !self.leases.is_empty() {
            return;
        }
        let Some(effect) = self.effect.take() else {
            return;
        };
        if let Err(error) = platform::restore(effect).await {
            log::warn!("background audio restoration failed: {error}");
        }
    }
}

#[derive(Clone, Default)]
pub struct PlaybackSuppressionManager {
    state: Arc<Mutex<PlaybackSuppressionState>>,
}

/// Suppress background audio for `recording_id`, returning the same lease when
/// a reloaded webview reconnects to an already-active native recording.
#[tauri::command]
#[specta::specta]
pub async fn begin_playback_suppression(
    recording_id: String,
    mode: PlaybackSuppressionMode,
    manager: State<'_, PlaybackSuppressionManager>,
    recorder: State<'_, StdMutex<Recorder>>,
) -> Result<PlaybackSuppressionLease, String> {
    let active_recording_id = recorder
        .lock()
        .map_err(|error| format!("failed to inspect recorder: {error}"))?
        .get_current_recording_id();
    if active_recording_id.as_deref() != Some(recording_id.as_str()) {
        return Err("recording is no longer active".to_string());
    }

    let mut state = manager.state.lock().await;
    let (lease, starts_epoch) = state.leases.acquire(&recording_id);
    if starts_epoch {
        match platform::suppress(mode).await {
            Ok(effect) => state.effect = Some(effect),
            Err(error) => log::warn!("background audio suppression failed: {error}"),
        }
    }

    let still_active = recorder
        .lock()
        .map_err(|error| format!("failed to recheck recorder: {error}"))?
        .get_current_recording_id()
        .as_deref()
        == Some(recording_id.as_str());
    if !still_active {
        state.release(&lease).await;
        return Err("recording ended while suppressing background audio".to_string());
    }
    Ok(lease)
}

/// Release an opaque lease. Unknown and duplicate leases are harmless; only
/// the final active recording restores the platform state Epicenter changed.
#[tauri::command]
#[specta::specta]
pub async fn end_playback_suppression(
    lease: PlaybackSuppressionLease,
    manager: State<'_, PlaybackSuppressionManager>,
) -> Result<(), String> {
    let mut state = manager.state.lock().await;
    state.release(&lease).await;
    Ok(())
}

impl PlaybackSuppressionManager {
    pub async fn release_recording(&self, recording_id: &str) {
        let mut state = self.state.lock().await;
        let Some(id) = state.leases.by_recording.get(recording_id).cloned() else {
            return;
        };
        let lease = PlaybackSuppressionLease { id };
        state.release(&lease).await;
    }

    /// Restore any active suppression before the native process exits.
    pub fn restore_on_exit(&self) {
        let mut state = self.state.blocking_lock();
        state.leases = LeaseRegistry::default();
        let Some(effect) = state.effect.take() else {
            return;
        };
        if let Err(error) = tauri::async_runtime::block_on(platform::restore(effect)) {
            log::warn!("background audio restoration during exit failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LeaseRegistry, PlaybackSuppressionLease};

    #[test]
    fn reacquiring_recording_returns_existing_lease() {
        let mut registry = LeaseRegistry::default();
        let (first, first_inserted) = registry.acquire("recording-1");
        let (second, second_inserted) = registry.acquire("recording-1");

        assert!(first_inserted);
        assert!(!second_inserted);
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn only_known_final_lease_empties_registry() {
        let mut registry = LeaseRegistry::default();
        let (first, _) = registry.acquire("recording-1");
        let (second, _) = registry.acquire("recording-2");

        assert!(!registry.release(&PlaybackSuppressionLease {
            id: "unknown".to_string(),
        }));
        assert!(registry.release(&first));
        assert!(!registry.is_empty());
        assert!(!registry.release(&first));
        assert!(registry.release(&second));
        assert!(registry.is_empty());
    }
}
