# FFmpeg Recording Format Compatibility Guide

## The Problem
OpenAI's Whisper API often rejects MP3 files with "400 Audio file might be corrupted or unsupported" even when the files play fine elsewhere and work with Groq's API.

## Root Causes
1. **OpenAI's strict validation** - The API validates file headers very strictly
2. **Live recording issues** - FFmpeg live recording doesn't always finalize headers properly
3. **Container format mismatches** - The file content must match the extension exactly

## Working Solutions

### Recommended Format by Provider

| Provider | Best Format | FFmpeg Options | Notes |
|----------|------------|----------------|-------|
| OpenAI | WAV | `-f wav -acodec pcm_s16le -ar 16000 -ac 1` | Most reliable, always works |
| Groq | MP3/Opus | `-f mp3 -acodec libmp3lame -b:a 128k` | More flexible, accepts various formats |
| Both | WAV | `-f wav -acodec pcm_s16le -ar 44100 -ac 1` | Universal compatibility |

### Why MP3 Fails with OpenAI
- Live recording with FFmpeg can't properly write MP3 frame headers when interrupted
- OpenAI strictly validates MP3 frame boundaries
- ID3 tags can cause issues if malformed
- VBR headers need proper finalization

### Alternative Approaches

1. **Record in WAV, convert later**
   ```bash
   # Record in WAV (reliable)
   ffmpeg -f avfoundation -i ":0" -f wav -acodec pcm_s16le output.wav
   
   # Convert to MP3 after recording (proper headers)
   ffmpeg -i output.wav -acodec libmp3lame -b:a 128k output.mp3
   ```

2. **Use different formats per provider**
   ```typescript
   const format = provider === 'openai' ? 'wav' : 'mp3';
   ```

3. **Post-process MP3 files**
   - Use a library to fix MP3 headers after recording
   - Re-encode the file to ensure proper structure

## Current Implementation
We've simplified the FFmpeg options to use minimal, reliable flags:
- Explicit container format (`-f`) for each codec
- Standard encoding parameters
- No unnecessary metadata flags

## Testing Results
- ✅ WAV: Works with all providers
- ⚠️ MP3: Works with Groq, intermittent with OpenAI
- ✅ Opus: Works with transcription, browser playback fixed with `-f ogg`
- ✅ OGG: Uses quality scale for better compression