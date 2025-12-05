# Query Layer Commands Refactor Plan

## Review of Changes

### Completed Refactoring

The refactoring has been successfully implemented with the following changes:

1. **Created `/apps/whispering/src/lib/query/commands.ts`**
   - Moved all command logic from the original commands.ts file
   - Implemented commands as mutations following the query layer pattern
   - Moved `saveRecordingAndTranscribeTransform` and renamed it to `processRecordingPipeline`
   - Added `uploadRecording` mutation (moved from recordings.ts)
   - Kept `processRecordingPipeline` as an internal function, not exported in the commands object

2. **Updated `/apps/whispering/src/lib/commands.ts`**
   - Simplified to only contain command metadata and callbacks
   - Each callback now uses `rpc.commands.*.execute()` pattern
   - Removed all implementation details and direct service calls

3. **Updated `/apps/whispering/src/lib/query/index.ts`**
   - Added `commands` to the RPC namespace
   - Commands are now accessible via `rpc.commands.*`

4. **Updated `/apps/whispering/src/lib/query/recordings.ts`**
   - Removed the `uploadRecording` mutation (moved to commands.ts)
   - Removed unused imports

5. **Updated `/apps/whispering/src/routes/+page.svelte`**
   - Changed `rpc.recordings.uploadRecording.execute({ file })` 
   - To: `rpc.commands.uploadRecording.execute({ file })`

### Benefits Achieved

- **Consistency**: All commands now follow the same RPC pattern
- **Centralization**: All command logic is in one place (query/commands.ts)
- **Better Organization**: Upload recording is grouped with other commands since it uses the same pipeline
- **Simplified commands.ts**: Now just a thin wrapper that defines metadata
- **Type Safety**: Maintained throughout with proper Result types
- **No Breaking Changes**: All existing functionality preserved

### Key Design Decision

The `processRecordingPipeline` function is kept internal to commands.ts and not exposed through the RPC interface. This is appropriate because:
- It's only used internally by commands
- `uploadRecording` can call it directly since they're in the same file
- Keeps the public API cleaner
- Prevents misuse of the pipeline function

---

# Query Layer Commands Refactor Plan

## Overview

This plan outlines how to refactor the `commands.ts` file to move command logic into the query layer following the RPC pattern. The goal is to have `commands.ts` simply import RPC and call these top-level commands like `rpc.commands.toggleManualRecording()` etc.

## Current State Analysis

### Current Architecture
- **commands.ts**: Contains all command implementations with direct RPC calls
- **saveRecordingAndTranscribeTransform**: A shared function that handles the full recording → transcription → transformation pipeline
- Commands are exported as an array with metadata (id, title, trigger state, callback)

### Key Patterns Observed
1. Most commands follow a similar pattern:
   - Generate a toast ID
   - Check current state (recorder state, VAD state, etc.)
   - Execute start/stop/cancel operations
   - Handle device acquisition outcomes
   - Play sounds
   - Chain to `saveRecordingAndTranscribeTransform` for completed recordings

2. The `saveRecordingAndTranscribeTransform` function is a critical shared utility that:
   - Creates a recording in the database
   - Triggers transcription
   - Optionally chains to transformation
   - Handles all error cases with appropriate toasts

## Proposed Architecture

### New File Structure
```
/apps/whispering/src/lib/query/
├── commands.ts          # New file with all command logic
├── index.ts             # Update to include commands in RPC namespace
└── README.md            # Update documentation
```

### Implementation Plan

#### 1. Create `/apps/whispering/src/lib/query/commands.ts`

This file will contain:
- All command implementations as mutations
- The `saveRecordingAndTranscribeTransform` function (renamed for clarity)
- Helper functions for common patterns

