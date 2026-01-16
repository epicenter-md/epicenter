//! Canary-1B-v2 transcription engine with language support
//!
//! This module implements NVIDIA's Canary-1B-v2 model for speech recognition
//! with native language parameter support, enabling accurate transcription
//! in specific languages (especially French).
//!
//! Unlike Parakeet which auto-detects language, Canary accepts a language
//! parameter via task tokens to force output in a specific language.

use log::{debug, info, warn};
use ndarray::{Array1, Array2, Array3, Array4, IxDyn};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Value;
use rustfft::{num_complex::Complex, FftPlanner};
use std::collections::HashMap;
use std::f32::consts::PI;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::error::TranscriptionError;

/// Simple pseudo-random number generator for dither
/// Uses xorshift64 algorithm - fast and good enough for audio dither
static RAND_STATE: AtomicU64 = AtomicU64::new(0x853c49e6748fea9b);

fn rand_simple() -> f32 {
    let mut state = RAND_STATE.load(Ordering::Relaxed);
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    RAND_STATE.store(state, Ordering::Relaxed);
    (state as f32) / (u64::MAX as f32)
}

/// Language code to token ID mapping for Canary-1B-v2
/// These are extracted from vocab.txt
const LANGUAGE_TOKENS: &[(&str, i64)] = &[
    ("fr", 71),   // French
    ("en", 64),   // English
    ("de", 78),   // German
    ("es", 171),  // Spanish
    ("it", 99),   // Italian
    ("pt", 151),  // Portuguese
    ("nl", 62),   // Dutch
    ("pl", 150),  // Polish
    ("ru", 157),  // Russian
    ("uk", 192),  // Ukrainian
    ("cs", 59),   // Czech
    ("ro", 154),  // Romanian
    ("hu", 89),   // Hungarian
    ("bg", 46),   // Bulgarian
    ("hr", 58),   // Croatian
    ("sk", 167),  // Slovak
    ("sl", 168),  // Slovenian
    ("et", 66),   // Estonian
    ("lv", 117),  // Latvian
    ("lt", 120),  // Lithuanian
    ("da", 60),   // Danish
    ("sv", 175),  // Swedish
    ("fi", 70),   // Finnish
    ("el", 79),   // Greek
    ("mt", 127),  // Maltese
];

/// Special token IDs
const TOKEN_START_OF_CONTEXT: i64 = 7;
const TOKEN_START_OF_TRANSCRIPT: i64 = 4;
const TOKEN_EMO_UNDEFINED: i64 = 16;
const TOKEN_PNC: i64 = 5;
const TOKEN_NO_ITN: i64 = 9;
const TOKEN_NO_TIMESTAMP: i64 = 11;
const TOKEN_NO_DIARIZE: i64 = 13;
const TOKEN_END_OF_TEXT: i64 = 3;

/// Maximum sequence length for decoding
const MAX_SEQUENCE_LENGTH: usize = 1024;

/// Canary vocabulary loaded from vocab.txt
pub struct CanaryVocab {
    #[allow(dead_code)] // Reserved for future encoder use
    token_to_id: HashMap<String, i64>,
    id_to_token: HashMap<i64, String>,
    language_to_id: HashMap<String, i64>,
}

