# Linux VAD Mode Limitation

## Problem

VAD (Voice Activated Detection) mode does not work on Linux due to a fundamental technical limitation: it requires the browser's Navigator API (`navigator.mediaDevices`) to enumerate and access audio devices, but Tauri's support for this API is incomplete and unreliable on desktop platforms.

Issue: https://github.com/epicenter-md/epicenter/issues/839

## Technical Context

### Why VAD Requires Navigator API
- VAD mode uses the `@ricky0123/vad-web` library for voice activity detection
- This library requires a Web Audio API `MediaStream` object
- The only way to get a `MediaStream` is through `navigator.mediaDevices.getUserMedia()`
- Device enumeration requires `navigator.mediaDevices.enumerateDevices()`

### Why Navigator API Doesn't Work in Tauri
- Tauri's webview doesn't fully support Navigator media APIs on desktop platforms
- This is a known limitation of embedding web APIs in native desktop applications
- See: `docs/articles/stop-using-navigator-api-for-desktop-recording.md`

### Why We Can't Use CPAL for VAD
- CPAL provides native Rust audio recording that bypasses Navigator API
- However, the VAD library (`@ricky0123/vad-web`) specifically requires a browser `MediaStream`
- There's no way to bridge CPAL's native audio stream to the Web Audio API stream the VAD library needs

## Solution

We need to inform Linux users that VAD mode is not supported and guide them to use Manual mode instead.

### Approach 1: Disable VAD on Linux (Recommended)
Hide/disable the VAD recording mode option entirely on Linux platforms. This prevents users from selecting an unsupported mode.

**Pros:**
- Clear and prevents user confusion
- No broken functionality exposed
- Clean UX

**Cons:**
- Reduces feature parity across platforms
- Users might wonder why the option is missing

### Approach 2: Show Warning with Link to Issue
Allow VAD mode selection but show a prominent warning that it doesn't work on Linux, with a link to the GitHub issue for updates.

**Pros:**
- Transparent about the limitation
- Gives users context
- Provides path to follow progress

**Cons:**
- Users might still try it and get frustrated
- More cognitive load

### Approach 2: Show Warning with Link to Issue (Selected)
Allow VAD mode selection but show a prominent warning that it doesn't work on Linux, with a link to the GitHub issue for updates.

**Pros:**
- Transparent about the limitation
- Gives users context
- Provides path to follow progress
- Maintains feature parity in UI (all options visible)

**Cons:**
- Users might still try it and get frustrated
- More cognitive load

## Implementation Plan

### Todo Items

- [x] Create specification document
- [x] Keep all recording modes visible (don't filter VAD)
- [x] Add prominent warning alert when VAD mode is selected on Linux
- [x] Add link to GitHub issue #839 in the alert
- [x] Post response to GitHub issue #839 explaining the limitation

### Files to Modify

1. **`apps/whispering/src/routes/(config)/settings/recording/+page.svelte`**
   - Add Linux-specific error alert when VAD mode is selected
   - Include link to GitHub issue #839

## Code Changes

### Recording Settings Page

```svelte
{:else if settings.value['recording.mode'] === 'vad'}
  {#if IS_LINUX}
    <Alert.Root class="border-red-500/20 bg-red-500/5">
      <InfoIcon class="size-4 text-red-600 dark:text-red-400" />
      <Alert.Title class="text-red-600 dark:text-red-400">
        VAD Mode Not Supported on Linux
      </Alert.Title>
      <Alert.Description>
        Voice Activated Detection (VAD) mode requires the browser's Navigator
        API, which is not fully supported in Tauri on Linux. Device enumeration
        and recording will fail. Please use Manual recording mode instead.
        <Link
          href="https://github.com/epicenter-md/epicenter/issues/839"
          target="_blank"
          class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
        >
          Learn more →
        </Link>
      </Alert.Description>
    </Alert.Root>
  {:else}
    <Alert.Root class="border-blue-500/20 bg-blue-500/5">
      <InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
      <Alert.Title class="text-blue-600 dark:text-blue-400">
        Voice Activated Detection Mode
      </Alert.Title>
      <Alert.Description>
        VAD mode uses the browser's Web Audio API for real-time voice detection.
        Unlike manual recording, VAD mode cannot use alternative recording
        methods and must use the browser's MediaRecorder API.
      </Alert.Description>
    </Alert.Root>
  {/if}

  <VadSelectRecordingDevice bind:selected={...} />
{/if}
```

## Implementation Summary

### Changes Made

1. **Conditional VAD mode alert** (`apps/whispering/src/routes/(config)/settings/recording/+page.svelte:215-246`):
   - When VAD mode is selected on Linux, shows a red error alert
   - Alert clearly states "VAD Mode Not Supported on Linux"
   - Explains that device enumeration and recording will fail
   - Provides link to GitHub issue #839 for users who want more details
   - Uses red color scheme (error) since the feature will actually fail

2. **Preserved existing VAD info alert** for non-Linux platforms:
   - Blue informational alert explaining how VAD mode works
   - Only shown on macOS and Windows where it's supported

3. **All recording modes remain selectable**:
   - VAD still appears in the dropdown on Linux
   - Users can see the option but get immediate warning when selected
   - Maintains UI consistency across platforms

### Why This Approach Works

1. **Immediate feedback**: Users see a clear error message the moment they select VAD mode
2. **Full transparency**: The alert explicitly states the feature won't work, not just a gentle warning
3. **Maintains feature visibility**: Users can see what features exist, even if not available on their platform
4. **Follows existing patterns**: Similar to how we handle FFmpeg not installed (red error alert)
5. **Minimal code changes**: Only modified one file with a simple conditional
6. **Platform-agnostic core**: The limitation is handled at the UI level, not in service layer
7. **Actionable information**: Link to GitHub issue allows users to understand why and track any future solutions

## Review

The implementation successfully addresses the Linux VAD limitation by:
- Keeping all recording modes visible for feature parity
- Showing a prominent error alert when VAD is selected on Linux
- Clearly explaining that the feature will fail due to Navigator API limitations
- Providing a link to the GitHub issue for transparency and context
- Following established UI patterns for platform-specific errors (similar to FFmpeg warnings)
- Requiring minimal code changes (single file modification)

This solution balances user experience with technical honesty. Linux users can see that VAD mode exists, but receive immediate clear feedback that it won't work on their platform, along with guidance to use Manual mode instead.
