---
name: rust-errors
description: Rust to TypeScript error handling patterns for Tauri apps. Use when defining Rust errors that will be passed to TypeScript, handling Tauri command errors, or creating discriminated union error types.
---

# Rust to TypeScript Error Handling

## Discriminated Union Pattern for Errors

When passing errors from Rust to TypeScript through Tauri commands, use internally-tagged enums to create discriminated unions that TypeScript can handle naturally.

### Rust Error Definition

```rust
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    #[error("GPU error: {message}")]
    GpuError { message: String },

    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },
}
```

### Key Rust Patterns

1. **Use internally tagged enums**: `#[serde(tag = "name")]` creates a discriminator field
2. **Follow naming conventions**: Enum variants should be PascalCase
3. **Include structured data**: Each variant can have fields like `message: String`
4. **Single-variant enums are okay**: Use when you want consistent error structure

```rust
// Single-variant enum for consistency
#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
enum ArchiveExtractionError {
    #[error("Archive extraction failed: {message}")]
    ArchiveExtractionError { message: String },
}
```

### TypeScript Error Handling

```typescript
import { type } from 'arktype';

// Define the error type to match Rust serialization
const TranscriptionErrorType = type({
	name: "'AudioReadError' | 'GpuError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

// Use in error handling
const result = await tryAsync({
	try: () => invoke('transcribe_audio_whisper', params),
	catch: (unknownError) => {
		const result = TranscriptionErrorType(unknownError);
		if (result instanceof type.errors) {
			// Handle unexpected error shape
			return WhisperingErr({
				title: 'Unexpected Error',
				description: extractErrorMessage(unknownError),
				action: { type: 'more-details', error: unknownError },
			});
		}

		const error = result;
		// Now we have properly typed discriminated union
		switch (error.name) {
			case 'ModelLoadError':
				return WhisperingErr({
					title: 'Model Loading Error',
					description: error.message,
					action: {
						type: 'more-details',
						error: new Error(error.message),
					},
				});

			case 'GpuError':
				return WhisperingErr({
					title: 'GPU Error',
					description: error.message,
					action: {
						type: 'link',
						label: 'Configure settings',
						href: '/settings/transcription',
					},
				});

			// Handle other cases...
		}
	},
});
```

### Serialization Format

The Rust enum serializes to this TypeScript-friendly format:

```json
// AudioReadError variant
{ "name": "AudioReadError", "message": "Failed to decode audio file" }

// GpuError variant
{ "name": "GpuError", "message": "GPU acceleration failed" }
```

### Best Practices

1. **Consistent error structure**: All errors have the same shape with `name` and `message`
2. **TypeScript type safety**: Use runtime validation with arktype to ensure type safety
3. **Exhaustive handling**: Switch statements provide compile-time exhaustiveness checking
4. **Don't use `content` attribute**: Avoid `#[serde(tag = "name", content = "data")]` as it creates nested structures
5. **Keep enums private when possible**: Only make public if used across modules

### Anti-Patterns to Avoid

```rust
// DON'T: External tagging (default behavior)
#[derive(Serialize)]
pub enum BadError {
    ModelLoadError { message: String }
}
// Produces: { "ModelLoadError": { "message": "..." } }

// DON'T: Adjacent tagging with content
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
pub enum BadError {
    ModelLoadError { message: String }
}
// Produces: { "type": "ModelLoadError", "data": { "message": "..." } }

// DON'T: Manual Serialize implementation when derive works
impl Serialize for MyError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Unnecessary complexity
    }
}
```

This pattern ensures clean, type-safe error handling across the Rust-TypeScript boundary with minimal boilerplate and maximum type safety.