impl CanaryVocab {
    /// Load vocabulary from vocab.txt file
    pub fn load(vocab_path: &Path) -> Result<Self, TranscriptionError> {
        debug!("[Canary] Loading vocabulary from {:?}", vocab_path);

        let content = fs::read_to_string(vocab_path).map_err(|e| {
            TranscriptionError::ModelLoadError {
                message: format!("Failed to read vocab.txt: {}", e),
            }
        })?;

        let mut token_to_id = HashMap::new();
        let mut id_to_token = HashMap::new();

        for line in content.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let token = parts[0].to_string();
                if let Ok(id) = parts[1].parse::<i64>() {
                    token_to_id.insert(token.clone(), id);
                    // Replace special underscore character with space for decoding
                    let display_token = token.replace('\u{2581}', " ");
                    id_to_token.insert(id, display_token);
                }
            }
        }

        debug!(
            "[Canary] Loaded {} tokens from vocabulary",
            token_to_id.len()
        );

        // Build language mapping
        let mut language_to_id = HashMap::new();
        for (lang, id) in LANGUAGE_TOKENS {
            language_to_id.insert(lang.to_string(), *id);
        }

        Ok(Self {
            token_to_id,
            id_to_token,
            language_to_id,
        })
    }

    /// Get token ID for a language code
    pub fn get_language_token(&self, lang: &str) -> i64 {
        self.language_to_id
            .get(lang)
            .copied()
            .unwrap_or_else(|| {
                warn!(
                    "[Canary] Unknown language '{}', defaulting to French",
                    lang
                );
                71 // French
            })
    }

    /// Decode token IDs to text
    pub fn decode(&self, token_ids: &[i64]) -> String {
        let mut text = String::new();

        for &id in token_ids {
            if let Some(token) = self.id_to_token.get(&id) {
                // Skip special tokens (those wrapped in <| |>)
                if !token.starts_with("<|") {
                    text.push_str(token);
                }
            }
        }

        // Clean up spacing
        text.trim().to_string()
    }
}

/// Canary encoder wrapper
pub struct CanaryEncoder {
    session: Session,
}

impl CanaryEncoder {
    /// Load encoder from ONNX file
    pub fn load(model_path: &Path) -> Result<Self, TranscriptionError> {
        debug!("[Canary] Loading encoder from {:?}", model_path);

        let session = Session::builder()
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to create ONNX session builder: {}", e),
            })?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to set optimization level: {}", e),
            })?
            .commit_from_file(model_path)
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to load encoder model: {}", e),
            })?;

        info!("[Canary] Encoder loaded successfully");
        Ok(Self { session })
    }

    /// Encode audio features
    /// Input: audio_signal [batch, features, time], length [batch]
    /// Output: encoder_embeddings [batch, seq_len, hidden], encoder_mask [batch, seq_len]
    pub fn encode(
        &mut self,
        audio_features: Array3<f32>,
        lengths: Array1<i64>,
    ) -> Result<(Array3<f32>, Array2<i64>), TranscriptionError> {
        debug!(
            "[Canary] Encoding audio: shape {:?}, lengths {:?}",
            audio_features.shape(),
            lengths.shape()
        );

        let audio_value = Value::from_array(audio_features)
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to create audio input: {}", e),
            })?;
        let length_value = Value::from_array(lengths)
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to create length input: {}", e),
            })?;

        let outputs = self.session.run(ort::inputs![
            "audio_signal" => audio_value,
            "length" => length_value,
        ]).map_err(|e| {
            TranscriptionError::TranscriptionError {
                message: format!("Encoder inference failed: {}", e),
            }
        })?;

        // Extract outputs
        let emb_output = outputs
            .get("encoder_embeddings")
            .ok_or_else(|| TranscriptionError::TranscriptionError {
                message: "Missing encoder_embeddings output".to_string(),
            })?;
        let (emb_shape, emb_data) = emb_output.try_extract_tensor::<f32>()
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to extract encoder_embeddings: {}", e),
            })?;
        let emb_dims: Vec<usize> = emb_shape.iter().map(|&d| d as usize).collect();
        let encoder_embeddings = ndarray::ArrayViewD::from_shape(
            IxDyn(&emb_dims),
            emb_data
        ).map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Failed to create encoder_embeddings array: {}", e),
        })?
        .into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Invalid encoder_embeddings shape: {}", e),
        })?
        .to_owned();

        let mask_output = outputs
            .get("encoder_mask")
            .ok_or_else(|| TranscriptionError::TranscriptionError {
                message: "Missing encoder_mask output".to_string(),
            })?;
        let (mask_shape, mask_data) = mask_output.try_extract_tensor::<i64>()
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to extract encoder_mask: {}", e),
            })?;
        let mask_dims: Vec<usize> = mask_shape.iter().map(|&d| d as usize).collect();
        let encoder_mask = ndarray::ArrayViewD::from_shape(
            IxDyn(&mask_dims),
            mask_data
        ).map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Failed to create encoder_mask array: {}", e),
        })?
        .into_dimensionality::<ndarray::Ix2>()
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Invalid encoder_mask shape: {}", e),
        })?
        .to_owned();

        debug!(
            "[Canary] Encoder output: embeddings {:?}, mask {:?}",
            encoder_embeddings.shape(),
            encoder_mask.shape()
        );

        Ok((encoder_embeddings, encoder_mask))
    }
}

