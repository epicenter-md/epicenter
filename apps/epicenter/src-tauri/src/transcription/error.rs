use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },

    /// The per-call spec holds a model id that cannot be resolved to a
    /// downloaded GGUF (no selection, an unknown id, or a not-yet-downloaded
    /// model).
    #[error("Transcription config error: {message}")]
    ConfigError { message: String },
}
