# Wellcrafted Result Library Migration Plan

**Timestamp**: 2025-01-29T15:00:00  
**Feature**: Migrate Whispering codebase from `mapErr` to `catch` parameter with smart return type narrowing

## Overview

Migrate the entire Whispering codebase to use the improved `trySync` and `tryAsync` functions with:
1. **Parameter change**: `mapErr` → `catch`
2. **Smart return type narrowing**: Automatic type narrowing based on catch function return type
3. **Improved developer experience**: Better hover experience and type safety

## Analysis Summary

**Current Usage Patterns:**
- 29 files using `trySync`/`tryAsync` 
- All using the old `mapErr` parameter pattern
- Consistent error handling with `DbServiceErr`, `VadRecorderServiceErr`, etc.
- Heavy usage in services layer (db, transcription, completion, etc.)

**Example Current Pattern:**
```typescript
return tryAsync({
    try: () => db.recordings.count(),
    mapErr: (error) =>
        DbServiceErr({
            message: 'Unable to get recording count',
            context: { maxRecordingCount },
            cause: error,
        }),
});
```

**Target Pattern:**
```typescript
return tryAsync({
    try: () => db.recordings.count(),
    catch: (error) =>
        Err(DbServiceError({
            message: 'Unable to get recording count', 
            context: { maxRecordingCount },
            cause: error,
        })),
});
```

## Migration Strategy

### Phase 1: Update Result Library
- [ ] Copy improved `result.ts` from wellcrafted to Whispering
- [ ] Update `trySync` and `tryAsync` with overloads for smart return type narrowing
- [ ] Maintain backward compatibility during transition

### Phase 2: Systematic Migration
- [ ] **Services Layer** (29 files): Core business logic layer
- [ ] **Query Layer**: If any Result usage exists  
- [ ] **Component Layer**: If any Result usage exists
- [ ] **Test Files**: Update any test utilities

### Phase 3: Cleanup & Verification  
- [ ] Remove old `mapErr` parameter support
- [ ] Run full type checking
- [ ] Test critical paths
- [ ] Update documentation

## Detailed Migration Tasks

### Files to Update (Priority Order)

**High Priority - Core Services:**
1. `/lib/services/db/dexie.ts` - Database operations (many usages)
2. `/lib/services/vad-recorder.ts` - VAD recording logic
3. `/lib/services/transcription/*.ts` - Transcription services
4. `/lib/services/completion/*.ts` - AI completion services
5. `/lib/services/recorder/*.ts` - Recording services

**Medium Priority - Platform Services:**
6. `/lib/services/notifications/*.ts` - Notification handling
7. `/lib/services/text/*.ts` - Text handling services  
8. `/lib/services/sound/*.ts` - Sound services
9. `/lib/services/http/*.ts` - HTTP services
10. `/lib/services/download/*.ts` - Download services

**Lower Priority - Utility Services:**
11. `/lib/services/ffmpeg/*.ts` - FFmpeg integration
12. `/lib/services/analytics/*.ts` - Analytics services
13. `/lib/services/permissions/*.ts` - Permission services
14. `/lib/services/device-stream.ts` - Device stream handling
15. `/lib/services/global-shortcut-manager.ts` - Shortcut management

### Migration Steps Per File

For each file:

1. **Update imports** (if needed):
   ```typescript
   // Before
   import { tryAsync, trySync } from 'wellcrafted/result';
   
   // After (same, but now supports overloads)
   import { tryAsync, trySync } from 'wellcrafted/result';
   ```

2. **Replace `mapErr` with `catch`**:
   ```typescript
   // Before
   mapErr: (error) => DbServiceErr({...})
   
   // After  
   catch: (error) => Err(DbServiceError({...}))
   ```

3. **Leverage return type narrowing** (where applicable):
   ```typescript
   // For functions that always recover (rare in Whispering)
   catch: (error) => Ok(fallbackValue) // Returns Ok<T>
   
   // For functions that propagate errors (most common)  
   catch: (error) => Err(serviceError) // Returns Result<T, E>
   ```

## Type Safety Benefits

### Before Migration:
```typescript
// Always returns Result<T, E> regardless of catch behavior
const result = tryAsync({
    try: () => operation(),
    mapErr: () => Err(error) // Always error propagation
});
// result: Result<T, ServiceError>
// Must check: if (isOk(result)) { ... }
```

### After Migration:
```typescript
// Return type narrows based on catch function
const result = tryAsync({
    try: () => operation(), 
    catch: (error) => Ok(fallbackValue) // Always recovery
});
// result: Ok<T> - No error checking needed!

const result2 = tryAsync({
    try: () => operation(),
    catch: (error) => Err(serviceError) // Error propagation  
});
// result2: Result<T, ServiceError> - Error checking required
```

## Risk Assessment

**Low Risk Migration:**
- Backward compatible parameter names during transition
- No runtime behavior changes - pure type-level improvements  
- Incremental migration possible
- Easy rollback if issues arise

**Potential Issues:**
- Large number of files to update (29 files)
- Need consistent patterns across codebase
- TypeScript compilation errors during transition

**Mitigation:**
- Automated search/replace for consistent patterns
- Thorough testing of critical paths
- Maintain old parameter support during transition

## Success Criteria

- [ ] All 29 files successfully migrated
- [ ] TypeScript compilation passes without errors
- [ ] Critical user flows still work (recording, transcription, playback)
- [ ] No runtime errors in development testing
- [ ] Improved developer experience with return type narrowing

## Timeline

**Estimated Duration**: 2-3 hours
- Phase 1 (Library Update): 30 minutes  
- Phase 2 (File Migration): 90-120 minutes
- Phase 3 (Testing & Cleanup): 30-60 minutes

## Next Steps

1. Update the Result library in Whispering with new overloads
2. Start with high-priority files (database, VAD recorder)
3. Use systematic search/replace for consistent migration
4. Test incrementally as files are migrated
5. Final verification and cleanup