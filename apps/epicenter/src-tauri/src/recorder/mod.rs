pub mod artifact;
pub mod commands;
pub mod error;
pub mod recorder;

pub use artifact::{read_artifact_bytes, read_artifact_samples, write_artifact, RecordingArtifact};
pub use commands::{
    cancel_recording, clear_recording_artifacts, close_recording_session,
    delete_recording_artifacts, enumerate_recording_devices, get_current_recording_id,
    init_recording_session, read_recording_artifact, start_recording, stop_recording,
};
pub use error::RecorderError;
pub use recorder::Recorder;
