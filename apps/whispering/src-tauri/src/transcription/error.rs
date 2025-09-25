use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    #[error("GPU error: {message}")]
    GpuError { message: String },

    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },
}

impl TranscriptionError {
    pub fn name(&self) -> &'static str {
        match self {
            TranscriptionError::AudioReadError { .. } => "AudioReadError",
            TranscriptionError::GpuError { .. } => "GpuError",
            TranscriptionError::ModelLoadError { .. } => "ModelLoadError",
            TranscriptionError::TranscriptionError { .. } => "TranscriptionError",
        }
    }
}