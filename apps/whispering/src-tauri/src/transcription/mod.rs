mod error;

use error::TranscriptionError;
use std::path::PathBuf;
use std::io::Write;
use transcribe_rs::{
    TranscriptionEngine,
    engines::{
        whisper::{WhisperEngine, WhisperInferenceParams},
        parakeet::{ParakeetEngine, ParakeetModelParams, ParakeetInferenceParams, TimestampGranularity},
    },
};

/// Check if audio is already in whisper-compatible format (16kHz, mono, 16-bit PCM)
fn is_valid_wav_format(audio_data: &[u8]) -> bool {
    let cursor = std::io::Cursor::new(audio_data);

    if let Ok(reader) = hound::WavReader::new(cursor) {
        let spec = reader.spec();
        spec.sample_format == hound::SampleFormat::Int &&
        spec.channels == 1 &&          // Must be mono
        spec.sample_rate == 16000 &&   // Must be 16kHz
        spec.bits_per_sample == 16     // Must be 16-bit
    } else {
        false
    }
}

/// Convert audio to whisper-compatible format (16kHz mono PCM WAV) using FFmpeg
///
/// Whisper models require audio in a specific format:
/// - Sample rate: 16,000 Hz (not the typical 44.1kHz or 48kHz)
/// - Channels: Mono (1 channel)
/// - Format: 16-bit PCM WAV
///
/// This function:
/// 1. Checks if audio is already in the correct format
/// 2. If not, uses FFmpeg to convert from any format (MP3, M4A, etc.) to the required format
/// 3. Returns the audio ready for whisper transcription
fn convert_audio_for_whisper(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    // Skip conversion if already in correct format
    if is_valid_wav_format(&audio_data) {
        return Ok(audio_data);
    }

    // Create temp files for conversion
    let mut input_file = tempfile::Builder::new()
        .suffix(".audio")
        .tempfile()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to create temp file: {}", e),
        })?;

    input_file.write_all(&audio_data).map_err(|e| {
        TranscriptionError::AudioReadError {
            message: format!("Failed to write audio data: {}", e),
        }
    })?;

    let output_file = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to create output file: {}", e),
        })?;

    // Use FFmpeg to convert to whisper-compatible format
    let output = std::process::Command::new("ffmpeg")
        .args(&[
            "-i", &input_file.path().to_string_lossy(),
            "-ar", "16000",        // 16kHz sample rate
            "-ac", "1",            // Mono
            "-c:a", "pcm_s16le",   // 16-bit PCM
            "-y",                  // Overwrite output
            &output_file.path().to_string_lossy(),
        ])
        .output()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to run ffmpeg: {}", e),
        })?;

    if !output.status.success() {
        return Err(TranscriptionError::AudioReadError {
            message: format!("FFmpeg conversion failed: {}", String::from_utf8_lossy(&output.stderr)),
        });
    }

    std::fs::read(output_file.path()).map_err(|e| {
        TranscriptionError::AudioReadError {
            message: format!("Failed to read converted audio: {}", e),
        }
    })
}

/// Parse WAV data and extract samples as f32 vector
fn extract_samples_from_wav(wav_data: Vec<u8>) -> Result<Vec<f32>, TranscriptionError> {
    let cursor = std::io::Cursor::new(wav_data);
    let mut reader = hound::WavReader::new(cursor).map_err(|e| {
        TranscriptionError::AudioReadError {
            message: format!("Failed to parse WAV: {}", e),
        }
    })?;

    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| s.map(|sample| sample as f32 / 32768.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to read samples: {}", e),
        })?;

    Ok(samples)
}

#[tauri::command]
pub async fn transcribe_audio_whisper(
    audio_data: Vec<u8>,
    model_path: String,
    language: Option<String>,
) -> Result<String, TranscriptionError> {
    // Convert audio to 16kHz mono format that whisper requires
    let wav_data = convert_audio_for_whisper(audio_data)?;

    // Extract samples from WAV
    let samples = extract_samples_from_wav(wav_data)?;

    // Return early if audio is empty
    if samples.is_empty() {
        return Ok(String::new());
    }

    // Create Whisper engine using transcribe-rs
    let mut engine = WhisperEngine::new();

    // Load the model
    engine.load_model(&PathBuf::from(&model_path))
        .map_err(|e| TranscriptionError::ModelLoadError {
            message: format!("Failed to load model: {}", e)
        })?;

    // Configure inference parameters
    let mut params = WhisperInferenceParams::default();
    params.language = language;
    params.print_special = false;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.suppress_blank = true;
    params.suppress_non_speech_tokens = true;
    params.no_speech_thold = 0.2;

    // Run transcription
    let result = engine.transcribe_samples(samples, Some(params))
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: e.to_string(),
        })?;

    // Unload model to free memory
    engine.unload_model();

    Ok(result.text.trim().to_string())
}

#[tauri::command]
pub async fn transcribe_audio_parakeet(
    audio_data: Vec<u8>,
    model_path: String,
) -> Result<String, TranscriptionError> {
    // Convert audio to 16kHz mono format
    let wav_data = convert_audio_for_whisper(audio_data)?;

    // Extract samples from WAV
    let samples = extract_samples_from_wav(wav_data)?;

    // Return early if audio is empty
    if samples.is_empty() {
        return Ok(String::new());
    }

    // Create Parakeet engine using transcribe-rs
    let mut engine = ParakeetEngine::new();

    // Load the model with int8 quantization for better performance
    engine.load_model_with_params(&PathBuf::from(&model_path), ParakeetModelParams::int8())
        .map_err(|e| TranscriptionError::ModelLoadError {
            message: format!("Failed to load Parakeet model: {}", e)
        })?;

    let params = ParakeetInferenceParams {
        timestamp_granularity: TimestampGranularity::Segment,
        ..Default::default()
    };

    // Run transcription with optimized parameters
    let result = engine.transcribe_samples(samples, Some(params))
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: e.to_string(),
        })?;

    // Unload model to free memory
    engine.unload_model();

    Ok(result.text.trim().to_string())
}