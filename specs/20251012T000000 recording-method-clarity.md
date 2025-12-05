# Recording Method Clarity and Local Transcription Compatibility

## Problem Statement

Users need clearer guidance about which recording methods work with local transcription (Whisper C++, Parakeet) and when FFmpeg is required. Currently:

1. **Misleading VAD description**: Settings page says VAD "must use the browser's MediaRecorder API" but it actually uses Web Audio API with manual WAV encoding
2. **Hidden compatibility rules**: Users don't understand that Navigator (MediaRecorder) produces compressed formats that require FFmpeg for local transcription
3. **No proactive guidance**: No clear messaging when users select incompatible combinations (Navigator + local transcription without FFmpeg)

## Current Behavior

### Recording Methods and Their Output Formats

**CPAL (Rust-based)**
- Output: Uncompressed WAV (32-bit float or 16-bit PCM depending on sample rate)
- Works with local transcription: ✅ Yes (pure Rust conversion handles it)
- FFmpeg required: ❌ No

**Navigator (Browser MediaRecorder)**
- Output: Compressed audio (webm/Opus or ogg/Vorbis depending on browser)
- Works with local transcription: ⚠️ Only with FFmpeg installed
- FFmpeg required: ✅ Yes for local transcription

**VAD (Voice Activated Detection)**
- Output: Uncompressed WAV (32-bit float via Web Audio API + manual encoding)
- Works with local transcription: ✅ Yes (pure Rust conversion handles it)
- FFmpeg required: ❌ No
- Note: Despite using browser APIs, VAD captures raw audio and manually encodes as WAV

**FFmpeg (Command-line recording)**
- Output: Configurable (default: compressed format)
- Works with local transcription: ✅ Yes (can configure output format)
- FFmpeg required: ✅ Yes (obviously)

## Goal

Make users aware of recording method compatibility and guide them toward working configurations before they encounter transcription failures.

## Implementation Plan

### Task 1: Fix VAD Description
**File**: `apps/whispering/src/routes/(config)/settings/recording/+page.svelte` (lines ~236-246)

**Current text** (misleading):
```svelte
<Alert.Description>
  VAD mode uses the browser's Web Audio API for real-time voice
  detection. Unlike manual recording, VAD mode cannot use alternative
  recording methods and must use the browser's MediaRecorder API.
</Alert.Description>
```

**New text** (accurate):
```svelte
<Alert.Description>
  VAD mode uses the browser's Web Audio API for real-time voice
  detection and audio capture. Unlike manual recording, VAD mode
  produces uncompressed WAV files directly and cannot use alternative
  recording methods (CPAL or FFmpeg).
</Alert.Description>
```

### Task 2: Add Recording Method Descriptions
**File**: `apps/whispering/src/routes/(config)/settings/recording/+page.svelte` (lines ~34-61)

Update the `RECORDING_METHOD_OPTIONS` descriptions to clarify local transcription compatibility:

**CPAL description** (add clarity):
```typescript
{
  value: 'cpal',
  label: 'CPAL',
  description: IS_MACOS
    ? 'Native Rust audio method. Records uncompressed WAV, reliable with shortcuts. Works with all transcription methods.'
    : 'Native Rust audio method. Records uncompressed WAV format. Works with all transcription methods.',
}
```

**Navigator description** (add warning):
```typescript
{
  value: 'navigator',
  label: 'Browser API',
  description: IS_MACOS
    ? 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription. Requires FFmpeg for local transcription (Whisper C++/Parakeet). May have delays with shortcuts when app is in background (macOS AppNap).'
    : 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription. Requires FFmpeg for local transcription (Whisper C++/Parakeet).',
}
```

### Task 3: Add Proactive Compatibility Warning
**File**: `apps/whispering/src/routes/(config)/settings/recording/+page.svelte`

Add a new alert block after the recording method selector that appears when:
- Recording method is "navigator"
- Selected transcription service is "whispercpp" or "parakeet"
- FFmpeg is not installed

**Location**: After line 202 (after the compression recommendation alert)

**Implementation**:
```svelte
{#if settings.value['recording.method'] === 'navigator' &&
     (settings.value['transcription.selectedTranscriptionService'] === 'whispercpp' ||
      settings.value['transcription.selectedTranscriptionService'] === 'parakeet') &&
     !data.ffmpegInstalled}
  <Alert.Root class="border-red-500/20 bg-red-500/5">
    <InfoIcon class="size-4 text-red-600 dark:text-red-400" />
    <Alert.Title class="text-red-600 dark:text-red-400">
      Local Transcription Requires FFmpeg or CPAL Recording
    </Alert.Title>
    <Alert.Description>
      The Browser API recording method produces compressed audio that requires FFmpeg
      for local transcription with {settings.value['transcription.selectedTranscriptionService'] === 'whispercpp' ? 'Whisper C++' : 'Parakeet'}.
      <div class="mt-3 space-y-3">
        <div class="flex items-center gap-2">
          <span class="text-sm"><strong>Option 1:</strong></span>
          <Button
            onclick={() => settings.updateKey('recording.method', 'cpal')}
            variant="secondary"
            size="sm"
          >
            Switch to CPAL Recording
          </Button>
        </div>
        <div class="text-sm">
          <strong>Option 2:</strong>
          <Link href="/install-ffmpeg">Install FFmpeg</Link>
          to keep using Browser API recording
        </div>
        <div class="text-sm">
          <strong>Option 3:</strong>
          Switch to a cloud transcription service (OpenAI, Groq, Deepgram, etc.)
          which work with all recording methods
        </div>
      </div>
    </Alert.Description>
  </Alert.Root>
{/if}
```