/// Canary decoder wrapper
pub struct CanaryDecoder {
    session: Session,
    num_layers: usize,
    hidden_dim: usize,
}

impl CanaryDecoder {
    /// Load decoder from ONNX file
    pub fn load(model_path: &Path) -> Result<Self, TranscriptionError> {
        debug!("[Canary] Loading decoder from {:?}", model_path);

        let session = Session::builder()
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to create ONNX session builder: {}", e),
            })?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to set optimization level: {}", e),
            })?
            .commit_from_file(model_path)
            .map_err(|e| TranscriptionError::ModelLoadError {
                message: format!("Failed to load decoder model: {}", e),
            })?;

        // Default values for Canary-1B-v2
        // Shape: [num_layers, batch, seq_len, hidden_dim]
        let num_layers = 10; // Canary-1B-v2 has 10 decoder layers
        let hidden_dim = 1024; // Default

        info!(
            "[Canary] Decoder loaded: {} layers, {} hidden dim",
            num_layers, hidden_dim
        );

        Ok(Self {
            session,
            num_layers,
            hidden_dim,
        })
    }

    /// Build initial task tokens for transcription
    pub fn build_task_tokens(&self, language: &str, vocab: &CanaryVocab) -> Vec<i64> {
        let lang_id = vocab.get_language_token(language);

        vec![
            TOKEN_START_OF_CONTEXT,
            TOKEN_START_OF_TRANSCRIPT,
            TOKEN_EMO_UNDEFINED,
            lang_id, // Source language
            lang_id, // Target language (same for transcription, different for translation)
            TOKEN_PNC,
            TOKEN_NO_ITN,
            TOKEN_NO_TIMESTAMP,
            TOKEN_NO_DIARIZE,
        ]
    }

    /// Decode with language parameter
    pub fn decode(
        &mut self,
        encoder_embeddings: &Array3<f32>,
        encoder_mask: &Array2<i64>,
        language: &str,
        vocab: &CanaryVocab,
    ) -> Result<Vec<i64>, TranscriptionError> {
        let batch_size = encoder_embeddings.shape()[0];

        // Build initial tokens with language
        let mut tokens = self.build_task_tokens(language, vocab);
        let prefix_len = tokens.len();

        debug!(
            "[Canary] Starting decode with language '{}', initial tokens: {:?}",
            language, tokens
        );

        // Initialize decoder memory (KV cache) - empty at start
        // Shape: [num_layers, batch, 0, hidden_dim]
        let mut decoder_mems =
            Array4::<f32>::zeros((self.num_layers, batch_size, 0, self.hidden_dim));

        // Auto-regressive decoding loop
        while tokens.len() < MAX_SEQUENCE_LENGTH {
            // Prepare input_ids
            let input_ids = if decoder_mems.shape()[2] == 0 {
                // First iteration: use all tokens
                Array2::from_shape_vec(
                    (batch_size, tokens.len()),
                    tokens.iter().cycle().take(batch_size * tokens.len()).copied().collect(),
                )
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create input_ids: {}", e),
                })?
            } else {
                // Subsequent iterations: only last token
                Array2::from_shape_vec(
                    (batch_size, 1),
                    vec![*tokens.last().unwrap(); batch_size],
                )
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create input_ids: {}", e),
                })?
            };

            // Run decoder
            let input_ids_value = Value::from_array(input_ids)
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create input_ids: {}", e),
                })?;
            let encoder_emb_value = Value::from_array(encoder_embeddings.clone())
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create encoder_embeddings input: {}", e),
                })?;
            let encoder_mask_value = Value::from_array(encoder_mask.clone())
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create encoder_mask input: {}", e),
                })?;
            let decoder_mems_value = Value::from_array(decoder_mems.clone())
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to create decoder_mems input: {}", e),
                })?;

            let outputs = self.session.run(ort::inputs![
                "input_ids" => input_ids_value,
                "encoder_embeddings" => encoder_emb_value,
                "encoder_mask" => encoder_mask_value,
                "decoder_mems" => decoder_mems_value,
            ]).map_err(|e| {
                TranscriptionError::TranscriptionError {
                    message: format!("Decoder inference failed: {}", e),
                }
            })?;

            // Get logits and new decoder state
            let logits_output = outputs
                .get("logits")
                .ok_or_else(|| TranscriptionError::TranscriptionError {
                    message: "Missing logits output".to_string(),
                })?;
            let (logits_shape, logits_data) = logits_output.try_extract_tensor::<f32>()
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to extract logits: {}", e),
                })?;
            let logits_dims: Vec<usize> = logits_shape.iter().map(|&d| d as usize).collect();
            let logits = ndarray::ArrayViewD::from_shape(
                IxDyn(&logits_dims),
                logits_data
            ).map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to create logits array: {}", e),
            })?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Invalid logits shape: {}", e),
            })?
            .to_owned();

            let hidden_output = outputs
                .get("decoder_hidden_states")
                .ok_or_else(|| TranscriptionError::TranscriptionError {
                    message: "Missing decoder_hidden_states output".to_string(),
                })?;
            let (hidden_shape, hidden_data) = hidden_output.try_extract_tensor::<f32>()
                .map_err(|e| TranscriptionError::TranscriptionError {
                    message: format!("Failed to extract decoder_hidden_states: {}", e),
                })?;
            let hidden_dims: Vec<usize> = hidden_shape.iter().map(|&d| d as usize).collect();
            let decoder_hidden_states = ndarray::ArrayViewD::from_shape(
                IxDyn(&hidden_dims),
                hidden_data
            ).map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Failed to create decoder_hidden_states array: {}", e),
            })?
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|e| TranscriptionError::TranscriptionError {
                message: format!("Invalid decoder_hidden_states shape: {}", e),
            })?
            .to_owned();

            // Get next token (greedy decoding - argmax of last position)
            let seq_len = logits.shape()[1];
            let logits_last = logits.slice(ndarray::s![0, seq_len - 1, ..]);
            let next_token = logits_last
                .iter()
                .enumerate()
                .max_by(|(_, a): &(usize, &f32), (_, b): &(usize, &f32)| a.partial_cmp(b).unwrap())
                .map(|(idx, _)| idx as i64)
                .unwrap_or(TOKEN_END_OF_TEXT);

            // Check for end of sequence
            if next_token == TOKEN_END_OF_TEXT {
                debug!("[Canary] End of text token reached after {} tokens", tokens.len());
                break;
            }

            tokens.push(next_token);

            // Update decoder memory
            decoder_mems = decoder_hidden_states;
        }

        // Return only the generated tokens (skip task prefix)
        Ok(tokens[prefix_len..].to_vec())
    }
}

