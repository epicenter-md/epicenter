use serde::{Deserialize, Serialize};

/// Per-call transcription inputs owned by the frontend. The Rust side receives
/// this with `transcribe_recording`, resolves the model at point of use, and
/// keeps only the resident model cache. Nothing here is retained between calls,
/// so there is no ambient config to go stale.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSpec {
    /// The selected model's stable catalog id (`"{repo_id}@{revision}/{filename}"`).
    /// `ModelCache` resolves it to a shared-HF-cache path at load time via
    /// `catalog::resolve_model_path`, so a path never exists as data here.
    pub model_id: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
}
