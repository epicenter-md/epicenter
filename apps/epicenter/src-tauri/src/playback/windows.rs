//! Best-effort Windows playback suppression through GSMTC.
//!
//! `GlobalSystemMediaTransportControlsSession` is `Send + Sync` in the Windows
//! crate, so the effect retains the exact WinRT session objects that accepted
//! pause instead of collapsing them to an app id. Restoration still requires
//! each retained session to be visibly paused.

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use super::{PlaybackSuppressionMode, DUCK_TARGET};
const VOLUME_EPSILON: f32 = 0.001;

pub(super) struct Effect {
    kind: EffectKind,
}

enum EffectKind {
    Pause(Vec<GlobalSystemMediaTransportControlsSession>),
    Volume(Option<VolumeSnapshot>),
    Mute(Option<MuteSnapshot>),
}

struct VolumeSnapshot {
    endpoint_id: String,
    original: f32,
    applied: f32,
}

struct MuteSnapshot {
    endpoint_id: String,
    original: bool,
    applied: bool,
}

pub(super) async fn suppress(mode: PlaybackSuppressionMode) -> Result<Effect, String> {
    tokio::task::spawn_blocking(move || on_com_mta_thread(move || suppress_com(mode)))
        .await
        .map_err(|error| format!("Failed to suppress playback: {error}"))?
}

pub(super) async fn restore(effect: Effect) -> Result<(), String> {
    tokio::task::spawn_blocking(move || on_com_mta_thread(move || restore_com(effect)))
        .await
        .map_err(|error| format!("Failed to restore playback: {error}"))?
}

fn on_com_mta_thread<T, F>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    std::thread::spawn(move || {
        let owns_com = unsafe { co_init_mta() };
        let result = operation();
        if owns_com {
            // SAFETY: balanced with the successful CoInitializeEx below.
            unsafe { CoUninitialize() };
        }
        result
    })
    .join()
    .map_err(|_| "playback COM worker thread panicked".to_string())
}

unsafe fn co_init_mta() -> bool {
    const RPC_E_CHANGED_MODE: i32 = -2_147_417_850;
    let result = CoInitializeEx(None, COINIT_MULTITHREADED);
    if result.0 >= 0 {
        true
    } else {
        if result.0 != RPC_E_CHANGED_MODE {
            log::warn!("CoInitializeEx(MTA) failed: 0x{:08X}", result.0);
        }
        false
    }
}

fn suppress_com(mode: PlaybackSuppressionMode) -> Effect {
    let kind = match mode {
        PlaybackSuppressionMode::Pause => EffectKind::Pause(suppress_pause()),
        PlaybackSuppressionMode::Duck => EffectKind::Volume(suppress_volume()),
        PlaybackSuppressionMode::Mute => EffectKind::Mute(suppress_mute()),
    };
    Effect { kind }
}

fn suppress_pause() -> Vec<GlobalSystemMediaTransportControlsSession> {
    let mut paused = Vec::new();
    let Some(manager) = request_manager() else {
        return paused;
    };
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(error) => {
            log::debug!("GSMTC GetSessions failed: {error}");
            return paused;
        }
    };
    for session in sessions {
        match pause_session_if_playing(&session) {
            Ok(true) => paused.push(session),
            Ok(false) => {}
            Err(error) => log::warn!("GSMTC pause failed: {error}"),
        }
    }
    paused
}

fn restore_com(effect: Effect) {
    match effect.kind {
        EffectKind::Pause(sessions) => restore_paused(sessions),
        EffectKind::Volume(snapshot) => restore_volume(snapshot),
        EffectKind::Mute(snapshot) => restore_mute(snapshot),
    }
}

fn restore_paused(sessions: Vec<GlobalSystemMediaTransportControlsSession>) {
    for session in sessions {
        if let Err(error) = restore_session_if_paused(&session) {
            log::warn!("GSMTC restore failed: {error}");
        }
    }
}

