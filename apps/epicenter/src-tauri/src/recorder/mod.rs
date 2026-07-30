pub mod blob;
pub mod commands;
pub mod ended;
pub mod error;
pub mod recorder;

/// The one name reached through this module rather than its own: the
/// transcription and upload paths read a finalized blob without otherwise
/// knowing the recorder exists. Everything else (the commands, `Recorder`,
/// `RecorderError`) is imported from the module that defines it, so re-exporting
/// it here would only be a second way to spell the same import.
pub use blob::read_blob_samples;
