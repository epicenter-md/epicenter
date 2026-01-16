# Canary-1B-v2 Native Rust Implementation

## Overview

This document describes the native Rust implementation of NVIDIA's Canary-1B-v2 model for Whisper Wing, enabling **language parameter support** for accurate French transcription.

## Problem Statement

The current Parakeet model in Whisper Wing does not support language selection:
- Audio in French sometimes gets transcribed/translated to English
- No way to force French output
- `supportsLanguage: false` in registry.ts

## Solution

Implement Canary-1B-v2 which supports language control via task tokens:
- `<|fr|>` token (ID: 71) forces French transcription
- Native Rust implementation using `ort` crate
- Follows existing Whisper Wing architecture

---

## Technical Architecture

### Model Files Required

| File | Size | Description |
|------|------|-------------|
| `encoder-model.int8.onnx` | 859 MB | FastConformer encoder (quantized) |
| `decoder-model.int8.onnx` | 170 MB | Transformer decoder (quantized) |
| `vocab.txt` | 208 KB | 16,384 token vocabulary |
| `config.json` | 68 B | Model configuration |
| `nemo128.onnx` | 141 KB | Audio preprocessor (mel-spectrogram) |

**Source**: [istupakov/canary-1b-v2-onnx](https://huggingface.co/istupakov/canary-1b-v2-onnx)

### Inference Pipeline

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Audio     │────▶│ Preprocessor│────▶│   Encoder   │────▶│   Decoder   │
│   (WAV)     │     │ (nemo128)   │     │   (ONNX)    │     │   (ONNX)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
                                              Task Tokens ─────────┘
                                              [7,4,16,71,71,5,9,11,13]
                                                      ↑  ↑
                                               source_lang  target_lang
```

### Task Tokens Structure

```rust
// Token IDs for French transcription
const TASK_TOKENS_FR: [i64; 9] = [
    7,   // <|startofcontext|>
    4,   // <|startoftranscript|>
    16,  // <|emo:undefined|>
    71,  // <|fr|> - SOURCE LANGUAGE
    71,  // <|fr|> - TARGET LANGUAGE
    5,   // <|pnc|> - punctuation
    9,   // <|noitn|> - no ITN
    11,  // <|notimestamp|>
    13,  // <|nodiarize|>
];

const EOS_TOKEN_ID: i64 = 3;  // <|endoftext|>
```

### Language Token Mapping

| Language | Code | Token ID |
|----------|------|----------|
| French | fr | 71 |
| English | en | 64 |
| German | de | 78 |
| Spanish | es | 171 |
| Italian | it | 99 |
| Portuguese | pt | 151 |
| Dutch | nl | 62 |
| Polish | pl | 150 |
| Russian | ru | 157 |
| Ukrainian | uk | 192 |

---

## Implementation Details

### Dependencies (Cargo.toml)

```toml
[dependencies]
ort = { version = "2.0", features = ["download-binaries"] }
ndarray = "0.16"
```

### File Structure

```
apps/whispering/src-tauri/src/transcription/
├── mod.rs              # Add canary module + Tauri command
├── model_manager.rs    # Add CanaryEngine variant
├── canary.rs           # NEW: Canary implementation
└── error.rs            # Existing error types
```

### Core Components

#### 1. Vocabulary Loader
```rust
pub struct CanaryVocab {
    token_to_id: HashMap<String, i64>,
    id_to_token: HashMap<i64, String>,
}

impl CanaryVocab {
    pub fn load(path: &Path) -> Result<Self, Error> {
        // Parse "token id" format from vocab.txt
    }

    pub fn get_language_token(&self, lang: &str) -> Option<i64> {
        self.token_to_id.get(&format!("<|{}|>", lang)).copied()
    }
}
```

#### 2. Encoder
```rust
pub struct CanaryEncoder {
    session: ort::Session,
}

impl CanaryEncoder {
    pub fn encode(&self, audio_features: &Array2<f32>)
        -> Result<(Array3<f32>, Array2<i64>), Error>
    {
        // Input: audio_signal [batch, 128, time]
        // Output: encoder_embeddings, encoder_mask
    }
}
```

#### 3. Decoder with Language Support
```rust
pub struct CanaryDecoder {
    session: ort::Session,
    vocab: CanaryVocab,
}

impl CanaryDecoder {
    pub fn decode(
        &self,
        encoder_out: &Array3<f32>,
        encoder_mask: &Array2<i64>,
        language: &str,  // "fr", "en", etc.
    ) -> Result<String, Error> {
        // Build task tokens with language
        let lang_id = self.vocab.get_language_token(language)
            .unwrap_or(64); // default to English

        let mut tokens = vec![7, 4, 16, lang_id, lang_id, 5, 9, 11, 13];

        // Auto-regressive decoding loop
        loop {
            let logits = self.session.run(...)?;
            let next_token = argmax(&logits);

            if next_token == EOS_TOKEN_ID {
                break;
            }
            tokens.push(next_token);
        }

        // Decode tokens to text
        self.decode_tokens(&tokens[9..]) // Skip task tokens
    }
}
```

#### 4. Tauri Command
```rust
#[tauri::command]
pub async fn transcribe_audio_canary(
    audio_data: Vec<u8>,
    model_path: String,
    language: Option<String>,  // KEY: Language parameter!
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let language = language.unwrap_or_else(|| "fr".to_string());

    // 1. Convert audio to correct format
    let wav_data = convert_audio_for_whisper(audio_data)?;
    let samples = extract_samples_from_wav(wav_data)?;

    // 2. Get or load Canary engine
    let engine = model_manager.get_or_load_canary(model_path)?;

    // 3. Transcribe with language parameter
    let result = engine.transcribe(samples, &language)?;

    Ok(result)
}
```

---

## Frontend Integration

### registry.ts (Already Modified)

```typescript
// Service definition
{
    id: 'canary',
    name: 'Canary',
    icon: nvidiaIcon,
    invertInDarkMode: false,
    description: 'NVIDIA NeMo model with LANGUAGE SUPPORT',
    modelPathField: 'transcription.canary.modelPath',
    location: 'local',
}

// Capabilities
canary: {
    supportsPrompt: false,
    supportsTemperature: false,
    supportsLanguage: true,  // KEY FEATURE!
}
```

### TypeScript Service Call

```typescript
// In canary.ts (TypeScript side)
const result = await invoke<string>('transcribe_audio_canary', {
    audioData: Array.from(new Uint8Array(audioBuffer)),
    modelPath: '/path/to/canary/model',
    language: 'fr',  // Force French!
});
```

---

## Build & Deployment

### GitHub Actions Workflow

```yaml
name: Build Canary

on:
  push:
    branches: [main, canary-integration]
  pull_request:

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          npm install -g bun
          bun install

      - name: Build Tauri
        run: bun run tauri build

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: whispering-windows
          path: target/release/bundle/msi/*.msi
```

### Model Download

Users need to download model files on first use:
1. Automatic download via HuggingFace Hub
2. Or manual download to `~/.whispering/models/canary/`

---

## Testing Plan

### Unit Tests
- [ ] Vocabulary loading from vocab.txt
- [ ] Task token generation for each language
- [ ] Encoder input/output shapes
- [ ] Decoder auto-regressive loop

### Integration Tests
- [ ] Full transcription pipeline
- [ ] Language parameter switching
- [ ] Error handling (missing model, invalid audio)

### Manual Tests
- [ ] French audio → French text
- [ ] English audio → English text
- [ ] Mixed language audio

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Model size (1GB) | First download slow | Show progress bar |
| Memory usage | High RAM needed | Use int8 quantized model |
| KV-cache management | Memory leaks | Proper cleanup in Drop |
| ONNX Runtime compatibility | Build failures | Pin ort version |

---

## Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Analysis & Design | 4h | ✅ Complete |
| Cargo.toml setup | 1h | 🔄 In Progress |
| Canary engine implementation | 12h | 📋 Planned |
| Tauri integration | 4h | 📋 Planned |
| Testing & debugging | 8h | 📋 Planned |
| GitHub Actions setup | 2h | 📋 Planned |
| **Total** | **~31h** | |

---

## References

- [onnx-asr source code](https://github.com/istupakov/onnx-asr) - Reference Python implementation
- [canary-1b-v2-onnx](https://huggingface.co/istupakov/canary-1b-v2-onnx) - ONNX model files
- [ort crate](https://github.com/pykeio/ort) - Rust ONNX Runtime bindings
- [transcribe-rs](https://github.com/cjpais/transcribe-rs) - Existing Whisper Wing transcription library
