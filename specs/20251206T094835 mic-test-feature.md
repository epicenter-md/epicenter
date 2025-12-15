# Mic Test Feature

**Created**: 2025-12-06T09:48:35  
**Status**: Completed  
**Branch**: `feature/mic-test`

## Problem Statement

Users experiencing microphone issues need to verify their mic is working without leaving the app. Currently, they must use external tools like Windows settings or mic-test websites. This creates friction in the debugging workflow.

## Solution Overview

Add a "Test Microphone" component in the Recording Settings page that allows users to:

- Select a microphone to test
- See real-time audio level visualization
- Verify microphone is working and has proper permissions
- Identify the best microphone among multiple devices

## Implementation Plan

### Todo List

- [x] Create `MicTest.svelte` component with device selection and audio level visualization
- [x] Integrate Web Audio API for real-time level detection
- [x] Add component to Recording Settings page
- [x] Test cross-platform (desktop/Tauri and web)
- [x] Run type checking with `bun check`

## Technical Details

### File Structure

```
/apps/whispering/src/routes/(app)/(config)/settings/recording/
  ├── +page.svelte (add MicTest import and render)
  ├── MicTest.svelte (NEW - main component)
  └── ... (existing files)
```

### Component Architecture

**MicTest.svelte**:

- Device selector dropdown (uses VAD device enumeration for browser device IDs)
- Refresh button for device list
- Start/Stop test buttons
- Real-time audio level meter (horizontal bar) with percentage display
- Color-coded feedback: green (0-30%), yellow (30-70%), red (70%+)
- No audio warning after 3 seconds of silence
- Error handling for permissions and device issues

### Technical Implementation

**Technical Implementation**:

1. Use `navigator.mediaDevices.getUserMedia()` to get MediaStream with exact deviceId constraint
2. Create `AudioContext` and `AnalyserNode`
3. Connect: `stream → analyser` (no output to prevent echo)
4. Use `requestAnimationFrame` loop to:
   - Call `analyser.getByteFrequencyData()`
   - Calculate RMS (Root Mean Square) average
   - Apply noise gate (threshold: 30) to filter background noise
   - Update UI with current level (0-100)
5. Cleanup on stop: cancel animation frame, stop stream tracks, close AudioContext

**Audio Level Calculation**:

- RMS calculation for accurate audio levels
- Noise gate at threshold 30 to ignore wind, breath, background noise
- Adjusted RMS = `rms < 30 ? 0 : rms - 30`
- Final level = `min(100, round(adjustedRms))`

**Device Enumeration**:

- Uses `vadRecorder.enumerateDevices` (not `rpc.recorder.enumerateDevices`)
- Critical: Web Audio API's getUserMedia requires browser device IDs
- VAD recorder uses navigator.mediaDevices which returns browser device IDs
- CPAL/FFmpeg recorder uses different device naming (incompatible with Web Audio API)

**State Management**:

- `isTestActive: boolean` - whether test is running
- `selectedTestDevice: DeviceIdentifier | null` - device to test
- `audioLevel: number` - current level (0-100)
- `errorMessage: string | null` - error message for failures
- `noAudioWarning: boolean` - warning when no audio detected

### UI Design (Following Repository Conventions)

**Components to use**:

- `@epicenter/ui/card` - Container
- `@epicenter/ui/field` - Device selector field
- `@epicenter/ui/select` - Device dropdown
- `@epicenter/ui/button` - Start/Stop controls
- Custom progress bar using Tailwind utilities

**Styling**:

- Follow existing patterns from `FfmpegCommandBuilder.svelte`
- Use Tailwind utility classes
- Apply classes directly to semantic elements (minimize wrappers)
- Use `cn()` for conditional classes

**Icons**:

- Import from `@lucide/svelte/icons/[icon-name]`
- Individual imports only (not from `lucide-svelte`)

### Integration Point

Add to Recording Settings page after device selection sections, before the separator at approximately line 260.

### Error Handling

Following wellcrafted patterns:

- Permission denied → Clear error message with retry option
- Device not found → Offer to refresh device list
- No audio detected → Warning after 3 seconds
- Use `tryAsync` for getUserMedia call
- Return graceful fallbacks with `Ok()` where appropriate

### Cross-Platform Compatibility

Works on both:

- **Desktop (Tauri)**: Via Web Audio API in WebView
- **Web**: Direct browser Web Audio API support

No platform-specific code needed - Web Audio API is universal.

## User Flow

