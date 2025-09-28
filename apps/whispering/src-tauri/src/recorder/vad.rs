use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use thiserror::Error;
use tracing::{error, info};

#[derive(Debug, Error)]
pub enum VadError {
    #[error("Audio device error: {0}")]
    DeviceError(String),
    #[error("Stream error: {0}")]
    StreamError(String),
    #[error("VAD not initialized")]
    NotInitialized,
    #[error("VAD already running")]
    AlreadyRunning,
    #[error("File I/O error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("WAV writer error: {0}")]
    WavError(#[from] hound::Error),
}

type Result<T> = std::result::Result<T, VadError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadState {
    pub is_running: bool,
    pub is_speaking: bool,
    pub current_file: Option<String>,
}

#[derive(Clone, Serialize)]
struct VadSpeechDetectedEvent {
    #[serde(rename = "filePath")]
    file_path: String,
    #[serde(rename = "fileContents")]
    file_contents: Option<Vec<u8>>,
}

struct VadSession {
    stream: cpal::Stream,
    is_running: Arc<AtomicBool>,
    state: Arc<Mutex<VadState>>,
}

lazy_static! {
    static ref VAD_SESSION: Mutex<Option<VadSession>> = Mutex::new(None);
}

pub async fn start_vad_recording(
    app: tauri::AppHandle,
    device_identifier: String,
    threshold: f32,
    silence_timeout_ms: Option<u32>,
) -> Result<()> {
    info!(
        "Starting VAD recording with device: {}, threshold: {}, silence_timeout_ms: {:?}",
        device_identifier, threshold, silence_timeout_ms
    );

    // Stop any existing session before starting new one
    {
        let should_stop = {
            let session = VAD_SESSION.lock().unwrap();
            session.is_some()
        };

        if should_stop {
            info!("Stopping existing VAD session before starting new one");
            let _ = stop_vad_recording().await; // Stop existing session
        }
    }

    // Get audio host and device
    let host = cpal::default_host();
    let device = if device_identifier == "default" {
        host.default_input_device()
            .ok_or_else(|| VadError::DeviceError("No default input device found".into()))?
    } else {
        host.input_devices()
            .map_err(|e| VadError::DeviceError(e.to_string()))?
            .find(|d| {
                d.name()
                    .map(|n| n == device_identifier)
                    .unwrap_or(false)
            })
            .ok_or_else(|| VadError::DeviceError(format!("Device '{}' not found", device_identifier)))?
    };

    let device_name = device.name().unwrap_or_else(|_| "Unknown".to_string());
    info!("Using audio device: {}", device_name);

    // Get supported config - prefer 16kHz for VAD
    let mut supported_configs = device
        .supported_input_configs()
        .map_err(|e| VadError::DeviceError(e.to_string()))?
        .collect::<Vec<_>>();


    // Sort by sample rate, preferring 16kHz
    supported_configs.sort_by_key(|c| {
        let rate = c.min_sample_rate().0;
        if rate == 16000 {
            0  // Highest priority
        } else if rate == 44100 || rate == 48000 {
            1  // Medium priority
        } else {
            2  // Lower priority
        }
    });

    let supported_config = supported_configs
        .first()
        .ok_or_else(|| VadError::DeviceError("No supported audio config found".into()))?;

    // Choose the best sample rate from the supported range
    let min_rate = supported_config.min_sample_rate().0;
    let max_rate = supported_config.max_sample_rate().0;

    let sample_rate = if min_rate <= 16000 && max_rate >= 16000 {
        16000u32  // Prefer 16kHz if it's in the supported range
    } else if min_rate <= 48000 && max_rate >= 48000 {
        48000u32  // Fall back to 48kHz
    } else if min_rate <= 44100 && max_rate >= 44100 {
        44100u32  // Fall back to 44.1kHz
    } else {
        max_rate  // Use the maximum supported rate
    };

    let config = cpal::StreamConfig {
        channels: 1,  // Mono for VAD
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    info!("Audio config: {} Hz, 1 channel", sample_rate);

    // Create VAD detector using builder pattern from experimental branch
    let vad = voice_activity_detector::VoiceActivityDetector::builder()
        .sample_rate(sample_rate as i64)
        .chunk_size(512usize)  // Process in 512-sample chunks
        .build()
        .map_err(|e| VadError::DeviceError(format!("Failed to create VAD detector: {:?}", e)))?;

    let vad = Arc::new(Mutex::new(vad));

    // Get recordings directory
    let recordings_dir = get_recordings_dir(&app)?;
    fs::create_dir_all(&recordings_dir)?;

    // Shared state
    let is_running = Arc::new(AtomicBool::new(true));
    let state = Arc::new(Mutex::new(VadState {
        is_running: true,
        is_speaking: false,
        current_file: None,
    }));

    // Recording state
    let current_writer: Arc<Mutex<Option<WavWriter<BufWriter<fs::File>>>>> = Arc::new(Mutex::new(None));
    let audio_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let last_speech_time = Arc::new(Mutex::new(None::<Instant>));
    let silence_timeout = Duration::from_millis(silence_timeout_ms.unwrap_or(800) as u64);

    // Clone for stream
    let is_running_clone = is_running.clone();
    let state_clone = state.clone();
    let vad_clone = vad.clone();
    let app_clone = app.clone();
    let recordings_dir_clone = recordings_dir.clone();

    // Build the audio stream
    let stream = device.build_input_stream(
        &config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if !is_running_clone.load(Ordering::Relaxed) {
                return;
            }

            // Buffer audio for processing
            {
                let mut buffer = audio_buffer.lock().unwrap();
                buffer.extend_from_slice(data);
            }

            // Process in chunks
            while {
                let buffer_len = audio_buffer.lock().unwrap().len();
                buffer_len >= 512
            } {
                // Extract chunk for processing
                let chunk: Vec<f32> = {
                    let mut buffer = audio_buffer.lock().unwrap();
                    buffer.drain(..512).collect()
                };

                // Run VAD detection
                let is_speech = {
                    let mut vad = vad_clone.lock().unwrap();
                    let probability = vad.predict(chunk.iter().copied());


                    probability > threshold
                };

                let now = Instant::now();

                // Update last speech time
                if is_speech {
                    let mut last_time = last_speech_time.lock().unwrap();
                    *last_time = Some(now);
                }

                // Check if we should be recording
                let should_record = {
                    let last_time = last_speech_time.lock().unwrap();
                    if let Some(last) = *last_time {
                        now.duration_since(last) < silence_timeout
                    } else {
                        false
                    }
                };

                // Handle state transitions
                let mut writer_guard = current_writer.lock().unwrap();
                let mut state_guard = state_clone.lock().unwrap();

                if should_record && writer_guard.is_none() {
                    // Start new recording
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis();
                    let file_name = format!("vad_{}_{}.wav", timestamp, 0);
                    let file_path = recordings_dir_clone.join(&file_name);

                    info!("Starting new VAD recording: {}", file_path.display());

                    match create_wav_writer(&file_path, sample_rate) {
                        Ok(writer) => {
                            *writer_guard = Some(writer);
                            state_guard.is_speaking = true;
                            state_guard.current_file = Some(file_path.to_string_lossy().to_string());

                            // Emit speech start event
                            let _ = app_clone.emit("vad-speech-start", ());
                        }
                        Err(e) => {
                            error!("Failed to create WAV writer: {}", e);
                        }
                    }
                } else if !should_record && writer_guard.is_some() {
                    // Stop recording and emit event
                    if let Some(writer) = writer_guard.take() {
                        let file_path = state_guard.current_file.clone().unwrap_or_default();

                        // Finalize the WAV file
                        drop(writer);

                        info!("Completed VAD recording: {}", file_path);

                        // Read the file contents and emit event to frontend
                        let file_contents = match fs::read(&file_path) {
                            Ok(bytes) => Some(bytes),
                            Err(e) => {
                                error!("Failed to read VAD file {}: {}", file_path, e);
                                None
                            }
                        };

                        let _ = app_clone.emit("vad-speech-detected", VadSpeechDetectedEvent {
                            file_path: file_path.clone(),
                            file_contents,
                        });

                        state_guard.is_speaking = false;
                        state_guard.current_file = None;
                    }
                }

                // Write audio to file if recording
                if let Some(ref mut writer) = *writer_guard {
                    for sample in &chunk {
                        let _ = writer.write_sample(*sample);
                    }
                }
            }
        },
        move |err| {
            error!("Audio stream error: {}", err);
        },
        None,
    ).map_err(|e| VadError::StreamError(e.to_string()))?;

    stream.play().map_err(|e| VadError::StreamError(e.to_string()))?;

    // Store session
    {
        let mut session = VAD_SESSION.lock().unwrap();
        *session = Some(VadSession {
            stream,
            is_running,
            state,
        });
    }

    info!("VAD recording started successfully");
    Ok(())
}

pub async fn stop_vad_recording() -> Result<()> {
    info!("Stopping VAD recording");

    let session = {
        let mut session_guard = VAD_SESSION.lock().unwrap();
        session_guard.take()
    };

    if let Some(session) = session {
        // Signal stream to stop
        session.is_running.store(false, Ordering::Relaxed);

        // Stop the stream
        drop(session.stream);

        // Update state
        {
            let mut state = session.state.lock().unwrap();
            state.is_running = false;
            state.is_speaking = false;
            state.current_file = None;
        }

        info!("VAD recording stopped successfully");
        Ok(())
    } else {
        Err(VadError::NotInitialized)
    }
}

pub async fn get_vad_state() -> Result<VadState> {
    let session_guard = VAD_SESSION.lock().unwrap();

    if let Some(ref session) = *session_guard {
        let state = session.state.lock().unwrap();
        Ok(state.clone())
    } else {
        Ok(VadState {
            is_running: false,
            is_speaking: false,
            current_file: None,
        })
    }
}

fn get_recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| VadError::IoError(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    Ok(app_data.join("recordings"))
}

fn create_wav_writer(
    path: &PathBuf,
    sample_rate: u32,
) -> Result<WavWriter<BufWriter<fs::File>>> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let file = fs::File::create(path)?;
    let writer = WavWriter::new(BufWriter::new(file), spec)?;
    Ok(writer)
}