### Task 4: Add Similar Warning to Transcription Settings
**File**: `apps/whispering/src/routes/(config)/settings/transcription/+page.svelte`

Add the same warning logic but from the transcription settings perspective:
- When user selects "whispercpp" or "parakeet"
- Recording method is "navigator"
- FFmpeg is not installed

**Location**: After the model selector for each local transcription service (after lines ~431 and ~536)

**Implementation**: Similar alert as above but with emphasis on switching transcription service or installing FFmpeg.

### Task 5: Update Helper Function (Optional)
**File**: `apps/whispering/src/routes/+layout/check-ffmpeg.ts`

Consider adding a new helper function to check this specific compatibility issue:

```typescript
/**
 * Checks if the current recording + transcription configuration will work
 * @returns true if Navigator recording is used with local transcription but FFmpeg is not installed
 */
export function hasNavigatorLocalTranscriptionIssue({
  isFFmpegInstalled,
}: {
  isFFmpegInstalled: boolean;
}): boolean {
  if (!window.__TAURI_INTERNALS__) return false;

  const recordingMethod = settings.value['recording.method'];
  const transcriptionService = settings.value['transcription.selectedTranscriptionService'];

  const isUsingNavigator = recordingMethod === 'navigator';
  const isUsingLocalTranscription =
    transcriptionService === 'whispercpp' ||
    transcriptionService === 'parakeet';

  return isUsingNavigator && isUsingLocalTranscription && !isFFmpegInstalled;
}

export const NAVIGATOR_LOCAL_TRANSCRIPTION_MESSAGE =
  'Browser API recording produces compressed audio that requires FFmpeg for local transcription. Switch to CPAL recording or install FFmpeg.';
```

This can simplify the alert conditions in the Svelte files.

## Success Criteria

- [ ] VAD description accurately reflects that it produces WAV files
- [ ] Recording method descriptions clearly state local transcription compatibility
- [ ] Users see proactive warnings when selecting incompatible configurations
- [ ] Warnings provide clear, actionable solutions (switch to CPAL, install FFmpeg, or use cloud)
- [ ] No misleading information about MediaRecorder being used by VAD
- [ ] Alert appears in both recording and transcription settings pages

## User Experience Flow Examples

### Example 1: User wants local transcription without FFmpeg
1. User selects Whisper C++ in transcription settings
2. User goes to recording settings and selects "Browser API"
3. Alert appears: "Local Transcription Requires FFmpeg or CPAL Recording"
4. User clicks "Switch to CPAL Recording" button
5. Recording method changes to CPAL, alert disappears
6. User can now transcribe locally without FFmpeg

### Example 2: User already using Navigator + local transcription
1. User opens recording settings
2. Sees Navigator is selected, Whisper C++ is the transcription service, FFmpeg not installed
3. Alert shows immediately with three options
4. User chooses to install FFmpeg via the link
5. After FFmpeg installation, alert disappears

### Example 3: User switches to local transcription
1. User is using Navigator recording with OpenAI transcription (working fine)
2. User goes to transcription settings and selects Parakeet
3. Alert appears in transcription settings warning about Navigator compatibility
4. User can switch recording method or install FFmpeg before attempting transcription

## Technical Notes

### Why This Matters
With the new pure Rust audio conversion, the compatibility matrix has changed:
- CPAL + local: ✅ Works without FFmpeg (Rust converts 32-bit float WAV)
- Navigator + local: ❌ Requires FFmpeg (compressed format needs external conversion)
- VAD + local: ✅ Works without FFmpeg (produces WAV despite using browser APIs)

### Implementation Considerations
1. The alerts should be dismissible but reappear if configuration remains incompatible
2. Consider using `$derived` to make the alert logic reactive to settings changes
3. Import settings and data from props to access current configuration
4. Use consistent styling with existing alerts (red for errors, amber for warnings)

## Files to Modify

1. `apps/whispering/src/routes/(config)/settings/recording/+page.svelte`
   - Update VAD alert description
   - Enhance recording method descriptions
   - Add Navigator + local transcription compatibility alert

2. `apps/whispering/src/routes/(config)/settings/transcription/+page.svelte`
   - Add compatibility alert for whispercpp section
   - Add compatibility alert for parakeet section

3. `apps/whispering/src/routes/+layout/check-ffmpeg.ts` (optional)
   - Add `hasNavigatorLocalTranscriptionIssue()` helper
   - Add `NAVIGATOR_LOCAL_TRANSCRIPTION_MESSAGE` constant

## Out of Scope

- Automatically switching recording methods (let user decide)
- Changing VAD to use different recording implementation (works fine as-is)
- Adding runtime detection during transcription (catch it earlier in settings)
- Changing the default recording method based on transcription service
