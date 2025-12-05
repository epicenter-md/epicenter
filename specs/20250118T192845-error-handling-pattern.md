# Error Handling Pattern for Whispering

## Overview
This document defines the error handling pattern used throughout the Whispering codebase to ensure consistency and avoid redundant error wrapping.

## Architecture Layers

### 1. Service Layer (`lib/services/`)
- Returns domain-specific tagged errors (e.g., `ManualRecorderServiceError`, `CpalRecorderServiceError`)
- These are created using `createTaggedError` from wellcrafted
- Raw errors from APIs or system calls

### 2. Query Layer (`lib/query/`)
- Wraps service errors into `WhisperingError` objects using `WhisperingErr()`
- Adds user-friendly titles and descriptions
- Returns `Result<T, WhisperingError>` from mutations and queries
- **Important**: All query functions should consistently wrap errors before returning

### 3. Command Layer (`lib/query/commands.ts`)
- Receives `WhisperingError` objects from the query layer
- Passes errors directly to `notify.error.execute()` without re-wrapping
- Returns the error as-is for proper type flow

## Correct Pattern

### Service Layer Example
```typescript
// In services/manual-recorder.ts
export function createManualRecorderService() {
    return {
        getRecorderState: (): Result<WhisperingRecordingState, ManualRecorderServiceError> => {
            // Returns tagged error if something goes wrong
            return Ok(activeRecording ? 'RECORDING' : 'IDLE');
        }
    };
}
```

### Query Layer Example
```typescript
// In query/manual-recorder.ts
getRecorderState: defineQuery({
    queryKey: recorderKeys.state,
    resultQueryFn: async () => {
        const { data: recorderState, error: getRecorderStateError } =
            await services.manualRecorder.getRecorderState();
        if (getRecorderStateError) {
            // Wrap service error into WhisperingError
            return WhisperingErr({
                title: '❌ Failed to get recorder state',
                description: getRecorderStateError.message,
                action: { type: 'more-details', error: getRecorderStateError },
            });
        }
        return Ok(recorderState);
    },
    initialData: 'IDLE' as WhisperingRecordingState,
})
```

### Command Layer Example
```typescript
// In query/commands.ts
if (startRecordingError) {
    // Pass WhisperingError directly - no re-wrapping!
    notify.error.execute({ id: toastId, ...startRecordingError });
    return Err(startRecordingError);
}
```

## Anti-Patterns to Avoid

### ❌ Double Wrapping
```typescript
// BAD: Don't wrap an already-wrapped WhisperingError
if (getRecorderStateError) {
    const whisperingError = WhisperingErr({
        title: '❌ Failed to get recorder state',
        description: getRecorderStateError.message,
        action: { type: 'more-details', error: getRecorderStateError },
    });
    notify.error.execute({ id: nanoid(), ...whisperingError.error });
    return whisperingError;
}
```

### ❌ Inconsistent Query Layer
```typescript
// BAD: Query layer should wrap errors, not return raw service errors
getRecorderState: defineQuery({
    queryKey: recorderKeys.state,
    resultQueryFn: () => services.manualRecorder.getRecorderState(), // Missing error wrapping!
    initialData: 'IDLE' as WhisperingRecordingState,
})
```

## Summary

1. **Service Layer**: Returns tagged errors
2. **Query Layer**: Wraps service errors into WhisperingError
3. **Command Layer**: Uses WhisperingError directly without re-wrapping

This pattern ensures:
- Consistent error handling across the codebase
- No redundant error object creation
- Clear separation of concerns between layers
- User-friendly error messages at the appropriate layer

## Changes Made in This Refactoring

### 1. Fixed `manualRecorder.getRecorderState` query
Updated it to wrap service errors into WhisperingError, matching the pattern used by `cpalRecorder.getRecorderState`.

### 2. Simplified error handling in `toggleManualRecording`
Removed redundant WhisperingError wrapping since the query layer now returns properly wrapped errors.

### 3. Removed unnecessary imports
Cleaned up unused `WhisperingErr` import from commands.ts after the refactoring.

### 4. Maintained consistency
All recorder queries now follow the same error handling pattern, making the codebase more maintainable.