/// Complete Canary engine combining encoder and decoder
pub struct CanaryEngine {
    encoder: CanaryEncoder,
    decoder: CanaryDecoder,
    vocab: CanaryVocab,
    #[allow(dead_code)] // Reserved for model info/debugging
    model_path: PathBuf,
}

impl CanaryEngine {
    /// Load Canary model from directory
    pub fn load(model_dir: &Path) -> Result<Self, TranscriptionError> {
        info!("[Canary] Loading model from {:?}", model_dir);

        // Check for required files
        let encoder_path = Self::find_encoder_path(model_dir)?;
        let decoder_path = Self::find_decoder_path(model_dir)?;
        let vocab_path = model_dir.join("vocab.txt");

        if !vocab_path.exists() {
            return Err(TranscriptionError::ModelLoadError {
                message: format!("vocab.txt not found in {:?}", model_dir),
            });
        }

        // Load components
        let vocab = CanaryVocab::load(&vocab_path)?;
        let encoder = CanaryEncoder::load(&encoder_path)?;
        let decoder = CanaryDecoder::load(&decoder_path)?;

        info!("[Canary] Model loaded successfully");

        Ok(Self {
            encoder,
            decoder,
            vocab,
            model_path: model_dir.to_path_buf(),
        })
    }

    /// Find encoder model file (prefer int8 quantized)
    fn find_encoder_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
        let int8_path = model_dir.join("encoder-model.int8.onnx");
        if int8_path.exists() {
            return Ok(int8_path);
        }

