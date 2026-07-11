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

/// How long after the last transcription the resident model should be
/// dropped. Mirrors the frontend `transcription.localModelUnloadPolicy`
/// device setting; serde tags below match its wire format exactly.
///
/// `Immediately` is enforced synchronously at the end of each transcription;
/// timed variants are enforced by the background idle watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UnloadPolicy {
    Never,
    Immediately,
    #[serde(rename = "after_5_minutes")]
    AfterFiveMinutes,
    #[serde(rename = "after_30_minutes")]
    AfterThirtyMinutes,
}

impl UnloadPolicy {
    pub const DEFAULT: Self = Self::AfterFiveMinutes;
}
