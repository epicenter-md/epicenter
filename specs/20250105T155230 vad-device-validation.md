# VAD Device Validation Implementation

## Problem
The VAD recorder doesn't validate if the selected device ID actually exists before starting, unlike the manual recorder which has robust device validation and fallback logic.

## Current Manual Recorder Approach
1. Checks if a device ID is selected
2. Attempts to connect to the selected device
3. Falls back to first available device if:
   - No device was selected
   - Selected device is unavailable
4. Provides clear status messages throughout the process

## Plan

### Todo Items
- [ ] Extract shared device validation logic into a common utility
- [ ] Update VAD service to validate device before initialization
- [ ] Implement fallback logic when selected device is unavailable
- [ ] Add appropriate error handling and status messaging
- [ ] Test device switching scenarios

### Implementation Approach
1. Create a shared utility for device validation that both services can use
2. Update VAD service to check device availability before creating MicVAD instance
3. Implement fallback to first available device if selected device fails
4. Ensure proper cleanup and re-initialization when device changes

### Key Considerations
- Keep changes minimal and focused
- Reuse existing patterns from manual recorder
- Maintain consistent error handling approach
- Don't duplicate code unnecessarily