        let fp32_path = model_dir.join("encoder-model.onnx");
        if fp32_path.exists() {
            return Ok(fp32_path);
        }

        Err(TranscriptionError::ModelLoadError {
            message: format!("No encoder model found in {:?}", model_dir),
        })
    }

    /// Find decoder model file (prefer int8 quantized)
    fn find_decoder_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
        let int8_path = model_dir.join("decoder-model.int8.onnx");
        if int8_path.exists() {
            return Ok(int8_path);
        }

        let fp32_path = model_dir.join("decoder-model.onnx");
        if fp32_path.exists() {
            return Ok(fp32_path);
        }

        Err(TranscriptionError::ModelLoadError {
            message: format!("No decoder model found in {:?}", model_dir),
        })
    }

    /// Transcribe audio samples with language parameter
    ///
    /// # Arguments
    /// * `samples` - Audio samples as f32 (16kHz, mono, normalized to [-1, 1])
    /// * `language` - Target language code (e.g., "fr", "en", "de")
    ///
    /// # Returns
    /// Transcribed text in the specified language
    pub fn transcribe(&mut self, samples: Vec<f32>, language: &str) -> Result<String, TranscriptionError> {
        info!(
            "[Canary] Transcribing {} samples with language '{}'",
            samples.len(),
            language
        );

        if samples.is_empty() {
            return Ok(String::new());
        }

        // Convert samples to mel-spectrogram features
        // For now, we'll use a simplified approach
        // In production, this should use nemo128.onnx preprocessor
        let features = self.compute_features(&samples)?;

        // Encode
        let lengths = Array1::from_vec(vec![features.shape()[2] as i64]);
        let (encoder_embeddings, encoder_mask) = self.encoder.encode(features, lengths)?;

        // Decode with language
        let token_ids = self.decoder.decode(
            &encoder_embeddings,
            &encoder_mask,
            language,
            &self.vocab,
        )?;

        // Convert to text
        let text = self.vocab.decode(&token_ids);

        info!("[Canary] Transcription complete: {} characters", text.len());

        Ok(text)
    }

    /// Compute mel-spectrogram features from audio samples using proper FFT
    ///
    /// Implements the NeMo-style preprocessing matching nemo128.onnx:
    /// 1. Add small dither for numerical stability
    /// 2. STFT with Hann window (centered)
    /// 3. Power spectrum computation
    /// 4. Mel filterbank application
    /// 5. Log compression
    /// 6. Per-feature normalization (zero mean, unit variance)
    fn compute_features(&self, samples: &[f32]) -> Result<Array3<f32>, TranscriptionError> {
        // NeMo parameters for 16kHz audio (matching nemo128.onnx)
        const SAMPLE_RATE: usize = 16000;
        const N_FFT: usize = 512;
        const HOP_LENGTH: usize = 160;  // 10ms -> ~100 frames/second
        const WIN_LENGTH: usize = 320;  // 20ms (NeMo default, not 25ms)
        const N_MELS: usize = 128;
        const F_MIN: f32 = 0.0;
        const F_MAX: f32 = 8000.0;  // Nyquist for 16kHz
        const DITHER: f32 = 1e-5;   // Small noise for numerical stability
        const LOG_FLOOR: f32 = 1e-10;

        // Calculate number of frames matching nemo128: ceil(samples / hop_length) + 1
        // nemo128 uses centered frames with padding
        let n_frames = (samples.len() + HOP_LENGTH - 1) / HOP_LENGTH + 1;

        if samples.is_empty() {
            return Err(TranscriptionError::TranscriptionError {
                message: "Audio too short for feature extraction".to_string(),
            });
        }

        info!("[Canary] Computing mel-spectrogram: {} samples -> {} frames", samples.len(), n_frames);

        // Add dither for numerical stability (prevents log(0) issues)
        let samples_with_dither: Vec<f32> = samples.iter()
            .map(|&s| s + DITHER * (2.0 * rand_simple() - 1.0))
            .collect();

        // Pad samples for centered frames (half window on each side)
        let pad_length = WIN_LENGTH / 2;
        let mut padded_samples = vec![0.0f32; pad_length];
        padded_samples.extend_from_slice(&samples_with_dither);
        padded_samples.extend(vec![0.0f32; pad_length + HOP_LENGTH]); // Extra padding for last frames

        // Create Hann window (periodic version for STFT)
        let window: Vec<f32> = (0..WIN_LENGTH)
            .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / WIN_LENGTH as f32).cos()))
            .collect();

        // Create mel filterbank with proper frequency mapping
        let mel_filterbank = create_mel_filterbank_nemo(N_FFT, SAMPLE_RATE, N_MELS, F_MIN, F_MAX);

        // Setup FFT
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(N_FFT);

        let mut features = Array3::<f32>::zeros((1, N_MELS, n_frames));
        let n_freq_bins = N_FFT / 2 + 1;

        for frame_idx in 0..n_frames {
            let center = frame_idx * HOP_LENGTH;
            let start = center;
            let end = (start + WIN_LENGTH).min(padded_samples.len());

            // Create windowed frame with zero-padding to N_FFT
            let mut fft_buffer: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); N_FFT];
            for (i, idx) in (start..end).enumerate() {
                if idx < padded_samples.len() && i < WIN_LENGTH {
                    let windowed = padded_samples[idx] * window[i];
                    fft_buffer[i] = Complex::new(windowed, 0.0);
                }
            }

            // Perform FFT in-place
            fft.process(&mut fft_buffer);

            // Compute power spectrum (magnitude squared)
            let power_spectrum: Vec<f32> = fft_buffer[..n_freq_bins]
                .iter()
                .map(|c| c.norm_sqr())
                .collect();

            // Apply mel filterbank and log compression
            for mel_idx in 0..N_MELS {
                let mel_energy: f32 = power_spectrum
                    .iter()
                    .zip(&mel_filterbank[mel_idx])
                    .map(|(p, w)| p * w)
                    .sum();

                // Log compression with floor to avoid log(0)
                features[[0, mel_idx, frame_idx]] = (mel_energy.max(LOG_FLOOR)).ln();
            }
        }

        // Normalize features per mel bin (zero mean, unit variance)
        // This matches NeMo's "per_feature" normalization
        for mel_idx in 0..N_MELS {
            let mut sum = 0.0f64;
            let mut sum_sq = 0.0f64;
            for frame_idx in 0..n_frames {
                let v = features[[0, mel_idx, frame_idx]] as f64;
                sum += v;
                sum_sq += v * v;
            }
            let mean = sum / n_frames as f64;
            let variance = (sum_sq / n_frames as f64) - mean * mean;
            let std = variance.sqrt().max(1e-5);

            for frame_idx in 0..n_frames {
                let normalized = (features[[0, mel_idx, frame_idx]] as f64 - mean) / std;
                features[[0, mel_idx, frame_idx]] = normalized as f32;
            }
        }

        debug!(
            "[Canary] Computed mel-spectrogram: shape {:?}",
            features.shape()
        );

        Ok(features)
    }

    /// Unload the model to free memory
    pub fn unload(&mut self) {
        info!("[Canary] Unloading model");
        // The Session will be dropped when CanaryEngine is dropped
        // This method exists for API consistency with other engines
    }
}

