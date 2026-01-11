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
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::error::TranscriptionError;

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
const TOKEN_UNKNOWN: i64 = 0;

/// Default language (French)
const DEFAULT_LANGUAGE: &str = "fr";

/// Maximum sequence length for decoding
const MAX_SEQUENCE_LENGTH: usize = 1024;

/// Canary vocabulary loaded from vocab.txt
pub struct CanaryVocab {
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
        let num_layers = 8; // Default for Canary-1B
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

    /// Compute mel-spectrogram features from audio samples
    /// This is a simplified implementation - production should use nemo128.onnx
    fn compute_features(&self, samples: &[f32]) -> Result<Array3<f32>, TranscriptionError> {
        // Parameters for NeMo-style mel spectrogram
        const SAMPLE_RATE: usize = 16000;
        const N_FFT: usize = 512;
        const HOP_LENGTH: usize = 160; // 10ms at 16kHz
        const N_MELS: usize = 128;
        const WIN_LENGTH: usize = 400; // 25ms at 16kHz

        // Calculate number of frames
        let n_frames = (samples.len().saturating_sub(WIN_LENGTH)) / HOP_LENGTH + 1;

        if n_frames == 0 {
            return Err(TranscriptionError::TranscriptionError {
                message: "Audio too short for feature extraction".to_string(),
            });
        }

        // Simplified mel-spectrogram computation
        // For production, this should be replaced with proper STFT + mel filterbank
        // or use the nemo128.onnx preprocessor
        let mut features = Array3::<f32>::zeros((1, N_MELS, n_frames));

        for frame_idx in 0..n_frames {
            let start = frame_idx * HOP_LENGTH;
            let end = (start + WIN_LENGTH).min(samples.len());

            // Simple energy in mel bands (placeholder)
            // Real implementation needs FFT + mel filterbank
            let frame_samples = &samples[start..end];
            let energy: f32 = frame_samples.iter().map(|x| x * x).sum::<f32>() / frame_samples.len() as f32;
            let log_energy = (energy + 1e-10).ln();

            for mel_idx in 0..N_MELS {
                // Distribute energy across mel bands with some variation
                let mel_weight = 1.0 - (mel_idx as f32 / N_MELS as f32 - 0.5).abs();
                features[[0, mel_idx, frame_idx]] = log_energy * mel_weight;
            }
        }

        debug!(
            "[Canary] Computed features: shape {:?}",
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

/// Supported languages for Canary-1B-v2
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
