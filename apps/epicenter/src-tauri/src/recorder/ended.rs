//! Why a recording ended without anyone asking it to.
//!
//! The capture stream can die under a live recording: the microphone is
//! unplugged, macOS revokes microphone access mid-dictation, the audio route
//! collapses. Before this existed, cpal's error callback only logged, so the
//! recorder kept its one slot occupied, the tray kept claiming a recording, and
//! the owning window waited forever for audio that would never arrive.
//!
//! # The taxonomy is exactly as fine as cpal's evidence
//!
//! Every variant below is one the host can actually tell apart from a typed
//! `cpal::ErrorKind`, and each maps to a different thing the person can do.
//! Nothing here is inferred from a message string, and nothing distinguishes
//! two situations the host would have to guess between.
//!
//! # Not every stream error is terminal
//!
//! This is the part that is easy to get wrong. cpal reports routine, survivable
//! conditions through the same callback as fatal ones, and it documents which
//! is which. `DeviceChanged` explicitly says the stream stays active and needs
//! no rebuild, which is what happens when headphones are plugged in mid
//! sentence. `Xrun` is a glitched buffer. `RealtimeDenied` means audio keeps
//! flowing with worse scheduling. Ending a recording on any of those would
//! destroy a dictation over an event the user would otherwise never notice, so
//! [`classify`] returns `None` for them and the capture continues.

use serde::{Deserialize, Serialize};

/// Why the host ended a recording on its own.
///
/// This never describes a stop, a cancel, or an owner window being destroyed.
/// Those are endings someone asked for, and the caller already knows about them
/// from its own call returning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EndedReason {
    /// The microphone went away while recording (`ErrorKind::DeviceNotAvailable`).
    /// The recovery is physical: reconnect it, or pick another input.
    DeviceDisconnected,
    /// The OS withdrew microphone access mid-recording
    /// (`ErrorKind::PermissionDenied`). The device is still there and still
    /// works; the recovery is a permission toggle, which is why this is not
    /// folded into `DeviceDisconnected`.
    PermissionRevoked,
    /// The capture stream failed for a reason the host cannot make actionable:
    /// the configuration was invalidated, the audio host vanished, a resource
    /// limit was hit, or the backend reported something cpal could not classify.
    /// One variant rather than five, because the person does the same thing
    /// about all of them.
    StreamFailed,
}

/// Classify a live-stream error, or `None` when the stream survives it.
///
/// `None` is the important half of this function: it is what keeps a routine
/// audio-route change from ending a recording.
pub fn classify(error: &cpal::Error) -> Option<EndedReason> {
    use cpal::ErrorKind;
    match error.kind() {
        // Documented as survivable by cpal, so the capture keeps running.
        ErrorKind::DeviceChanged | ErrorKind::Xrun | ErrorKind::RealtimeDenied => None,
        ErrorKind::DeviceNotAvailable | ErrorKind::DeviceBusy => {
            Some(EndedReason::DeviceDisconnected)
        }
        ErrorKind::PermissionDenied => Some(EndedReason::PermissionRevoked),
        _ => Some(EndedReason::StreamFailed),
    }
}

/// Pushed to the window that owns a recording when the host ends it without
/// being asked. Carries the blob id so a window that has since started another
/// recording can tell which one died, and the reason so it can say something
/// true about what happened.
///
/// The blob id is burnt, exactly as it is by `cancel`: no blob is written and
/// the captured audio is discarded. See the module docs on
/// `commands::abandon_recording` for why.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEndedEvent {
    pub audio_blob_id: String,
    pub reason: EndedReason,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::{Error as CpalError, ErrorKind};

    /// The regression this module exists to prevent: plugging in headphones
    /// mid-dictation raises `DeviceChanged`, and cpal documents the stream as
    /// still active. Ending the recording there would be a data-loss bug that
    /// only shows up on real hardware.
    #[test]
    fn survivable_stream_errors_do_not_end_the_recording() {
        for kind in [
            ErrorKind::DeviceChanged,
            ErrorKind::Xrun,
            ErrorKind::RealtimeDenied,
        ] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                None,
                "{kind:?} must not end a recording"
            );
        }
    }

    #[test]
    fn a_vanished_microphone_reads_as_disconnected() {
        for kind in [ErrorKind::DeviceNotAvailable, ErrorKind::DeviceBusy] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                Some(EndedReason::DeviceDisconnected)
            );
        }
    }

    /// Kept apart from `DeviceDisconnected` because the recovery differs: the
    /// microphone is present and working, and the fix is a permission toggle.
    #[test]
    fn a_withdrawn_grant_reads_as_permission_revoked() {
        assert_eq!(
            classify(&CpalError::new(ErrorKind::PermissionDenied)),
            Some(EndedReason::PermissionRevoked)
        );
    }

    #[test]
    fn everything_else_terminal_collapses_to_stream_failed() {
        for kind in [
            ErrorKind::StreamInvalidated,
            ErrorKind::HostUnavailable,
            ErrorKind::ResourceExhausted,
            ErrorKind::BackendError,
            ErrorKind::UnsupportedConfig,
            ErrorKind::Other,
        ] {
            assert_eq!(
                classify(&CpalError::new(kind)),
                Some(EndedReason::StreamFailed),
                "{kind:?} should collapse to StreamFailed"
            );
        }
    }

    #[test]
    fn the_reason_crosses_the_wire_as_a_camel_case_name() {
        let json = serde_json::to_value(RecordingEndedEvent {
            audio_blob_id: "blob_aaaaaaaaaaaaaaaaaaaaa".to_string(),
            reason: EndedReason::DeviceDisconnected,
        })
        .unwrap();
        assert_eq!(json["audioBlobId"], "blob_aaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(json["reason"], "deviceDisconnected");
    }
}
