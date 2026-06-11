# Inline Service Factory Functions

**Status:** Planning
**Created:** 2026-01-04
**Type:** Refactor

## Problem

We have 22 service files that use unnecessary factory function wrappers when the factory is only called once at export time. This adds unnecessary indirection without providing any benefit.

### Current Pattern (Unnecessary Complexity)

```typescript
export function createSomethingService() {
  return {
    method1() { ... },
    method2() { ... }
  };
}

export const SomethingServiceLive = createSomethingService();
export type SomethingService = ReturnType<typeof createSomethingService>;
```

**Problems:**
- Factory function serves no purpose (called exactly once)
- Extra type complexity with `ReturnType<typeof ...>`
- More code to read and maintain
- Not consistent with simpler patterns like `workspace-storage.ts` in epicenter

### Desired Pattern (Simple and Direct)

```typescript
export const SomethingServiceLive = {
  method1() { ... },
  method2() { ... }
};

export type SomethingService = typeof SomethingServiceLive;
```

**Benefits:**
- No unnecessary factory wrapper
- Simpler type exports
- Consistent with epicenter's workspace-storage pattern
- Less code to maintain

## Scope

### Files to Refactor (22 total)

**Transcription Services (15 files):**
- `src/lib/services/isomorphic/transcription/cloud/openai.ts`
- `src/lib/services/isomorphic/transcription/cloud/groq.ts`
- `src/lib/services/isomorphic/transcription/cloud/deepgram.ts`
- `src/lib/services/isomorphic/transcription/cloud/elevenlabs.ts`
- `src/lib/services/isomorphic/transcription/cloud/mistral.ts`
- `src/lib/services/isomorphic/transcription/local/whispercpp.ts`
- `src/lib/services/isomorphic/transcription/local/parakeet.ts`
- `src/lib/services/isomorphic/transcription/local/moonshine.ts`
- `src/lib/services/isomorphic/transcription/self-hosted/speaches.ts`

**Desktop Services (7 files):**
- `src/lib/services/desktop/global-shortcut-manager.ts`
- `src/lib/services/desktop/tray.ts`
- `src/lib/services/desktop/autostart.ts`
- `src/lib/services/desktop/permissions.ts`
- `src/lib/services/desktop/fs.ts`
- `src/lib/services/desktop/ffmpeg.ts`
- `src/lib/services/desktop/command.ts`

**Completion Services:**
- `src/lib/services/isomorphic/completion/google.ts`
- `src/lib/services/isomorphic/completion/groq.ts`

**Recorder Services:**
- `src/lib/services/isomorphic/recorder/navigator.ts`
- `src/lib/services/desktop/recorder/cpal.ts`
- `src/lib/services/desktop/recorder/ffmpeg.ts`

**Other:**
- `src/lib/services/isomorphic/local-shortcut-manager.ts`

### Files to NOT Change

**Platform-specific services with build-time injection:**
- `src/lib/services/isomorphic/text/index.ts`
- `src/lib/services/isomorphic/sound/index.ts`
- `src/lib/services/isomorphic/notifications/index.ts`
- `src/lib/services/isomorphic/os/index.ts`
- `src/lib/services/isomorphic/http/index.ts`
- `src/lib/services/isomorphic/analytics/index.ts`
- `src/lib/services/isomorphic/download/index.ts`
- `src/lib/services/isomorphic/db/index.ts`

These use `window.__TAURI_INTERNALS__` to choose implementations at build time, so the factory pattern is legitimate.

## Refactoring Steps

For each of the 22 files:

### 1. Remove the Factory Function

**Before:**
```typescript
export function createOpenaiTranscriptionService() {
  return {
    async transcribe(blob, options) {
      // implementation
    }
  };
}
```

**After:**
```typescript
// Remove the function wrapper entirely
```

### 2. Inline the Service Object

**Before:**
```typescript
export const OpenaiTranscriptionServiceLive = createOpenaiTranscriptionService();
```

**After:**
```typescript
export const OpenaiTranscriptionServiceLive = {
  async transcribe(blob, options) {
    // implementation (moved from factory return)
  }
};
```