/// Create mel filterbank matrix for NeMo-style preprocessing
///
/// Uses floating-point frequency mapping for smoother filters,
/// matching the behavior of nemo128.onnx preprocessor.
///
/// # Arguments
/// * `n_fft` - FFT size
/// * `sample_rate` - Audio sample rate in Hz
/// * `n_mels` - Number of mel bands
/// * `f_min` - Minimum frequency in Hz
/// * `f_max` - Maximum frequency in Hz
///
/// # Returns
/// 2D vector [n_mels][n_fft/2+1] of filterbank weights
fn create_mel_filterbank_nemo(
    n_fft: usize,
    sample_rate: usize,
    n_mels: usize,
    f_min: f32,
    f_max: f32,
) -> Vec<Vec<f32>> {
    let n_freq_bins = n_fft / 2 + 1;

    // HTK mel scale conversion functions
    let hz_to_mel = |hz: f32| -> f32 { 2595.0 * (1.0 + hz / 700.0).log10() };
    let mel_to_hz = |mel: f32| -> f32 { 700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0) };

    let mel_min = hz_to_mel(f_min);
    let mel_max = hz_to_mel(f_max);

    // Create n_mels + 2 points evenly spaced in mel scale
    let mel_points: Vec<f32> = (0..=n_mels + 1)
        .map(|i| mel_min + (mel_max - mel_min) * i as f32 / (n_mels + 1) as f32)
        .collect();

    // Convert mel points back to Hz
    let hz_points: Vec<f32> = mel_points.iter().map(|&m| mel_to_hz(m)).collect();

    // Convert Hz to FFT bin indices (floating point for smoother interpolation)
    let fft_freqs: Vec<f32> = (0..n_freq_bins)
        .map(|i| i as f32 * sample_rate as f32 / n_fft as f32)
        .collect();

    // Create triangular filters with proper interpolation
    let mut filterbank = vec![vec![0.0f32; n_freq_bins]; n_mels];

    for mel_idx in 0..n_mels {
        let f_left = hz_points[mel_idx];
        let f_center = hz_points[mel_idx + 1];
        let f_right = hz_points[mel_idx + 2];

        for (bin_idx, &freq) in fft_freqs.iter().enumerate() {
            if freq >= f_left && freq <= f_center && f_center > f_left {
                // Rising slope
                filterbank[mel_idx][bin_idx] = (freq - f_left) / (f_center - f_left);
            } else if freq > f_center && freq <= f_right && f_right > f_center {
                // Falling slope
                filterbank[mel_idx][bin_idx] = (f_right - freq) / (f_right - f_center);
            }
        }
    }

    filterbank
}

