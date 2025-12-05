# Migration to createTaggedError Factory Pattern

## Overview
Migrate from using `TaggedError<"ErrorName">` type declarations to using the `createTaggedError` factory function from wellcrafted library. This provides cleaner syntax and automatic error construction.

## Migration Pattern

### Before:
```typescript
type VadRecorderServiceError = TaggedError<'VadRecorderServiceError'>;

// Usage:
return Err({
  name: 'VadRecorderServiceError',
  message: 'Error message',
  context: { ... },
  cause: error
} as VadRecorderServiceError);
```

### After:
```typescript
const { VadRecorderServiceError, VadRecorderServiceErr } = createTaggedError(
  'VadRecorderServiceError',
);
type VadRecorderServiceError = ReturnType<typeof VadRecorderServiceError>;

// Usage - Option 1 (plain error):
const error = VadRecorderServiceError({
  message: 'Error message',
  context: { ... },
  cause: error
});

// Usage - Option 2 (wrapped in Err):
return VadRecorderServiceErr({
  message: 'Error message', 
  context: { ... },
  cause: error
});
```

## Benefits
1. **No manual name field**: The factory automatically sets the error name
2. **Two convenient functions**: 
   - `SomeError` - creates plain error object
   - `SomeErr` - creates Err-wrapped error (replaces "Error" suffix with "Err")
3. **Type safety**: Still fully typed with TypeScript
4. **Cleaner code**: Less boilerplate, more readable

## Migration Tasks

- [ ] Find all `TaggedError<"...">` type declarations
- [ ] Replace with createTaggedError factory pattern
- [ ] Update all error construction sites to use factory functions
- [ ] Remove manual `name` field specifications
- [ ] Remove unnecessary type assertions
- [ ] Test that all errors still work correctly

## Files to Migrate

### Services Layer (17 files)
- [x] vad-recorder.ts - `VadRecorderServiceError` (updated to use factory correctly)
- [x] manual-recorder.ts - `ManualRecorderServiceError`
- [x] cpal-recorder.ts - `CpalRecorderServiceError`
- [x] device-stream.ts - `DeviceStreamServiceError`
- [x] global-shortcut-manager.ts - `InvalidAcceleratorError`, `GlobalShortcutServiceError`
- [x] local-shortcut-manager.ts - `LocalShortcutServiceError`
- [x] tray.ts - `SetTrayIconServiceErrorProperties`
- [x] clipboard/types.ts - `ClipboardServiceError`
- [x] completion/types.ts - `CompletionServiceError`
- [x] db/dexie.ts - `DbServiceError`
- [x] download/types.ts - `DownloadServiceError`
- [x] http/types.ts - `ConnectionError`, `ResponseError`, `ParseError`
- [x] notifications/types.ts - `NotificationServiceError`
- [x] os/types.ts - `OsServiceError`
- [x] sound/types.ts - `PlaySoundServiceError`

### Query Layer (1 file)
- [x] transformer.ts - `TransformServiceError`

### Core (1 file)
- [ ] result.ts - `WhisperingWarning`, `WhisperingError` (special case - extends TaggedError)

### Utils (1 file)
- [x] createPersistedState.svelte.ts - `ParseJsonError`

Total: 20 error types across 19 files