### 3. Simplify the Type Export

**Before:**
```typescript
export type OpenaiTranscriptionService = ReturnType<typeof createOpenaiTranscriptionService>;
```

**After:**
```typescript
export type OpenaiTranscriptionService = typeof OpenaiTranscriptionServiceLive;
```

### 4. Handle Closures/State (if any)

Some services might have variables defined in the factory function scope. These should be moved to module-level constants or the service object itself:

**Before:**
```typescript
function createSomethingService() {
  const cache = new Map(); // closure variable
  return {
    method() { cache.get(...) }
  };
}
```

**After (Option A - Module-level):**
```typescript
const cache = new Map(); // module-level

export const SomethingServiceLive = {
  method() { cache.get(...) }
};
```

**After (Option B - Service property):**
```typescript
export const SomethingServiceLive = {
  _cache: new Map(), // private by convention
  method() { this._cache.get(...) }
};
```

## Example Refactor

### Before: `src/lib/services/desktop/autostart.ts`

```typescript
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { tryAsync } from 'wellcrafted/result';

export function createAutostartServiceDesktop() {
  return {
    isEnabled: () => tryAsync({
      try: () => isEnabled(),
      catch: (error) => AutostartServiceErr({ message: 'Failed to check autostart', cause: error })
    }),
    enable: () => tryAsync({
      try: () => enable(),
      catch: (error) => AutostartServiceErr({ message: 'Failed to enable autostart', cause: error })
    }),
    disable: () => tryAsync({
      try: () => disable(),
      catch: (error) => AutostartServiceErr({ message: 'Failed to disable autostart', cause: error })
    })
  };
}

export type AutostartService = ReturnType<typeof createAutostartServiceDesktop>;
export const AutostartServiceLive = createAutostartServiceDesktop();
```

### After: `src/lib/services/desktop/autostart.ts`

```typescript
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { tryAsync } from 'wellcrafted/result';

export const AutostartServiceLive = {
  isEnabled: () => tryAsync({
    try: () => isEnabled(),
    catch: (error) => AutostartServiceErr({ message: 'Failed to check autostart', cause: error })
  }),
  enable: () => tryAsync({
    try: () => enable(),
    catch: (error) => AutostartServiceErr({ message: 'Failed to enable autostart', cause: error })
  }),
  disable: () => tryAsync({
    try: () => disable(),
    catch: (error) => AutostartServiceErr({ message: 'Failed to disable autostart', cause: error })
  })
};

export type AutostartService = typeof AutostartServiceLive;
```

## Git Strategy

### Option 1: Direct on Main (Recommended for this refactor)

**Pros:**
- Simple, straightforward workflow
- No worktree complexity
- Clean linear history
- Fast to execute

**Workflow:**
```bash
# From main branch
git checkout main
git pull origin main

# Make all changes
# ... refactor 22 files ...

# Commit
git add apps/whispering/src/lib/services
git commit -m "refactor(services): inline factory functions for single-use services

Simplified 22 service files by removing unnecessary factory function
wrappers that were only called once at export time.

- Removed createXxxService() functions
- Inlined service object definitions
- Simplified type exports from ReturnType<typeof createXxx> to typeof XxxLive
- No functional changes, purely structural simplification

Pattern change:
Before: export const XLive = createX()
After: export const XLive = { methods... }

Affected services:
- 15 transcription services (cloud/local/self-hosted)
- 7 desktop services
- 2 completion services
- 3 recorder services
- 1 local shortcut manager"

# Push
git push origin main
```

**When to use:** Low-risk refactors that don't change functionality, purely structural

### Option 2: Worktree (For more exploratory work)

**Pros:**
- Can test changes in isolation
- Easy to abandon if issues arise
- Can work on multiple things simultaneously

