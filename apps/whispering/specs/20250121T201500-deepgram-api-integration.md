# Deepgram API Integration Specification

**Spec ID:** 20250121T201500  
**Date:** August 10, 2025  
**Status:** Implemented  
**Author:** Vishesh 

## Overview

This specification documents the implementation of Deepgram API support for speech-to-text transcription in the Whispering application, with cross-platform compatibility for both web browsers and Tauri desktop environments.

## Technical Requirements

### Platform Compatibility
- **Web Browser**: Standard fetch API with CORS handling
- **Tauri Desktop**: Server-side proxy using `@tauri-apps/plugin-http`
- **Cross-platform**: Unified interface through HttpService abstraction

### API Integration
- **Endpoint**: Deepgram API v1 (`https://api.deepgram.com/v1/listen`)
- **Authentication**: Token-based via Authorization header
- **Data Format**: Raw binary audio data transmission
- **Response Format**: JSON with nested transcription results

## Implementation Architecture

### Core Components

#### 1. HttpService Abstraction (`/lib/services/http/`)
```typescript
// Platform detection and service selection
export const HttpServiceLive = window.__TAURI_INTERNALS__ 
    ? TauriHttpService 
    : WebHttpService;
```

#### 2. Deepgram Service (`/lib/services/transcription/cloud/deepgram.ts`)
```typescript
interface DeepgramTranscriptionServiceDeps {
    HttpService: HttpService;
}

function createDeepgramTranscriptionService(deps: DeepgramTranscriptionServiceDeps)
```

#### 3. Service Configuration (`/lib/constants/transcription/service-config.ts`)
```typescript
export const DEEPGRAM_TRANSCRIPTION_MODELS = [
    { value: 'nova-3', label: 'Nova-3 (Latest)' },
    { value: 'nova-2', label: 'Nova-2' },
    { value: 'nova', label: 'Nova (Balanced)' },
    { value: 'enhanced', label: 'Enhanced (Accuracy)' },
    { value: 'base', label: 'Base (Fast)' }
] as const;
```

### Data Flow

1. **Audio Input**: Blob object from user's audio recording
2. **Configuration**: API key, model selection, and transcription options
3. **HTTP Request**: Raw binary transmission via HttpService
4. **Response Processing**: Zod schema validation and error handling
5. **Result**: Transcribed text or structured error response

## API Specification

### Request Format
```http
POST https://api.deepgram.com/v1/listen?model={model}&smart_format=true
Authorization: Token {api_key}
Content-Type: {audio_mime_type}

{raw_audio_binary_data}
```

### Query Parameters
- `model`: Transcription model (nova-3, nova-2, nova, enhanced, base)
- `smart_format`: Enable smart formatting (true)
- `language`: Target language (optional, auto-detected if not specified)
- `keywords`: Prompt/keywords for context (optional)

### Response Schema
```typescript
const deepgramResponseSchema = z.object({
    metadata: z.object({
        transaction_key: z.string(),
        request_id: z.string(),
        sha256: z.string(),
        created: z.string(),
        duration: z.number(),
        channels: z.number(),
    }),
    results: z.object({
        channels: z.array(z.object({
            alternatives: z.array(z.object({
                transcript: z.string(),
                confidence: z.number(),
                words: z.array(z.object({
                    word: z.string(),
                    start: z.number(),
                    end: z.number(),
                    confidence: z.number(),
                })).optional(),
            })),
        })),
    }),
});
```

## Error Handling

### HTTP Status Codes
- **400**: Bad Request - Invalid parameters or corrupted audio
- **401**: Unauthorized - Invalid or expired API key
- **403**: Forbidden - Access denied to feature/model
- **413**: Payload Too Large - Audio file exceeds size limit
- **415**: Unsupported Media Type - Invalid audio format
- **429**: Too Many Requests - Rate limit exceeded
- **5xx**: Server Error - Deepgram service issues

### Error Response Format
```typescript
interface WhisperingError {
    title: string;
    description: string;
    action?: {
        type: 'more-details' | 'link';
        label?: string;
        href?: string;
        error?: unknown;
    };
}
```

## Configuration

### Settings Integration
- **API Key**: Stored in user settings (`/settings/transcription`)
- **Model Selection**: User-configurable via dropdown
- **Language**: Auto-detection or manual selection
- **Prompts**: Optional context keywords

### Constants
- **MAX_FILE_SIZE_MB**: 500MB (Deepgram limit)
- **Default Model**: 'nova-3'
- **Default Smart Format**: true

## Security Considerations

### API Key Management
- Stored securely in application settings
- Never exposed in client-side logs
- Transmitted only via Authorization header

### CORS Handling
- **Web**: Limited by browser CORS policies
- **Tauri**: Bypassed via server-side proxy
- **Fallback**: Graceful degradation with error messaging

## Performance Considerations

### Optimization Strategies
- Raw binary transmission (no FormData overhead)
- Efficient error handling with specific status code mapping
- Lazy loading of transcription service
- Memory-efficient blob processing

### Limitations
- Audio file size: 500MB maximum
- Rate limiting: Dependent on Deepgram plan
- Network dependency: Requires internet connection

## Deployment Notes

### Dependencies
- `@tauri-apps/plugin-http`: Required for Tauri builds
- `zod`: Response validation
- Platform-specific HTTP implementations

### Build Configuration
- Ensure Tauri HTTP plugin is enabled
- Configure proper permissions for network access
- Include all transcription service exports

## Maintenance

### Monitoring Points
- API response times
- Error rates by status code
- User setting configurations
- Cross-platform compatibility

### Update Procedures
- Monitor Deepgram API changes
- Update model list as new models become available
- Maintain error message accuracy
- Test cross-platform functionality on updates
