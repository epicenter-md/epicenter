//! Native recorder finalization into Epicenter's canonical local blob layout.
//!
//! The WebView supplies one opaque `BlobId`. Rust writes the complete WAV and
//! metadata into a staging directory, fsyncs both files, and atomically renames
//! the directory to `<appDataDir>/blobs/<BlobId>`. IPC returns only the id.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::audio::decode_to_pcm16k_mono;
use crate::recorder::error::RecorderError;

const BLOB_RATE: u32 = 16_000;
const BLOB_CHANNELS: u16 = 1;
const BLOB_CONTENT_TYPE: &str = "audio/wav";
const BLOBS_DIRECTORY: &str = "blobs";
const STAGING_DIRECTORY: &str = ".staging";
const RUST_STAGING_DIRECTORY: &str = "rust";
const DATA_FILE: &str = "data";
const METADATA_FILE: &str = "metadata.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlobMetadata {
    content_type: &'static str,
    size: u64,
}

fn validate_blob_id(id: &str) -> Result<(), RecorderError> {
    let body = id
        .strip_prefix("blob_")
        .ok_or_else(|| RecorderError::failed("blob id must start with 'blob_'"))?;
    if body.len() != 21
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(RecorderError::failed("blob id has an invalid shape"));
    }
    Ok(())
}

fn blobs_directory(app: &AppHandle) -> Result<PathBuf, RecorderError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| RecorderError::failed(format!("resolve app data dir: {error}")))?;
    Ok(app_data.join(BLOBS_DIRECTORY))
}

fn blob_data_path(app: &AppHandle, id: &str) -> Result<PathBuf, RecorderError> {
    validate_blob_id(id)?;
    Ok(blobs_directory(app)?.join(id).join(DATA_FILE))
}

/// Finalize native samples as one immutable local blob and return only its id.
pub fn write_blob(app: &AppHandle, id: &str, samples: &[f32]) -> Result<String, RecorderError> {
    validate_blob_id(id)?;
    let root = blobs_directory(app)?;
    // Each writer owns a distinct staging subtree. Bun writes under
    // `.staging/bun`; native capture writes here, so a future safe cleanup can
    // never mistake another runtime's active publication for its own debris.
    let staging_root = root.join(STAGING_DIRECTORY).join(RUST_STAGING_DIRECTORY);
    std::fs::create_dir_all(&staging_root).map_err(|error| {
        RecorderError::failed(format!(
            "create blob staging directory {}: {error}",
            staging_root.display()
        ))
    })?;

    let final_directory = root.join(id);
    if final_directory.exists() {
        return Err(RecorderError::failed(format!("blob '{id}' already exists")));
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| RecorderError::failed(format!("read system clock: {error}")))?
        .as_nanos();
    let staged_directory = staging_root.join(format!("{id}-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&staged_directory).map_err(|error| {
        RecorderError::failed(format!(
            "create staged blob directory {}: {error}",
            staged_directory.display()
        ))
    })?;

    let mut published = false;
    let result = (|| {
        let data_path = staged_directory.join(DATA_FILE);
        write_pcm_as_wav(&data_path, samples)?;
        let size = std::fs::metadata(&data_path)
            .map_err(|error| {
                RecorderError::failed(format!("stat staged blob {}: {error}", data_path.display()))
            })?
            .len();
        let metadata_path = staged_directory.join(METADATA_FILE);
        let metadata = serde_json::to_vec(&BlobMetadata {
            content_type: BLOB_CONTENT_TYPE,
            size,
        })
        .map_err(|error| RecorderError::failed(format!("serialize blob metadata: {error}")))?;
        std::fs::write(&metadata_path, metadata).map_err(|error| {
            RecorderError::failed(format!(
                "write blob metadata {}: {error}",
                metadata_path.display()
            ))
        })?;
        File::open(&metadata_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                RecorderError::failed(format!(
                    "sync blob metadata {}: {error}",
                    metadata_path.display()
                ))
            })?;
        sync_directory(&staged_directory)?;
        std::fs::rename(&staged_directory, &final_directory).map_err(|error| {
            RecorderError::failed(format!(
                "publish blob {}: {error}",
                final_directory.display()
            ))
        })?;
        published = true;
        sync_directory(&root)?;
        Ok(id.to_string())
    })();

    match result {
        Ok(id) => Ok(id),
        Err(error) => {
            let cleanup_target = if published {
                &final_directory
            } else {
                &staged_directory
            };
            if let Err(cleanup_error) = std::fs::remove_dir_all(cleanup_target) {
                return Err(RecorderError::failed(format!(
                    "{error}; cleanup blob {}: {cleanup_error}",
                    cleanup_target.display()
                )));
            }
            if published {
                let _ = sync_directory(&root);
            }
            Err(error)
        }
    }
}

