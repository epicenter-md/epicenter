use super::error::TranscriptionError;
use hound::{SampleFormat, WavSpec, WavWriter};
use rubato::{FftFixedInOut, Resampler};
use std::io::{Cursor, Write};
use tracing::{debug, info, warn};

/// Extension trait for WavSpec to add audio format helpers
trait WavSpecExt {
    fn is_whisper_compatible(&self) -> bool;
    fn log_details(&self, prefix: &str);
}

impl WavSpecExt for WavSpec {
    /// Check if this format matches Whisper's requirements
    fn is_whisper_compatible(&self) -> bool {
        self.sample_rate == 16000
            && self.channels == 1
            && self.bits_per_sample == 16
            && self.sample_format == SampleFormat::Int
    }

    /// Log format details for debugging
    fn log_details(&self, prefix: &str) {
        debug!(
            "{}: {}Hz, {} channel(s), {}-bit {}",
            prefix,
            self.sample_rate,
            self.channels,
            self.bits_per_sample,
            match self.sample_format {
                SampleFormat::Int => "PCM integer",
                SampleFormat::Float => "IEEE float",
            }
        );
    }
}

/// Detect the format of WAV audio data
pub fn detect_wav_format(audio_data: &[u8]) -> Option<WavSpec> {
    let cursor = Cursor::new(audio_data);
    if let Ok(reader) = hound::WavReader::new(cursor) {
        Some(reader.spec())
    } else {
        None
    }
}

/// Convert audio to Whisper-compatible format (16kHz mono 16-bit PCM)
/// Tries native Rust conversion first, falls back to FFmpeg if needed
pub fn convert_to_whisper_format(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    // Detect current format
    if let Some(format) = detect_wav_format(&audio_data) {
        format.log_details("Input audio format");

        // Check if already in correct format
        if format.is_whisper_compatible() {
            debug!("Audio already in Whisper-compatible format, skipping conversion");
            return Ok(audio_data);
        }

        // Determine what conversions are needed
        let needs_resampling = format.sample_rate != 16000;
        let needs_channel_mixing = format.channels != 1;
        let needs_bit_depth_conversion =
            format.bits_per_sample != 16 || format.sample_format != SampleFormat::Int;

        debug!(
            "Conversion needed: resampling={}, channel_mixing={}, bit_depth={}",
            needs_resampling, needs_channel_mixing, needs_bit_depth_conversion
        );

        // Try native conversion
        match convert_wav_native(audio_data.clone(), &format) {
            Ok(converted) => {
                debug!("Successfully converted audio using native Rust implementation");
                if let Some(output_format) = detect_wav_format(&converted) {
                    output_format.log_details("Output audio format");
                }
                return Ok(converted);
            }
            Err(e) => {
                warn!(
                    "Native conversion failed, falling back to FFmpeg: {}",
                    e
                );
                // Fall through to FFmpeg
            }
        }
    } else {
        debug!("Input is not a WAV file or has unsupported encoding, using FFmpeg");
    }

    // Fall back to FFmpeg for unsupported formats or failed conversions
    convert_with_ffmpeg(audio_data)
}

/// Native Rust conversion for WAV files
fn convert_wav_native(
    audio_data: Vec<u8>,
    input_format: &WavSpec,
) -> Result<Vec<u8>, TranscriptionError> {
    // Read WAV data
    let cursor = Cursor::new(audio_data);
    let mut reader = hound::WavReader::new(cursor).map_err(|e| TranscriptionError::AudioReadError {
        message: format!("Failed to read WAV: {}", e),
    })?;

    // Read all samples and convert to f32 (normalized -1.0 to 1.0)
    let samples = read_samples_as_f32(&mut reader, input_format)?;

    // Process channels (mix to mono if needed)
    let mono_samples = if input_format.channels > 1 {
        debug!(
            "Mixing {} channels to mono by averaging",
            input_format.channels
        );
        mix_channels_to_mono(&samples, input_format.channels)
    } else {
        debug!("Audio is already mono");
        samples
    };

    // Resample if needed
    let resampled = if input_format.sample_rate != 16000 {
        debug!(
            "Resampling from {}Hz to 16000Hz",
            input_format.sample_rate
        );
        resample_audio(&mono_samples, input_format.sample_rate, 16000)?
    } else {
        debug!("Audio is already at 16kHz");
        mono_samples
    };

    // Convert back to 16-bit PCM WAV
    create_wav_from_samples(&resampled, 16000, 1)
}

