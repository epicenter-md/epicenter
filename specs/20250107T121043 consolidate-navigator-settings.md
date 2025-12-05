# Consolidate Navigator Recording Settings

## Goal
Consolidate the separate device ID and bitrate settings for manual, VAD, and live recording modes into a single "Navigator Settings" configuration that applies to all Navigator-based recording modes.

## Current State
- Each recording mode has its own settings:
  - Manual: `recording.manual.selectedDeviceId`, `recording.manual.bitrateKbps`
  - VAD: `recording.vad.selectedDeviceId` (no bitrate setting)
  - Live: `recording.live.selectedDeviceId`, `recording.live.bitrateKbps`
- CPAL has its own: `recording.cpal.selectedDeviceId` (native-only, no bitrate)
- DeviceSelector component accepts a `settingsKey` prop to determine which setting to update

## Proposed Changes

### 1. Update Settings Schema
- [x] Remove individual recording mode settings:
  - `recording.manual.selectedDeviceId`
  - `recording.manual.bitrateKbps`
  - `recording.vad.selectedDeviceId`
  - `recording.live.selectedDeviceId`
  - `recording.live.bitrateKbps`
- [x] Add consolidated Navigator settings:
  - `recording.navigator.selectedDeviceId`
  - `recording.navigator.bitrateKbps`
- [x] Keep CPAL settings unchanged: `recording.cpal.selectedDeviceId`

### 2. Update Recording Implementations
- [x] Modify `manualRecorder.ts` to use `recording.navigator.*` settings
- [x] Modify `vadRecorder.ts` to use `recording.navigator.selectedDeviceId`
- [x] Update `commands.ts` to pass Navigator settings to manual recording
- [x] Update fallback device logic in `commands.ts` to update Navigator settings

### 3. Update UI Components
- [x] Update `DeviceSelector` usage in `+page.svelte`:
  - Manual mode: Use `recording.navigator.selectedDeviceId`
  - VAD mode: Use `recording.navigator.selectedDeviceId`
- [x] Update recording settings page (`/settings/recording/+page.svelte`):
  - Create a "Navigator Settings" section that appears for manual/VAD modes
  - Move device selector and bitrate to this shared section
  - Add explanation text that these settings apply to browser-based recording modes

### 4. Remove Live Recording
- [x] Remove live recording UI from `+page.svelte`
- [x] Remove live recording section from settings page
- [x] Keep live recording settings keys in schema (for backwards compatibility) but don't expose in UI

### 5. Migration Strategy
- No explicit migration needed due to the progressive validation approach
- Old settings will be preserved but unused
- New Navigator settings will use defaults initially
- Users will naturally update to new settings when they change devices

## Benefits
- Simpler user experience - set device once for all browser-based recording
- Consistent behavior across recording modes
- Less confusion about which device is being used
- Easier to maintain and extend

## Implementation Notes
- Keep the change minimal and focused
- Ensure backwards compatibility
- Test device switching behavior thoroughly
- Verify VAD still works without explicitly using bitrate

## Review

### Summary of Changes
1. **Settings Schema**: Added new `recording.navigator.*` settings while keeping legacy settings for backwards compatibility
2. **Recording Implementations**: Updated `manualRecorder.ts` and `vadRecorder.ts` to use the new Navigator settings
3. **Commands**: Updated `commands.ts` to remove the recording settings parameter and update the fallback logic to use Navigator settings
4. **UI Components**: Updated DeviceSelector usage in the main page to use Navigator settings for both manual and VAD modes
5. **Settings Page**: Redesigned to show a unified "Navigator Settings" section when either manual or VAD mode is selected
6. **Live Recording**: Completely removed from the UI while keeping settings keys for backwards compatibility

### Key Benefits Achieved
- Users now configure device and bitrate once for all browser-based recording modes
- Simpler and more intuitive user experience
- Reduced confusion about which device is being used
- Maintained backwards compatibility through the progressive validation approach