fn suppress_volume() -> Option<VolumeSnapshot> {
    let (device, endpoint) = default_endpoint().ok()?;
    let endpoint_id = device_id(&device).ok()?;
    let original = unsafe { endpoint.GetMasterVolumeLevelScalar().ok()? };
    let requested = original.min(DUCK_TARGET);
    if approximately_equal(original, requested) {
        return None;
    }
    unsafe {
        endpoint
            .SetMasterVolumeLevelScalar(requested, std::ptr::null())
            .ok()?;
    }
    let applied = unsafe { endpoint.GetMasterVolumeLevelScalar().unwrap_or(requested) };
    Some(VolumeSnapshot {
        endpoint_id,
        original,
        applied,
    })
}

fn suppress_mute() -> Option<MuteSnapshot> {
    let (device, endpoint) = default_endpoint().ok()?;
    let endpoint_id = device_id(&device).ok()?;
    let original = unsafe { endpoint.GetMute().ok()?.as_bool() };
    if original {
        return None;
    }
    unsafe { endpoint.SetMute(true, std::ptr::null()).ok()? };
    let applied = unsafe {
        endpoint
            .GetMute()
            .map(|value| value.as_bool())
            .unwrap_or(true)
    };
    Some(MuteSnapshot {
        endpoint_id,
        original,
        applied,
    })
}

fn restore_volume(snapshot: Option<VolumeSnapshot>) {
    let Some(snapshot) = snapshot else {
        return;
    };
    let Ok((device, endpoint)) = default_endpoint() else {
        return;
    };
    if device_id(&device).as_deref() != Ok(snapshot.endpoint_id.as_str()) {
        return;
    }
    let current = unsafe { endpoint.GetMasterVolumeLevelScalar() };
    if current.is_ok_and(|value| approximately_equal(value, snapshot.applied)) {
        let _ = unsafe { endpoint.SetMasterVolumeLevelScalar(snapshot.original, std::ptr::null()) };
    }
}

fn restore_mute(snapshot: Option<MuteSnapshot>) {
    let Some(snapshot) = snapshot else {
        return;
    };
    let Ok((device, endpoint)) = default_endpoint() else {
        return;
    };
    if device_id(&device).as_deref() != Ok(snapshot.endpoint_id.as_str()) {
        return;
    }
    let current = unsafe { endpoint.GetMute() };
    if current.is_ok_and(|value| value.as_bool() == snapshot.applied) {
        let _ = unsafe { endpoint.SetMute(snapshot.original, std::ptr::null()) };
    }
}

fn default_endpoint() -> windows::core::Result<(IMMDevice, IAudioEndpointVolume)> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole)? };
    let endpoint = unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)? };
    Ok((device, endpoint))
}

fn device_id(device: &IMMDevice) -> Result<String, String> {
    let value = unsafe { device.GetId() }.map_err(|error| error.to_string())?;
    let id = unsafe { value.to_string() }.map_err(|error| error.to_string());
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    id
}

fn approximately_equal(left: f32, right: f32) -> bool {
    (left - right).abs() <= VOLUME_EPSILON
}

fn request_manager() -> Option<GlobalSystemMediaTransportControlsSessionManager> {
    let operation = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(operation) => operation,
        Err(error) => {
            log::debug!("GSMTC RequestAsync failed: {error}");
            return None;
        }
    };
    match operation.join() {
        Ok(manager) => Some(manager),
        Err(error) => {
            log::debug!("GSMTC RequestAsync await failed: {error}");
            None
        }
    }
}

fn pause_session_if_playing(
    session: &GlobalSystemMediaTransportControlsSession,
) -> windows::core::Result<bool> {
    let info = session.GetPlaybackInfo()?;
    if info.PlaybackStatus()? != GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        return Ok(false);
    }
    let aumid = session.SourceAppUserModelId()?.to_string();
    if session.TryPauseAsync()?.join()? {
        Ok(true)
    } else {
        log::debug!("GSMTC session {aumid} declined pause");
        Ok(false)
    }
}

fn restore_session_if_paused(
    session: &GlobalSystemMediaTransportControlsSession,
) -> windows::core::Result<()> {
    let info = session.GetPlaybackInfo()?;
    if info.PlaybackStatus()? != GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused {
        return Ok(());
    }
    session.TryPlayAsync()?.join()?;
    Ok(())
}