1. Navigate to Settings → Recording
2. Scroll to "Test Microphone" section
3. Select device from dropdown (defaults to currently selected recording device)
4. Click "Start Test"
5. Speak into microphone
6. See real-time visual feedback
7. Click "Stop Test" when satisfied
8. Try different devices if needed

## Benefits

- ✅ In-app debugging - no external tools needed
- ✅ Device comparison - test multiple mics easily
- ✅ Permission verification - confirms mic access
- ✅ Cross-platform - works everywhere
- ✅ Simple implementation - minimal code changes

## Repository Conventions Followed

- **TypeScript**: Using `type` instead of `interface`, object method shorthand
- **Svelte**: Svelte 5 runes syntax, following shadcn-svelte patterns
- **Error Handling**: Using `tryAsync` from wellcrafted for getUserMedia
- **Styling**: Tailwind utilities, minimizing wrapper elements, using `cn()`
- **Icons**: Individual imports from `@lucide/svelte/icons/`
- **Imports**: Absolute imports with `$lib/` prefix
- **Component Organization**: Following existing settings component patterns

## Review

### Changes Made

**Files Created**:

- `/apps/whispering/src/routes/(app)/(config)/settings/recording/MicTest.svelte` - Main mic test component

**Files Modified**:

- `/apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte` - Added MicTest import and render

**Implementation Highlights**:

1. **Component Structure**: Built using shadcn-svelte Card component with proper Field/Select patterns
2. **Audio Detection**: Web Audio API with AnalyserNode for real-time level calculation using RMS algorithm with noise gate (threshold: 30)
3. **State Management**: Svelte 5 runes (`$state`, `$derived`, `$effect`) for reactive state
4. **Error Handling**: wellcrafted `tryAsync` for getUserMedia with graceful error messages
5. **Visual Feedback**: Minimal UI with volume bar and percentage display, color-coded (green/yellow/red) based on audio levels
6. **Device Selection**: Uses `vadRecorder.enumerateDevices` for browser-compatible device IDs (critical for Web Audio API compatibility)
7. **Cleanup**: Proper cleanup of AudioContext, MediaStream, and animation frames on component unmount
8. **Code Optimizations**: Removed unused imports, simplified calculations, eliminated redundant code

**TypeScript Compliance**:

- All type errors resolved
- Proper Result types with `Ok()` returns
- Null safety for device selection
- No new type errors introduced

### Testing Notes

**Cross-Platform Compatibility**:

- ✅ Web Audio API is available in both Tauri WebView and browsers
- ✅ No platform-specific code needed
- ✅ Works with manual and VAD recording modes

**User Experience**:

- Device selector defaults to currently selected recording device
- Real-time audio level visualization updates at ~60fps via requestAnimationFrame
- Simplified UI: volume bar with percentage display only
- Warning shown if no audio detected after 3 seconds
- Proper error messages for permission denied and device not found
- Noise gate filtering prevents false positives from background noise

**Code Quality**:

- Follows repository conventions (TypeScript style, Svelte patterns, error handling)
- Minimal wrapper elements per styling guidelines
- Individual icon imports from lucide
- Absolute imports with `$lib/` prefix
- Top-level constant for `noiseGateThreshold` (30) used consistently
- Removed unused imports (`rpc`) and variables
- Simplified redundant calculations

### Additional Notes

**Feature Positioning**:
The component is conditionally rendered only when `recording.mode` is "manual" or "vad", positioned after device selection but before method-specific settings. This placement makes logical sense as users select their device, can test it, then configure recording options.

**Performance**:

- Animation loop only runs when test is active
- Proper cleanup prevents memory leaks
- Noise gate (threshold: 30) prevents unnecessary UI updates from background noise
- Efficient RMS calculation with minimal overhead

**Accessibility**:

- Clear visual feedback with color-coded levels
- Descriptive error messages
- Percentage display for precise level reading
- Refresh button for device list

**Key Technical Decisions**:

1. **Device Enumeration**: Uses `vadRecorder.enumerateDevices` instead of `rpc.recorder.enumerateDevices` because Web Audio API's `getUserMedia` requires browser device IDs, not CPAL/FFmpeg device names
2. **Exact Device Constraint**: Uses `deviceId: { exact: String(selectedTestDevice) }` to prevent device fallback
3. **Noise Gate**: Threshold of 30 eliminates wind, breath, and background noise while keeping speech audible
4. **No Audio Output**: Stream connects to analyser only (no speakers) to prevent echo/feedback
5. **UI Simplification**: Removed peak level, instructions, and color guide per user request for minimal testing interface

**Future Enhancements** (not implemented):

- Could add waveform visualization
- Could save audio sample for playback
- Could show frequency spectrum analysis
