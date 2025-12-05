# Fix Audio Playback on Desktop

## Problem
Audio playback is not working in the recordings table on desktop. The file system implementation sets `blob: undefined` because desktop stores audio as files on disk, not blobs. The UI can't play audio without a source.

## Root Cause
- Desktop stores audio files on disk (e.g., `{id}.webm`, `{id}.mp3`)
- File system db sets `blob: undefined` in recordings
- UI expects either a blob or audio source URL to play audio
- Currently recordings have neither on desktop

## Solution Options

### Option 1: Read file and convert to Blob ❌
- Load entire audio file into memory as Blob
- Works with existing UI
- **Not recommended**: Memory intensive, inefficient for large files

### Option 2: Use `convertFileSrc()` ✅ (Recommended)
- Use Tauri's `convertFileSrc()` to convert file path to URL
- Efficient - browser can stream the file
- Standard Tauri pattern for serving local files
- Need to update UI to handle file URLs

### Option 3: Hybrid Approach ✅ (Also Good)
- Add optional `audioSrc?: string` field to Recording
- Desktop populates `audioSrc` with `convertFileSrc()`
- Web continues using blob
- UI checks `audioSrc` first, falls back to blob URL

## Recommended Implementation (Option 2/3)

### Todo Items

- [ ] Add `audioSrc?: string` field to Recording type
- [ ] Update file-system.ts read methods to generate audio URLs
  - [ ] In `markdownToRecording()`, add logic to check for audio file
  - [ ] Use `convertFileSrc()` to generate URL from file path
  - [ ] Set `audioSrc` field on returned Recording
- [ ] Find UI component that renders audio player
- [ ] Update audio player to use `audioSrc` when available
- [ ] Test audio playback on desktop
- [ ] Verify web still works with blob URLs

## Technical Details

### Tauri's `convertFileSrc()`
```typescript
import { convertFileSrc } from '@tauri-apps/api/core';

const filePath = '/Users/braden/AppData/recordings/abc123.webm';
const audioSrc = convertFileSrc(filePath);
// Returns: 'http://asset.localhost/Users/braden/AppData/recordings/abc123.webm'
```

This converts an absolute file path to a URL that the Tauri webview can load.

### Recording Type Update
```typescript
export type Recording = {
  id: string;
  // ... other fields
  blob: Blob | undefined;
  audioSrc?: string; // NEW: URL for audio playback (desktop uses this)
  transcribedText: string;
  transcriptionStatus: 'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED';
};
```

### File System Implementation
In `markdownToRecording()`:
```typescript
async function markdownToRecording({ frontMatter, body }): Promise<Recording> {
  const recording = {
    // ... spread frontMatter fields
    transcribedText: body,
    blob: undefined,
  };

  // Check for audio file and generate URL
  const recordingsPath = await PATHS.DB.RECORDINGS();
  const audioExtensions = ['.webm', '.mp3', '.wav', '.m4a'];

  for (const ext of audioExtensions) {
    const audioPath = await join(recordingsPath, `${frontMatter.id}${ext}`);
    if (await exists(audioPath)) {
      recording.audioSrc = convertFileSrc(audioPath);
      break;
    }
  }

  return recording;
}
```

### UI Update
```typescript
// In audio player component
const audioSrc = recording.audioSrc
  ? recording.audioSrc
  : recording.blob
    ? URL.createObjectURL(recording.blob)
    : undefined;

// Use audioSrc in <audio> element
```

## Notes
- Desktop will use `audioSrc` field
- Web will continue using `blob` field
- Both paths converge at the UI layer
- Need to handle case where neither exists (show disabled state)

## Review
[To be filled after implementation]