/// Supported languages for Canary-1B-v2
#[allow(dead_code)] // Public API for future UI integration
pub fn get_supported_languages() -> Vec<(&'static str, &'static str)> {
    vec![
        ("fr", "French"),
        ("en", "English"),
        ("de", "German"),
        ("es", "Spanish"),
        ("it", "Italian"),
        ("pt", "Portuguese"),
        ("nl", "Dutch"),
        ("pl", "Polish"),
        ("ru", "Russian"),
        ("uk", "Ukrainian"),
        ("cs", "Czech"),
        ("ro", "Romanian"),
        ("hu", "Hungarian"),
        ("bg", "Bulgarian"),
        ("hr", "Croatian"),
        ("sk", "Slovak"),
        ("sl", "Slovenian"),
        ("et", "Estonian"),
        ("lv", "Latvian"),
        ("lt", "Lithuanian"),
        ("da", "Danish"),
        ("sv", "Swedish"),
        ("fi", "Finnish"),
        ("el", "Greek"),
        ("mt", "Maltese"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_language_token_mapping() {
        // Verify French token ID
        let french_id = LANGUAGE_TOKENS.iter().find(|(l, _)| *l == "fr").map(|(_, id)| *id);
        assert_eq!(french_id, Some(71));

        // Verify English token ID
        let english_id = LANGUAGE_TOKENS.iter().find(|(l, _)| *l == "en").map(|(_, id)| *id);
        assert_eq!(english_id, Some(64));
    }

    #[test]
    fn test_task_tokens() {
        // Verify task token IDs
        assert_eq!(TOKEN_START_OF_CONTEXT, 7);
        assert_eq!(TOKEN_START_OF_TRANSCRIPT, 4);
        assert_eq!(TOKEN_END_OF_TEXT, 3);
    }
}