/// Read samples from WAV reader and convert to normalized f32
fn read_samples_as_f32(
    reader: &mut hound::WavReader<Cursor<Vec<u8>>>,
    format: &WavSpec,
) -> Result<Vec<f32>, TranscriptionError> {
    let samples: Result<Vec<f32>, _> = match (format.sample_format, format.bits_per_sample) {
        (SampleFormat::Float, 32) => {
            // 32-bit float
            reader.samples::<f32>().collect()
        }
        (SampleFormat::Int, 16) => {
            // 16-bit integer
            reader
                .samples::<i16>()
                .map(|s| s.map(|sample| sample as f32 / i16::MAX as f32))
                .collect()
        }
        (SampleFormat::Int, 24) => {
            // 24-bit integer (read as i32)
            reader
                .samples::<i32>()
                .map(|s| s.map(|sample| sample as f32 / 0x7FFFFF as f32))
                .collect()
        }
        (SampleFormat::Int, 32) => {
            // 32-bit integer
            reader
                .samples::<i32>()
                .map(|s| s.map(|sample| sample as f32 / i32::MAX as f32))
                .collect()
        }
        _ => {
            return Err(TranscriptionError::AudioReadError {
                message: format!(
                    "Unsupported audio format: {}-bit {:?}",
                    format.bits_per_sample, format.sample_format
                ),
            });
        }
    };

    samples.map_err(|e| TranscriptionError::AudioReadError {
        message: format!("Failed to read samples: {}", e),
    })
}

/// Mix multi-channel audio to mono by averaging channels
fn mix_channels_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels as usize;
    let mono_len = samples.len() / channels;
    let mut mono = Vec::with_capacity(mono_len);

    for i in 0..mono_len {
        let mut sum = 0.0f32;
        for ch in 0..channels {
            sum += samples[i * channels + ch];
        }
        mono.push(sum / channels as f32);
    }

    mono
}

/// Resample audio using rubato
fn resample_audio(
    samples: &[f32],
    from_rate: u32,
    to_rate: u32,
) -> Result<Vec<f32>, TranscriptionError> {
    if from_rate == to_rate {
        return Ok(samples.to_vec());
    }

    // Calculate resampling parameters
    let resample_ratio = to_rate as f64 / from_rate as f64;
    let chunk_size = 1024; // Process in chunks for efficiency

    // Create resampler
    let mut resampler = FftFixedInOut::<f32>::new(
        from_rate as usize,
        to_rate as usize,
        chunk_size,
        1, // Single channel (already mono)
    )
    .map_err(|e| TranscriptionError::AudioReadError {
        message: format!("Failed to create resampler: {}", e),
    })?;

    // Prepare input/output buffers
    let mut output = Vec::new();
    let mut input_buffer = vec![Vec::new(); 1]; // Single channel
    input_buffer[0] = samples.to_vec();

    // Add padding if needed for the resampler
    let frames_needed = resampler.input_frames_max();
    if input_buffer[0].len() < frames_needed {
        input_buffer[0].resize(frames_needed, 0.0);
    }

    // Process in chunks
    let mut pos = 0;
    while pos < samples.len() {
        let chunk_end = (pos + chunk_size).min(samples.len());
        let chunk_len = chunk_end - pos;

        // Prepare chunk for processing
        let mut chunk_input = vec![vec![0.0f32; chunk_size]; 1];
        chunk_input[0][..chunk_len].copy_from_slice(&samples[pos..chunk_end]);

        // Resample chunk
        let chunk_output = resampler.process(&chunk_input, None).map_err(|e| {
            TranscriptionError::AudioReadError {
                message: format!("Resampling failed: {}", e),
            }
        })?;

        // Collect output
        if !chunk_output[0].is_empty() {
            output.extend_from_slice(&chunk_output[0]);
        }

        pos = chunk_end;
    }

    // Process any remaining samples in the resampler
    let empty_input: Option<&[Vec<f32>]> = None;
    let final_output = resampler.process_partial(empty_input, None).map_err(|e| {
        TranscriptionError::AudioReadError {
            message: format!("Final resampling failed: {}", e),
        }
    })?;

    if !final_output[0].is_empty() {
        output.extend_from_slice(&final_output[0]);
    }

    debug!(
        "Resampled {} samples to {} samples (ratio: {:.3})",
        samples.len(),
        output.len(),
        resample_ratio
    );

    Ok(output)
}

/// Create a 16-bit PCM WAV file from f32 samples
fn create_wav_from_samples(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<Vec<u8>, TranscriptionError> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
            TranscriptionError::AudioReadError {
                message: format!("Failed to create WAV writer: {}", e),
            }
        })?;

        // Convert f32 samples to i16
        for &sample in samples {
            let i16_sample = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(i16_sample).map_err(|e| {
                TranscriptionError::AudioReadError {
                    message: format!("Failed to write sample: {}", e),
                }
            })?;
        }

        writer.finalize().map_err(|e| {
            TranscriptionError::AudioReadError {
                message: format!("Failed to finalize WAV: {}", e),
            }
        })?;
    }

    Ok(cursor.into_inner())
}

/// FFmpeg fallback for unsupported formats
fn convert_with_ffmpeg(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    info!("Using FFmpeg for audio conversion");

    // Create temp files
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

    // Use FFmpeg to convert
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
            message: format!(
                "FFmpeg conversion failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        });
    }

    std::fs::read(output_file.path()).map_err(|e| TranscriptionError::AudioReadError {
        message: format!("Failed to read converted audio: {}", e),
    })
}