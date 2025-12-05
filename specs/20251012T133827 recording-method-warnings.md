# Recording Method Clarity and Local Transcription Compatibility

## Problem
Users need clearer guidance about which recording methods work with local transcription. Current issues:
1. VAD description incorrectly says it uses MediaRecorder API
2. No clarity about Navigator requiring FFmpeg for local transcription
3. No proactive warnings for incompatible configurations

## Compatibility Matrix
- **CPAL**: Uncompressed WAV → works with local transcription ✅
- **Navigator**: Compressed audio → requires FFmpeg for local transcription ⚠️
- **VAD**: Uncompressed WAV → works with local transcription ✅
- **FFmpeg**: Configurable → works with local transcription ✅

## Implementation Plan

### Task 1: Fix VAD Description
- [ ] Update VAD alert in recording settings to clarify it produces WAV files directly
- [ ] Remove misleading reference to MediaRecorder API

### Task 2: Enhance Recording Method Descriptions
- [ ] Add local transcription compatibility info to CPAL description
- [ ] Add FFmpeg requirement warning to Navigator description

### Task 3: Add Compatibility Warning in Recording Settings
- [ ] Add alert when Navigator + local transcription + no FFmpeg detected
- [ ] Provide three clear options: switch to CPAL, install FFmpeg, or use cloud
- [ ] Make alert reactive to setting changes

### Task 4: Add Compatibility Warning in Transcription Settings
- [ ] Add same warning in Whisper C++ section
- [ ] Add same warning in Parakeet section
- [ ] Make alerts contextual to each service

### Task 5: (Optional) Add Helper Function
- [ ] Create `hasNavigatorLocalTranscriptionIssue()` helper
- [ ] Add constant for reusable warning message
- [ ] Simplify alert conditions in components

## Files to Modify
1. `apps/whispering/src/routes/(config)/settings/recording/+page.svelte`
2. `apps/whispering/src/routes/(config)/settings/transcription/+page.svelte`
3. `apps/whispering/src/routes/+layout/check-ffmpeg.ts` (optional)

## Success Criteria
- VAD description is accurate
- Recording method descriptions show compatibility clearly
- Users see warnings before attempting incompatible configurations
- Warnings provide actionable solutions
- No misleading information about APIs

## Review

All tasks completed successfully:

### Task 1: Fixed VAD Description ✅
Updated the VAD alert in `apps/whispering/src/routes/(config)/settings/recording/+page.svelte` (line 212-215) to accurately reflect that VAD produces uncompressed WAV files directly via Web Audio API, not compressed files via MediaRecorder API.

### Task 2: Enhanced Recording Method Descriptions ✅
Updated `RECORDING_METHOD_OPTIONS` in the recording settings page:
- **CPAL**: Added "Works with all transcription methods" to clarify its universal compatibility
- **Navigator**: Added "Requires FFmpeg for local transcription (Whisper C++/Parakeet)" to warn about the limitation

### Task 3: Added Compatibility Warning in Recording Settings ✅
Added a red alert box (lines 175-212) that appears when:
- Recording method is Navigator
- Transcription service is Whisper C++ or Parakeet
- FFmpeg is not installed

The alert provides three clear options:
1. Button to switch to CPAL recording immediately
2. Link to install FFmpeg
3. Suggestion to use cloud transcription

### Task 4: Added Compatibility Warning in Transcription Settings ✅
Added similar alerts in both local transcription sections:
- **Whisper C++** section (lines 429-457)
- **Parakeet** section (lines 534-562)

Both alerts provide the same three options, helping users resolve the incompatibility from either settings page.

### Task 5: Added Helper Functions ✅
Created helper functions in `apps/whispering/src/routes/+layout/check-ffmpeg.ts`:
- `hasNavigatorLocalTranscriptionIssue()`: Checks if Navigator + local transcription + no FFmpeg
- `NAVIGATOR_LOCAL_TRANSCRIPTION_MESSAGE`: Reusable warning message constant
- `RECORDING_COMPATIBILITY_MESSAGE`: More detailed message for toast notifications

Note: Initially added `hasLocalTranscriptionCompatibilityIssue()` as a legacy alias, but removed it in favor of using the more descriptive `hasNavigatorLocalTranscriptionIssue()` name consistently throughout the codebase.

### Changes Summary

**Files Modified:**
1. `apps/whispering/src/routes/(config)/settings/recording/+page.svelte`
   - Fixed VAD description
   - Enhanced recording method descriptions
   - Added compatibility warning alert with action buttons

2. `apps/whispering/src/routes/(config)/settings/transcription/+page.svelte`
   - Added compatibility warning in Whisper C++ section
   - Added compatibility warning in Parakeet section

3. `apps/whispering/src/routes/+layout/check-ffmpeg.ts`
   - Added `hasNavigatorLocalTranscriptionIssue()` function
   - Updated `checkLocalTranscriptionCompatibility()` to use the new function
   - Added message constants (`NAVIGATOR_LOCAL_TRANSCRIPTION_MESSAGE` and `RECORDING_COMPATIBILITY_MESSAGE`)

### User Experience Impact

Users will now receive clear, proactive guidance when they select incompatible configurations:
- No more confusion about whether VAD uses MediaRecorder
- Recording method descriptions clearly state compatibility requirements
- Immediate alerts when selecting Navigator + local transcription without FFmpeg
- Three actionable solutions presented in every alert
- Consistent messaging across both settings pages

The implementation ensures users understand the compatibility matrix before attempting transcription, preventing frustration and failed transcription attempts.