**Workflow:**
```bash
# Create worktree
git worktree add .conductor/inline-factories -b refactor/inline-service-factories

# Work in the worktree
cd .conductor/inline-factories
# ... make changes ...
git add .
git commit -m "refactor: inline service factories"
git push origin refactor/inline-service-factories

# Create PR
gh pr create --title "refactor(services): inline factory functions" --body "..."

# Merge when ready
gh pr merge --merge

# Cleanup
cd ../..
git worktree remove .conductor/inline-factories
git branch -d refactor/inline-service-factories
```

**When to use:** Exploratory work, risky changes, work you might abandon

### Recommendation

For this refactor, **use Option 1 (direct on main)**:
- It's a low-risk structural change
- No functionality changes
- Easy to verify (imports stay the same)
- Fast to execute
- Clean history

## Testing Strategy

### Before Starting

1. Ensure app builds: `bun run build`
2. Ensure tests pass: `bun test` (if you have tests)
3. Note the current app state

### During Refactoring

For each file:
1. Make the change
2. Verify TypeScript compilation: `bun run typecheck` (or let your editor show errors)
3. Ensure no import errors

### After Completing All Changes

1. Build the app: `bun run build`
2. Run the app: `bun run dev`
3. Test key functionality:
   - Transcription services (try different providers)
   - Desktop services (tray, shortcuts, autostart)
   - Completion services (transformations)
4. Check for any runtime errors in console

### Verification Checklist

- [ ] All 22 files refactored
- [ ] TypeScript compiles without errors
- [ ] App builds successfully
- [ ] App runs without runtime errors
- [ ] Transcription still works
- [ ] Shortcuts still work
- [ ] Transformations still work
- [ ] No broken imports

## Execution Plan

### Phase 1: Preparation (5 minutes)

```bash
cd /Users/braden/Code/whispering
git checkout main
git pull origin main
bun run typecheck  # Verify starting state
```

### Phase 2: Refactoring (30-45 minutes)

Process files in groups to maintain focus:

**Group 1: Desktop Services (simplest, good warmup)**
1. `desktop/autostart.ts`
2. `desktop/command.ts`
3. `desktop/ffmpeg.ts`
4. `desktop/fs.ts`
5. `desktop/permissions.ts`
6. `desktop/tray.ts`
7. `desktop/global-shortcut-manager.ts`

**Group 2: Transcription Services (largest group)**
1. Cloud: openai, groq, deepgram, elevenlabs, mistral
2. Local: whispercpp, parakeet, moonshine
3. Self-hosted: speaches

**Group 3: Completion Services**
1. `completion/google.ts`
2. `completion/groq.ts`

**Group 4: Recorder Services**
1. `recorder/navigator.ts`
2. `desktop/recorder/cpal.ts`
3. `desktop/recorder/ffmpeg.ts`

**Group 5: Other**
1. `isomorphic/local-shortcut-manager.ts`

### Phase 3: Verification (10 minutes)

```bash
bun run typecheck
bun run build
bun run dev
# Test app functionality
```

### Phase 4: Commit and Push (5 minutes)

```bash
git add apps/whispering/src/lib/services
git status  # Review changes
git commit -m "refactor(services): inline factory functions for single-use services"
git push origin main
```

## Rollback Plan

If issues arise after pushing:

```bash
# Find the commit hash
git log --oneline -5

# Revert the commit
git revert <commit-hash>
git push origin main
```

Or if not pushed yet:

```bash
# Reset to previous commit
git reset --hard HEAD~1
```

## Success Criteria

- [ ] All 22 files refactored following the pattern
- [ ] No TypeScript errors
- [ ] App builds and runs successfully
- [ ] All functionality works as before
- [ ] Clean commit message following conventional commits
- [ ] Changes pushed to main

## Future Considerations

After this refactor, we'll have two patterns in services:

1. **Direct object export** (22 files after this refactor + toast.ts)
2. **Platform-specific with build-time injection** (8 files with `window.__TAURI_INTERNALS__`)

This is the correct distinction. Factories are only needed when there's actual runtime dependency injection happening.

## Notes

- This refactor is purely structural. No functionality changes
- All imports remain the same (same export names)
- Type safety is maintained
- Can be done incrementally (file by file) or all at once
