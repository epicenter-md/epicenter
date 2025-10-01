# Rust to TypeScript: Discriminated Unions with Serde

https://github.com/epicenter-md/epicenter/blob/dffee1fe126698d7c71ad1fa1f7c528ad417e270/apps/whispering/src/lib/services/transcription/whispercpp.ts

I hit an interesting pattern while building error handling in a Tauri app. Rust enums with serde's `tag` and `rename_all` attributes map perfectly to TypeScript discriminated unions, making cross-boundary error handling actually pleasant.

## The Pattern

Here's what I mean. In Rust:

```rust
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "name", rename_all = "PascalCase")]
pub enum WhisperCppError {
    #[error("FFmpeg is not installed")]
    FfmpegNotInstalled,
    
    #[error("Failed to load model: {message}")]
    ModelLoadError { message: String },
    
    #[error("GPU acceleration failed: {message}")]
    GpuError { message: String },
}
```

This serializes to JSON like:

```json
// FfmpegNotInstalled variant
{ "name": "FfmpegNotInstalled" }

// ModelLoadError variant
{ "name": "ModelLoadError", "message": "Cannot find model.bin" }
```

Notice how the `tag = "name"` creates a discriminator field, and `rename_all = "PascalCase"` ensures consistent naming across languages.

## TypeScript Side

On the TypeScript side, you can model this perfectly with arktype or zod:

```typescript
import { type } from 'arktype';

const WhisperCppErrorType = type({
  name: "'FfmpegNotInstalled' | 'ModelLoadError' | 'GpuError'",
  message: 'string',
});

// This gives you the TypeScript type:
type WhisperCppError = {
  name: 'FfmpegNotInstalled' | 'ModelLoadError' | 'GpuError';
  message: string;
}
```

## The Magic: Switch Statements

Now you can use exhaustive switch statements that TypeScript understands:

```typescript
switch (error.name) {
  case 'FfmpegNotInstalled':
    // TypeScript knows there's no message field here
    return showInstallGuide();
    
  case 'ModelLoadError':
    // TypeScript knows message exists here
    return showError(`Model issue: ${error.message}`);
    
  case 'GpuError':
    // Handle GPU-specific error
    return fallbackToCpu(error.message);
}
```

TypeScript's control flow analysis works perfectly here. It narrows the type based on the discriminator field.

## With WellCrafted Result Types

This pattern shines when combined with WellCrafted's Result types:

```typescript
import { tryAsync } from 'wellcrafted/result';

const result = await tryAsync({
  try: () => invoke('transcribe_with_whisper_cpp', params),
  catch: (unknownError) => {
    const result = WhisperCppErrorType(unknownError);
    if (result instanceof type.errors) {
      // Not our expected error shape
      return genericError(unknownError);
    }
    
    const error = result;
    // Now we have a properly typed error
    switch (error.name) {
      case 'FfmpegNotInstalled':
        return WhisperingErr({
          title: 'FFmpeg Required',
          action: { type: 'link', href: '/install-ffmpeg' }
        });
      // ... handle other cases
    }
  }
});
```

## Why This Works So Well

1. **Type Safety Across Boundaries**: Rust's enum variants become TypeScript union members automatically
2. **Exhaustiveness**: Both Rust's match and TypeScript's switch can be exhaustive
3. **Rename Flexibility**: `rename_all` handles naming convention differences (snake_case in Rust, PascalCase in types)
4. **Clean Serialization**: No wrapper objects or extra nesting

## Common Pitfalls

Don't add individual `#[serde(rename = "...")]` on variants when using `rename_all`:

```rust
// DON'T DO THIS - it's redundant
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MyError {
    #[serde(rename = "someError")]  // <-- Redundant!
    SomeError,
}

// DO THIS - let rename_all handle it
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MyError {
    SomeError,  // Automatically becomes "someError"
}
```

## Alternative Tag Strategies

You can also use different tag strategies depending on your needs:

```rust
// External tagging (default)
#[derive(Serialize)]
pub enum Event {
    Click { x: i32, y: i32 }
}
// Serializes to: { "Click": { "x": 10, "y": 20 } }

// Internal tagging (what we used above)
#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Event {
    Click { x: i32, y: i32 }
}
// Serializes to: { "type": "Click", "x": 10, "y": 20 }

// Adjacent tagging
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
pub enum Event {
    Click { x: i32, y: i32 }
}
// Serializes to: { "type": "Click", "data": { "x": 10, "y": 20 } }
```

For error handling across Tauri's IPC boundary, internal tagging with a discriminator field is the sweet spot. It's flat, readable, and maps naturally to TypeScript discriminated unions.

## The Lesson

When building cross-language APIs, lean into each language's strengths. Rust's enums with serde attributes map beautifully to TypeScript's discriminated unions. You get type safety, exhaustiveness checking, and clean error handling on both sides of the boundary.

No manual parsing. No runtime type checking. Just compile-time guarantees that follow your errors across language boundaries.