```typescript
import { defineMutation } from './_client';
import { nanoid } from 'nanoid/non-secure';
import { settings } from '$lib/stores/settings.svelte';
import { notify } from './notify';
import { sound } from './sound';
import { manualRecorder } from './manual-recorder';
import { cpalRecorder } from './cpal-recorder';
import { vadRecorder } from './vad-recorder';
import { recordings } from './recordings';
import { transcription } from './transcription';
import { transformations } from './transformations';
import { transformer } from './transformer';
import { delivery } from './delivery';
import { WhisperingErr } from '$lib/result';
import { Ok, Err } from 'wellcrafted/result';

// Shared utility function
async function processRecordingPipeline({
  blob,
  toastId,
  completionTitle,
  completionDescription,
}: {
  blob: Blob;
  toastId: string;
  completionTitle: string;
  completionDescription: string;
}) {
  // Implementation moved from saveRecordingAndTranscribeTransform
  // This will be used by multiple commands
}

export const commands = {
  // Push to talk command
  pushToTalk: defineMutation({
    mutationKey: ['commands', 'pushToTalk'] as const,
    resultMutationFn: async () => {
      const { data: recorderState, error } = 
        await manualRecorder.getRecorderState.fetch();
      
      if (error) {
        return Err(WhisperingErr({
          title: '❌ Failed to get recorder state',
          description: 'Your recording could not be started. Please try again.',
          action: { type: 'more-details', error },
        }));
      }

      if (recorderState === 'RECORDING') {
        return stopManualRecording.execute();
      } else {
        return startManualRecording.execute();
      }
    },
  }),

  // Toggle manual recording
  toggleManualRecording: defineMutation({
    mutationKey: ['commands', 'toggleManualRecording'] as const,
    resultMutationFn: async () => {
      // Similar implementation to pushToTalk
    },
  }),

  // Start manual recording (internal command)
  startManualRecording: defineMutation({
    mutationKey: ['commands', 'startManualRecording'] as const,
    resultMutationFn: async () => {
      const toastId = nanoid();
      
      notify.loading.execute({
        id: toastId,
        title: '🎙️ Preparing to record...',
        description: 'Setting up your recording environment...',
      });

      const { data: deviceAcquisitionOutcome, error } = 
        await manualRecorder.startRecording.execute({ toastId });

      if (error) {
        return Err(WhisperingErr({
          title: '❌ Failed to start recording',
          description: 'Your recording could not be started. Please try again.',
          action: { type: 'more-details', error },
        }));
      }

      // Handle device acquisition outcomes
      // ... (implementation details)

      return Ok(deviceAcquisitionOutcome);
    },
  }),

  // Stop manual recording (internal command)
  stopManualRecording: defineMutation({
    mutationKey: ['commands', 'stopManualRecording'] as const,
    resultMutationFn: async () => {
      const toastId = nanoid();
      
      // ... implementation
      
      // Chain to pipeline
      await processRecordingPipeline({
        blob,
        toastId,
        completionTitle: '✨ Recording Complete!',
        completionDescription: 'Recording saved and session closed successfully',
      });
      
      return Ok(blob);
    },
  }),

  // Cancel manual recording
  cancelManualRecording: defineMutation({
    mutationKey: ['commands', 'cancelManualRecording'] as const,
    resultMutationFn: async () => {
      // ... implementation
    },
  }),

  // Toggle VAD recording
  toggleVadRecording: defineMutation({
    mutationKey: ['commands', 'toggleVadRecording'] as const,
    resultMutationFn: async () => {
      // ... implementation
    },
  }),

  // CPAL commands (conditionally included)
  ...(window.__TAURI_INTERNALS__ ? {
    toggleCpalRecording: defineMutation({
      mutationKey: ['commands', 'toggleCpalRecording'] as const,
      resultMutationFn: async () => {
        // ... implementation
      },
    }),
    
    cancelCpalRecording: defineMutation({
      mutationKey: ['commands', 'cancelCpalRecording'] as const,
      resultMutationFn: async () => {
        // ... implementation
      },
    }),
  } : {}),
};
```

#### 2. Update `/apps/whispering/src/lib/commands.ts`

Simplify to just use RPC:

```typescript
import { rpc } from '$lib/query';
import type { ShortcutTriggerState } from './services/_shortcut-trigger-state';

type SatisfiedCommand = {
  id: string;
  title: string;
  on: ShortcutTriggerState;
  callback: () => void;
};

export const commands = [
  {
    id: 'pushToTalk',
    title: 'Push to talk',
    on: 'Both',
    callback: () => rpc.commands.pushToTalk.execute(),
  },
  {
    id: 'toggleManualRecording',
    title: 'Toggle recording',
    on: 'Pressed',
    callback: () => rpc.commands.toggleManualRecording.execute(),
  },
  {
    id: 'cancelManualRecording',
    title: 'Cancel recording',
    on: 'Pressed',
    callback: () => rpc.commands.cancelManualRecording.execute(),
  },
  {
    id: 'toggleVadRecording',
    title: 'Toggle voice activated recording',
    on: 'Pressed',
    callback: () => rpc.commands.toggleVadRecording.execute(),
  },
  ...(window.__TAURI_INTERNALS__
    ? ([
        {
          id: 'toggleCpalRecording',
          title: 'Toggle CPAL recording',
          on: 'Pressed',
          callback: () => rpc.commands.toggleCpalRecording.execute(),
        },
        {
          id: 'cancelCpalRecording',
          title: 'Cancel CPAL recording',
          on: 'Pressed',
          callback: () => rpc.commands.cancelCpalRecording.execute(),
        },
      ] as const satisfies SatisfiedCommand[])
    : []),
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
  (acc, command) => {
    acc[command.id] = command.callback;
    return acc;
  },
  {} as CommandCallbacks,
);
```

#### 3. Update `/apps/whispering/src/lib/query/index.ts`

Add commands to the RPC namespace:

```typescript
import { commands } from './commands';

export const rpc = {
  clipboard,
  commands,  // Add this line
  cpalRecorder,
  device,
  // ... rest of exports
};
```

#### 4. Update Upload Recording Integration

The `uploadRecording` mutation in `recordings.ts` should also use the shared `processRecordingPipeline` function:

```typescript
uploadRecording: defineMutation({
  mutationKey: ['recordings', 'uploadRecording'] as const,
  resultMutationFn: async ({ file }: { file: File }) => {
    // Validate file type
    if (!file.type.startsWith('audio/')) {
      return DbServiceErr({
        message: 'Invalid file type. Please upload an audio file.',
        context: { fileType: file.type },
        cause: undefined,
      });
    }

    // Create recording from uploaded file
    const arrayBuffer = await file.arrayBuffer();
    const audioBlob = new Blob([arrayBuffer], { type: file.type });
    
    // Use the shared pipeline
    const toastId = nanoid();
    await rpc.commands.processRecordingPipeline.execute({
      blob: audioBlob,
      toastId,
      completionTitle: '📁 File uploaded successfully!',
      completionDescription: file.name,
    });

    return Ok({ filename: file.name });
  },
}),
```

## Benefits of This Refactoring

1. **Consistency**: All commands follow the RPC pattern with `.execute()` calls
2. **Testability**: Commands can be tested independently as mutations
3. **Reusability**: The `processRecordingPipeline` function can be used by any command that produces audio
4. **Type Safety**: Commands return proper `Result<T, E>` types
5. **Discoverability**: All commands are available through `rpc.commands.*`
6. **Maintainability**: Command logic is centralized in the query layer
7. **Integration**: Upload recording can use the same pipeline as other recording methods

## Migration Steps

1. Create the new `query/commands.ts` file with all command implementations
2. Move `saveRecordingAndTranscribeTransform` to `processRecordingPipeline` in the new file
3. Update each command to use the mutation pattern with proper error handling
4. Update `commands.ts` to use RPC calls
5. Update `query/index.ts` to export commands
6. Update `uploadRecording` to use the shared pipeline
7. Test all commands to ensure they work correctly
8. Update documentation

## Considerations

- **Error Handling**: Each command should return `WhisperingError` for consistency with the toast system
- **State Management**: Commands that check recorder state should use `.fetch()` for performance
- **Conditional Exports**: CPAL commands should only be included when running in Tauri
- **Toast IDs**: Generate unique toast IDs for each command execution
- **Sound Effects**: Maintain the current sound effect triggers

## Future Enhancements

- Add command metadata (descriptions, icons) to the query layer
- Create a command palette UI that reads from `rpc.commands`
- Add command analytics/telemetry
- Support command composition (e.g., "record and email")