# Dictation Feature Implementation Plan

## Overview
Implement a dictation feature in the sh app that allows users to record audio, transcribe it, and automatically insert it into the message input field. This will be similar to the Whispering app's functionality but simplified.

## Architecture
- Create a new `packages/services` package to house transcription-related services
- Migrate relevant transcription services from `apps/whispering/src/lib/services/`
- Add a microphone button next to the submit button in the messages UI
- Store API keys in the settings modal
- Implement start/stop recording with visual feedback

## Tasks

### 1. Create packages/services structure
- [ ] Copy `packages/ui` structure to create `packages/services`
- [ ] Clean out the source folder
- [ ] Set up package.json with appropriate dependencies
- [ ] Configure TypeScript and build setup

### 2. Migrate transcription services
- [ ] Identify and extract transcription-related services from `apps/whispering/src/lib/services/`
- [ ] Move only the essential transcription functionality
- [ ] Update imports and exports
- [ ] Ensure proper module boundaries

### 3. Add API key settings
- [ ] Add OpenAI API key field to SettingsModal.svelte
- [ ] Store API key in workspace config or appropriate storage
- [ ] Add validation for API key presence

### 4. Create microphone button UI
- [ ] Add microphone button component next to submit button
- [ ] Use studio microphone emoji (🎙️) for idle state
- [ ] Use stop icon (⏹️) for recording state
- [ ] Implement toggle functionality

### 5. Implement recording logic
- [ ] Set up audio recording using Web Audio API
- [ ] Handle start/stop recording states
- [ ] Show visual feedback during recording
- [ ] Handle permissions for microphone access

### 6. Connect transcription to message flow
- [ ] Send recorded audio to transcription service
- [ ] Show loading state while transcribing
- [ ] Insert transcribed text into message input
- [ ] Automatically trigger send after transcription

## Implementation Details

### Service Migration
The transcription services will be extracted from the main app and placed in a shared package. This includes:
- Audio recording utilities
- Transcription API clients
- Audio processing helpers

### UI Integration
The microphone button will be placed inline with the message input, similar to how it appears in the Whispering app. The button will have two states:
1. **Idle**: Shows microphone emoji, click to start recording
2. **Recording**: Shows stop icon, click to stop and transcribe

### Settings Integration
API keys will be stored in the workspace configuration, accessible through the settings modal. This keeps sensitive data organized and allows per-workspace API key configuration.

## Success Criteria
- Clean separation of transcription services into a reusable package
- Smooth recording experience with clear visual feedback
- Seamless integration with existing message flow
- Proper error handling for permissions and API failures