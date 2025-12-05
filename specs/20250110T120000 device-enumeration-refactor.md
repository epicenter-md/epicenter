# Device Enumeration Refactor

## Problem Statement
Currently, the device enumeration system returns only an array of `DeviceIdentifier[]`, which conflates device IDs and labels. On web platforms, we're actually returning deviceIds (unique identifiers like GUIDs), but the UI shows these cryptic IDs directly to users. On desktop platforms (CPAL), the device name serves as both ID and label, which is acceptable but inconsistent.

## Goals
1. Separate device label (human-readable name) from device ID (unique identifier)
2. Provide consistent API across web and desktop platforms
3. Improve user experience by showing readable device names in UI
4. Maintain backward compatibility with existing settings

## Current Architecture Analysis

### Type System
- `DeviceIdentifier`: A branded string type representing platform-agnostic device identifier
- On Web: Stores the actual deviceId (GUID)
- On Desktop: Stores the device name (which serves as both ID and label)

### Service Layer
- `enumerateRecordingDeviceIds()`: Returns `DeviceIdentifier[]`
- Web implementation (`device-stream.ts`): Maps devices to deviceIds
- Desktop implementation (`desktop.ts`): Maps devices to device names

### UI Layer
- `SelectRecordingDevice.svelte`: Shows deviceIds directly as labels (poor UX on web)
- Settings store: Stores selected device as `DeviceIdentifier`

## Proposed Solution

### New Type Structure
```typescript
// New device type that separates label from ID
export type Device = {
  id: DeviceIdentifier;
  label: string;
};
```

### Platform Behavior
- **Web**: 
  - `id`: The unique deviceId from MediaDeviceInfo
  - `label`: The human-readable label from MediaDeviceInfo
- **Desktop (CPAL)**:
  - `id`: The device name (same as current)
  - `label`: The device name (same value as ID)

### API Changes
- Rename `enumerateRecordingDeviceIds()` → `enumerateDevices()`
- Return type changes from `DeviceIdentifier[]` → `Device[]`
- Settings remain unchanged (still store `DeviceIdentifier` as the ID)

## Implementation Tasks

### 1. Type Updates (`services/types.ts`)
- [ ] Add new `Device` type with `id` and `label` fields
- [ ] Keep `DeviceIdentifier` for backward compatibility
- [ ] Update service interfaces to use `Device[]`

### 2. Web Platform Updates (`device-stream.ts`)
- [ ] Rename function to `enumerateDevices`
- [ ] Return array of `Device` objects with proper label/id mapping
- [ ] Ensure deviceId is used as ID, label as label

### 3. Desktop Platform Updates (`recorder/desktop.ts`)
- [ ] Rename function to `enumerateDevices`
- [ ] Return array of `Device` objects where label === id

### 4. Recorder Service Updates (`recorder/types.ts`, `recorder/web.ts`)
- [ ] Update `RecorderService` interface
- [ ] Update web implementation to use new function name
- [ ] Ensure backward compatibility with device selection

### 5. Query Layer Updates (`query/recorder.ts`)
- [ ] Update query to use new function name
- [ ] Adjust return type handling

### 6. UI Updates (`SelectRecordingDevice.svelte`)
- [ ] Use device label for display
- [ ] Use device ID for value/selection
- [ ] Improve UX with readable device names

### 7. Settings Compatibility
- [ ] No changes needed - settings continue to store DeviceIdentifier (the ID)
- [ ] Existing settings will work as device IDs remain the same

## Migration Strategy
1. The refactor maintains backward compatibility
2. Existing stored device IDs remain valid
3. No settings migration required
4. Users will see improved device names immediately after update

## Testing Considerations
- Test device enumeration on both web and desktop
- Verify existing device selections still work
- Ensure fallback device selection works correctly
- Test with multiple audio devices
- Test with no audio devices

## Potential Issues
1. Device labels might be empty on some systems - need fallback to ID
2. Device labels might change between browser sessions - ID remains stable
3. Desktop devices where name changes might break selection - acceptable trade-off

## Review Section
*To be completed after implementation*