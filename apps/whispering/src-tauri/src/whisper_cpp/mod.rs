mod error;

use error::WhisperCppError;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use std::io::Write;

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
fn convert_audio_for_whisper(audio_data: Vec<u8>) -> Result<Vec<u8>, WhisperCppError> {
    // Skip conversion if already in correct format
    if is_valid_wav_format(&audio_data) {
        return Ok(audio_data);
    }
    
    // Create temp files for conversion
    let mut input_file = tempfile::Builder::new()
        .suffix(".audio")
        .tempfile()
        .map_err(|e| WhisperCppError::AudioReadError {
            message: format!("Failed to create temp file: {}", e),
        })?;
    
    input_file.write_all(&audio_data).map_err(|e| {
        WhisperCppError::AudioReadError {
            message: format!("Failed to write audio data: {}", e),
        }
    })?;
    
    let output_file = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(|e| WhisperCppError::AudioReadError {
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
        .map_err(|e| WhisperCppError::AudioReadError {
            message: format!("Failed to run ffmpeg: {}", e),
        })?;
    
    if !output.status.success() {
        return Err(WhisperCppError::AudioReadError {
            message: format!("FFmpeg conversion failed: {}", String::from_utf8_lossy(&output.stderr)),
        });
    }
    
    std::fs::read(output_file.path()).map_err(|e| {
        WhisperCppError::AudioReadError {
            message: format!("Failed to read converted audio: {}", e),
        }
    })
}

/// Load Whisper model with automatic GPU support based on compiled features
fn load_whisper_model(model_path: &str) -> Result<WhisperContext, WhisperCppError> {
    // GPU acceleration is automatically enabled based on compile-time features:
    // - macOS: Metal + CoreML
    // - Windows: CUDA + Vulkan  
    // - Linux: CUDA + Vulkan + HipBLAS
    // The whisper-rs library automatically selects the best available backend
    
    WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| WhisperCppError::ModelLoadError {
            message: format!("Failed to load model: {}", e)
        })
}

#[tauri::command]
pub async fn transcribe_with_whisper_cpp(
    audio_data: Vec<u8>,
    model_path: String,
    language: Option<String>,
    prompt: String,
    temperature: f32,
) -> Result<String, WhisperCppError> {
    // Convert audio to 16kHz mono format that whisper requires
    let wav_data = convert_audio_for_whisper(audio_data)?;
    
    // Parse WAV and extract samples
    let cursor = std::io::Cursor::new(wav_data);
    let mut reader = hound::WavReader::new(cursor).map_err(|e| {
        WhisperCppError::AudioReadError {
            message: format!("Failed to parse WAV: {}", e),
        }
    })?;
    
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| s.map(|sample| sample as f32 / 32768.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| WhisperCppError::AudioReadError {
            message: format!("Failed to read samples: {}", e),
        })?;
    
    // Return early if audio is empty
    if samples.is_empty() {
        return Ok(String::new());
    }
    
    // Load model with automatic GPU acceleration based on compiled features
    let context = load_whisper_model(&model_path)?;
    
    // Create state and configure parameters
    let mut state = context
        .create_state()
        .map_err(|e| WhisperCppError::TranscriptionError {
            message: format!("Failed to create whisper state: {}", e),
        })?;
    
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(false);
    params.set_no_timestamps(true);
    params.set_temperature(temperature);
    params.set_no_speech_thold(0.2);  // Better silence detection
    params.set_suppress_nst(true);  // Prevent hallucinations (non-speech tokens)
    
    // Set language if specified
    if let Some(ref lang) = language {
        if !lang.is_empty() && lang != "auto" {
            params.set_language(Some(lang));
        }
    }
    
    // Set initial prompt if provided
    if !prompt.trim().is_empty() {
        params.set_initial_prompt(&prompt);
    }
    
    // Run transcription
    state.full(params, &samples)
        .map_err(|e| WhisperCppError::TranscriptionError {
            message: e.to_string(),
        })?;
    
    // Collect transcribed text from all segments
    let num_segments = state.full_n_segments();
    
    let mut text = String::new();
    for i in 0..num_segments {
        let segment = state.get_segment(i)
            .ok_or_else(|| WhisperCppError::TranscriptionError {
                message: format!("Failed to get segment {}", i),
            })?;
        let segment_text = segment.to_str()
            .map_err(|e| WhisperCppError::TranscriptionError {
                message: format!("Failed to get segment {} text: {}", i, e),
            })?;
        text.push_str(segment_text);
    }
    
    Ok(text.trim().to_string())
}
