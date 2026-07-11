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
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub(super) struct Effect {
    sessions: Vec<GlobalSystemMediaTransportControlsSession>,
}

pub(super) async fn suppress() -> Result<Effect, String> {
    tokio::task::spawn_blocking(|| on_com_mta_thread(suppress_com))
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

fn suppress_com() -> Effect {
    let mut paused = Vec::new();
    let Some(manager) = request_manager() else {
        return Effect { sessions: paused };
    };
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(error) => {
            log::debug!("GSMTC GetSessions failed: {error}");
            return Effect { sessions: paused };
        }
    };
    for session in sessions {
        match pause_session_if_playing(&session) {
            Ok(true) => paused.push(session),
            Ok(false) => {}
            Err(error) => log::warn!("GSMTC pause failed: {error}"),
        }
    }
    Effect { sessions: paused }
}

fn restore_com(effect: Effect) {
    for session in effect.sessions {
        if let Err(error) = restore_session_if_paused(&session) {
            log::warn!("GSMTC restore failed: {error}");
        }
    }
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
