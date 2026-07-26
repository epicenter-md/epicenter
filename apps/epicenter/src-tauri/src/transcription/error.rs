use super::UnavailableReason;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    /// The local route cannot run at all: no model is active on this device, or
    /// the active model's file is not here.
    ///
    /// One public precondition family (ADR-0180). The two cases differ only as
    /// compact `reason` data, because the caller's job is the same either way:
    /// say so honestly and point at Home. `message` never names a model, since
    /// model identity is administration data an application does not receive.
    ///
    /// Failing here changes nothing. No model is adopted, downloaded,
    /// substituted, or routed to the cloud on the caller's behalf.
    #[error("Local transcription unavailable: {message}")]
    LocalRouteUnavailable {
        reason: UnavailableReason,
        message: String,
    },

    /// Operational, not a precondition: the active model was resolvable but the
    /// runtime could not load it. Kept distinct so a broken install does not
    /// read as "you have not set this up".
    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    /// Operational: inference itself failed.
    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },
}
