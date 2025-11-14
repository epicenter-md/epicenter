# macOS Media Control Integration - Web Audio API Solution

## Problem Statement

When using Whispering on macOS, the audio feedback sounds (particularly the "ta-da" completion sound) hijack the system's "now playing" state. This causes the following issues:

1. **Media Control Hijacking**: After playing the completion sound, pressing the play/pause button on the keyboard repeats the Whispering sound instead of resuming the user's original media (Spotify, etc.)
2. **Poor UX**: Users have to manually go back to their media app to resume playback

## Root Cause Analysis

The issue occurs because HTML5 `<audio>` elements automatically register with macOS's media control system when they play. When `audio.play()` is called, the web app becomes the "now playing" application, which hijacks keyboard media controls.

## Solution: Web Audio API Implementation

We replaced HTML5 audio elements with Web Audio API to avoid media control interference. This solution works for both desktop (Tauri) and web browser environments.

### Technical Approach

**Before (Problematic):**
```javascript
// This automatically becomes "now playing" when it plays
const audio = new Audio('sound.mp3');
audio.play(); // Hijacks media controls!
```

**After (Fixed):**
```javascript
// This plays audio without touching media controls
const context = new AudioContext();
const source = context.createBufferSource();
source.buffer = audioBuffer;
source.connect(context.destination);
source.start(); // No media control interference!
```

### Implementation Details

1. **Web Audio API Service**: Created `src/lib/services/sound/web-audio.ts`
   - Uses `AudioContext` and `AudioBufferSource` for sound playback
   - Caches decoded audio buffers to avoid repeated decoding
   - Handles user interaction requirements (`AudioContext.resume()`)
   - Reuses existing sound file mappings to avoid duplication

2. **Unified Architecture**: Updated `src/lib/services/sound/index.ts`
   - Uses Web Audio API for both desktop and web browser environments
   - Single implementation for all platforms

### Benefits

**✅ Fixed Issues:**
- Audio feedback no longer hijacks media controls in both desktop and web environments
- Consistent audio behavior across all platforms

**✅ Improved Architecture:**
- Single audio implementation for all environments
- No code duplication
- Cleaner, more maintainable codebase
- Audio buffers are cached for better performance

### Files Modified

- `src/lib/services/sound/web-audio.ts` - Web Audio API implementation
- `src/lib/services/sound/index.ts` - Updated to use Web Audio API everywhere
- `docs/specs/20250121T143000-macos-media-control-integration.md` - This specification

### Testing

The solution has been tested and verified to:
- Play audio feedback sounds correctly in both desktop and web environments
- Not interfere with system media controls
- Maintain the same user experience across platforms

## Conclusion

This implementation provides a clean, unified solution that fixes the media control hijacking issue across all environments while improving code maintainability.