/// Decode one canonical local blob to the PCM shape local transcription uses.
pub fn read_blob_samples(app: &AppHandle, id: &str) -> Result<Vec<f32>, RecorderError> {
    let path = blob_data_path(app, id)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| RecorderError::failed(format!("read blob {}: {error}", path.display())))?;
    decode_to_pcm16k_mono(&bytes)
        .map_err(|error| RecorderError::failed(format!("decode blob {}: {error}", path.display())))
}

fn write_pcm_as_wav(path: &Path, samples: &[f32]) -> Result<(), RecorderError> {
    let bits_per_sample: u16 = 32;
    let bytes_per_sample: u32 = (bits_per_sample / 8) as u32;
    let sample_count = u32::try_from(samples.len())
        .map_err(|_| RecorderError::failed("wav sample count overflow"))?;
    let data_size: u32 = sample_count
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| RecorderError::failed("wav data size overflow"))?;
    let file_size = 36u32
        .checked_add(data_size)
        .ok_or_else(|| RecorderError::failed("wav file size overflow"))?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| RecorderError::failed(format!("open blob {}: {error}", path.display())))?;
    let mut writer = BufWriter::new(file);
    writer.write_all(b"RIFF").map_err(io_error(path))?;
    writer
        .write_all(&file_size.to_le_bytes())
        .map_err(io_error(path))?;
    writer.write_all(b"WAVEfmt ").map_err(io_error(path))?;
    writer
        .write_all(&16u32.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&3u16.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&BLOB_CHANNELS.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&BLOB_RATE.to_le_bytes())
        .map_err(io_error(path))?;
    let byte_rate = BLOB_RATE * BLOB_CHANNELS as u32 * bytes_per_sample;
    writer
        .write_all(&byte_rate.to_le_bytes())
        .map_err(io_error(path))?;
    let block_align = BLOB_CHANNELS * bytes_per_sample as u16;
    writer
        .write_all(&block_align.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&bits_per_sample.to_le_bytes())
        .map_err(io_error(path))?;
    writer.write_all(b"data").map_err(io_error(path))?;
    writer
        .write_all(&data_size.to_le_bytes())
        .map_err(io_error(path))?;
    for sample in samples {
        writer
            .write_all(&sample.to_le_bytes())
            .map_err(io_error(path))?;
    }
    let file = writer
        .into_inner()
        .map_err(|error| RecorderError::failed(format!("flush wav {}: {error}", path.display())))?;
    file.sync_all()
        .map_err(|error| RecorderError::failed(format!("sync wav {}: {error}", path.display())))
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> RecorderError + '_ {
    move |error| RecorderError::failed(format!("write wav {}: {error}", path.display()))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), RecorderError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            RecorderError::failed(format!("sync blob directory {}: {error}", path.display()))
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), RecorderError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_id_validation_accepts_only_the_public_shape() {
        assert!(validate_blob_id("blob_abcdefghijklmnopqrstu").is_ok());
        assert!(validate_blob_id("abcdefghijklmnopqrstu").is_err());
        assert!(validate_blob_id("blob_ABCDEFGHIJKLMNOPQRSTU").is_err());
        assert!(validate_blob_id("blob_abcdefghijklmnopqrs/u").is_err());
    }
}
