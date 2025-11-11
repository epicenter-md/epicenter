# Fix Recording ID Type to be Non-Nullable

## Problem
The `recordingId` parameter in `processRecordingPipeline` is currently typed as `string | null`, but it should be just `string` because:

1. In `recorder.stopRecording` (line 159-165), there's a guard that returns an error if `recordingId` is null
2. After this guard, `recordingId` is guaranteed to be `string`, but TypeScript doesn't narrow the type
3. This causes unnecessary null handling in `processRecordingPipeline`

## Root Cause
In `apps/whispering/src/lib/query/recorder.ts`:
- `currentRecordingId` is typed as `string | null` (line 28)
- After checking for null and early returning (lines 159-165), TypeScript doesn't narrow the type
- The return type at line 168 is `Ok({ blob, recordingId })` where `recordingId` has type `string | null`

## Solution
Use a type assertion after the guard check to tell TypeScript that `recordingId` is definitely `string`:

```typescript
// After the guard check at line 159-165
const definiteRecordingId: string = recordingId; // recordingId is checked above

// Return with the properly typed value
return Ok({ blob, recordingId: definiteRecordingId });
```

This is safe because we've already validated that `recordingId` is not null.

## Changes Required

### 1. Fix `recorder.ts` stopRecording type
- [ ] Update `stopRecording` mutation to use type assertion after null check
- [ ] This ensures the returned `recordingId` is typed as `string`

### 2. Update `processRecordingPipeline` parameter type
- [ ] Change `recordingId?: string | null` to `recordingId?: string`
- [ ] Update the fallback logic to use `recordingId ?? nanoid()`

## Files to Modify
1. `apps/whispering/src/lib/query/recorder.ts` - Fix return type
2. `apps/whispering/src/lib/query/commands.ts` - Update parameter type

## Expected Outcome
- `processRecordingPipeline` receives `recordingId` as `string | undefined` instead of `string | null | undefined`
- Type system correctly reflects that after the guard check, recordingId is always a string
- No null checks needed in `processRecordingPipeline` since undefined is handled by the fallback

## Review

### Changes Made

1. **apps/whispering/src/lib/query/recorder.ts (line 167-170)**
   - Added type assertion after the null guard check
   - The linter simplified this to just return `recordingId` directly
   - TypeScript now correctly infers that `recordingId` is `string` (not `string | null`) after the guard

2. **apps/whispering/src/lib/query/commands.ts (line 437)**
   - Changed parameter type from `recordingId?: string | null` to `recordingId?: string`
   - Kept the fallback logic `recordingId ?? nanoid()` to handle undefined case
   - This matches the actual return type from `recorder.stopRecording`

### Outcome

The recording ID pipeline now has proper type safety:
- Manual recording: provides `recordingId` as `string` from `recorder.stopRecording`
- VAD recording: omits `recordingId`, which is generated via `nanoid()` fallback
- File upload: omits `recordingId`, which is generated via `nanoid()` fallback

All paths work correctly with type checking, and there's no need for null handling since:
- `recorder.stopRecording` guards against null and returns `string`
- `processRecordingPipeline` accepts `string | undefined` and uses nullish coalescing for the undefined case
