# Migrate Whispering Try/Catch to Wellcrafted Patterns

## Context

The `apps/whispering` codebase has 10 try/catch blocks across 9 files. The project is migrating to `wellcrafted/result` patterns (`trySync`, `tryAsync`, `Ok`, `Err`) for linear control flow. This spec covers migrating the 5 best candidates and annotating the 5 that should stay as-is.

## Wave 1: Good Candidates (Commit) ✅

These 5 try/catch blocks map cleanly to `tryAsync`/`trySync`. Migrate them and commit.

### 1.1 `transformer.ts`: Regex Compilation (`trySync`) ✅

**File**: `apps/whispering/src/lib/query/isomorphic/transformer.ts` (lines 165-171)

**Current**:
```typescript
if (useRegex) {
    try {
        const regex = new RegExp(findText, 'g');
        return Ok(input.replace(regex, replaceText));
    } catch (error) {
        return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
    }
}
```

**Target**:
```typescript
if (useRegex) {
    return trySync({
        try: () => {
            const regex = new RegExp(findText, 'g');
            return input.replace(regex, replaceText);
        },
        catch: (error) => `Invalid regex pattern: ${extractErrorMessage(error)}`,
    });
}
```

**Import change**: Add `trySync` to the existing `wellcrafted/result` import. Remove `Ok` from import if no longer used elsewhere in the file (check first).

---

### 1.2 `check-for-updates.ts`: Update Check (`tryAsync`) ✅

**File**: `apps/whispering/src/routes/(app)/_layout-utils/check-for-updates.ts` (lines 9-29)

**Current**:
```typescript
export async function checkForUpdates() {
    try {
        const update = await (shouldUseMockUpdates() ? mockCheck() : check());
        if (update) {
            await rpc.notify.info({...});
        }
    } catch (error) {
        rpc.notify.error({
            title: 'Failed to check for updates',
            description: extractErrorMessage(error),
        });
    }
}
```

**Target**:
```typescript
export async function checkForUpdates() {
    const { error } = await tryAsync({
        try: async () => {
            const update = await (shouldUseMockUpdates() ? mockCheck() : check());
            if (update) {
                await rpc.notify.info({...});
            }
        },
        catch: (error) => error,
    });
    if (error) {
        rpc.notify.error({
            title: 'Failed to check for updates',
            description: extractErrorMessage(error),
        });
    }
}
```

**Import change**: Add `tryAsync` from `wellcrafted/result`.

**Note**: The catch handler returns the raw error since the notification formatting happens outside. This is a top-level fire-and-forget function: it doesn't return a Result, it just notifies.

---

### 1.3 `elevenlabs.ts`: Transcription API (`tryAsync`) ✅

**File**: `apps/whispering/src/lib/services/isomorphic/transcription/cloud/elevenlabs.ts` (lines 53-91)

**Current**:
```typescript
try {
    const client = new ElevenLabsClient({ apiKey: options.apiKey });
    // ...validation...
    const transcription = await client.speechToText.convert({...});
    return Ok(transcription.text.trim());
} catch (error) {
    return WhisperingErr({
        title: '🔧 Transcription Failed',
        description: '...',
        action: { type: 'more-details', error },
    });
}
```

**Target**:
```typescript
const client = new ElevenLabsClient({ apiKey: options.apiKey });

// Check file size (no try needed: pure logic)
const blobSizeInMb = audioBlob.size / (1024 * 1024);
const MAX_FILE_SIZE_MB = 1000;
if (blobSizeInMb > MAX_FILE_SIZE_MB) {
    return WhisperingErr({
        title: '📁 File Size Too Large',
        description: `Your audio file (${blobSizeInMb.toFixed(1)}MB) exceeds the ${MAX_FILE_SIZE_MB}MB limit. Please use a smaller file or compress the audio.`,
    });
}

return tryAsync({
    try: async () => {
        const transcription = await client.speechToText.convert({
            file: audioBlob,
            model_id: options.modelName,
            language_code: options.outputLanguage !== 'auto' ? options.outputLanguage : undefined,
            tag_audio_events: false,
            diarize: true,
        });
        return transcription.text.trim();
    },
    catch: (error) =>
        WhisperingError({
            title: '🔧 Transcription Failed',
            description: 'Unable to complete the transcription using ElevenLabs. This may be due to a service issue or unsupported audio format. Please try again.',
            action: { type: 'more-details', error },
        }),
});
```

**Import change**: Add `tryAsync` from `wellcrafted/result`. Replace `Ok` with `tryAsync`. Import `WhisperingError` (not `WhisperingErr`) for the catch handler since `tryAsync` wraps in `Err` automatically.

**Key improvement**: The file size validation is pulled out of the try block: it's pure logic that doesn't throw. Only the actual API call is wrapped in `tryAsync`.

---

### 1.4 `+page.svelte`: Drag-Drop Setup (`tryAsync`) ✅

**File**: `apps/whispering/src/routes/(app)/+page.svelte` (lines 88-152)

**Current**:
```typescript
onMount(async () => {
    if (!window.__TAURI_INTERNALS__) return;
    try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const { extname } = await import('@tauri-apps/api/path');
        // ...setup drag-drop listener...
    } catch (error) {
        rpc.notify.error({
            title: '❌ Failed to set up drag drop listener',
            description: `${error}`,
        });
    }
});
```

**Target**:
```typescript
onMount(async () => {
    if (!window.__TAURI_INTERNALS__) return;
    const { error } = await tryAsync({
        try: async () => {
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            const { extname } = await import('@tauri-apps/api/path');
            // ...setup drag-drop listener (same inner logic)...
        },
        catch: (error) => error,
    });
    if (error) {
        rpc.notify.error({
            title: '❌ Failed to set up drag drop listener',
            description: extractErrorMessage(error),
        });
    }
});
```

**Import change**: Add `tryAsync` from `wellcrafted/result`. Add `extractErrorMessage` from `wellcrafted/error` (fixes the existing bug of using raw `` `${error}` `` template string instead of `extractErrorMessage`).

---

### 1.5 `UpdateDialog.svelte`: Download Handler (`tryAsync`) ✅

**File**: `apps/whispering/src/lib/components/UpdateDialog.svelte` (lines 90-128)

**Current**:
```typescript
async function handleDownloadAndInstall() {
    if (!updateDialog.update) return;
    updateDialog.setError(null);

    try {
        let downloaded = 0;
        let contentLength = 0;
        await updateDialog.update.downloadAndInstall((event) => {
            // ...progress tracking...
        });
    } catch (err) {
        updateDialog.setError(extractErrorMessage(err));
        rpc.notify.error({
            title: 'Failed to install update',
            description: extractErrorMessage(err),
        });
    }
}
```

**Target**:
```typescript
async function handleDownloadAndInstall() {
    if (!updateDialog.update) return;
    updateDialog.setError(null);

    let downloaded = 0;
    let contentLength = 0;

    const { error } = await tryAsync({
        try: () =>
            updateDialog.update!.downloadAndInstall((event) => {
                // ...progress tracking (same inner logic)...
            }),
        catch: (error) => extractErrorMessage(error),
    });
    if (error) {
        updateDialog.setError(error);
        rpc.notify.error({
            title: 'Failed to install update',
            description: error,
        });
    }
}
```

**Import change**: Add `tryAsync` from `wellcrafted/result`.

---

## Wave 2: Annotate Questionable Cases (No Commit)

These 5 try/catch blocks should stay as-is. Add a `// wellcrafted:skip: <reason>` comment above each to document the decision.

### 2.1 `web.ts`: DB Migration Recovery (lines 49-149)

**Comment**: `// wellcrafted:skip: complex Dexie recovery UI with nested fault-tolerant table dumping`

Reason: The nested try/catch structure serves a purpose: inner catches provide fault tolerance for individual table dumps during migration failure recovery. Restructuring would reduce resilience.

### 2.2 `web.ts`: DB Deletion Handler (lines 115-142)

**Comment**: `// wellcrafted:skip: Dexie lifecycle method, tightly coupled to this.delete()`

Reason: Coupled to Dexie's class-based API. Minimal benefit from migration.

### 2.3 `createJobQueue.ts`: Queue Error Isolation (lines 13-19)

**Comment**: `// wellcrafted:skip: intentional error isolation in queue loop with finally cleanup`

Reason: The try/catch/finally pattern is idiomatic for queue processors. The `finally` block shifts the queue regardless of success/failure. `tryAsync` would add ceremony without improving clarity.

### 2.4 `ConfirmationDialog.svelte`: Promise with Loading State (lines 157-164)

**Comment**: `// wellcrafted:skip: empty catch intentionally keeps dialog open, finally resets loading state`

Reason: The empty catch is semantically meaningful (keep dialog open on error). The finally block manages loading state. This is UI lifecycle management, not error handling.

### 2.5 `recordings/+page.svelte`: Date Format Fallback (lines 71-75)

**Comment**: `// wellcrafted:skip: trivial 3-line fallback, trySync adds ceremony for no clarity gain`

Reason: The catch returns the original value as a fallback. It's a simple, readable pattern that doesn't benefit from abstraction.

---

## Verification

1. Run type check: `bun run --filter @epicenter/whispering typecheck`
2. Run tests if any exist for these files: `bun test --filter whispering`
3. Verify the app builds: `bun run --filter @epicenter/whispering build`
4. Manually spot-check: search for remaining raw `try {` in `apps/whispering` to confirm only the annotated skip cases remain

## Implementation Notes

> **Deviation from spec**: The spec's target code for `check-for-updates.ts`, `+page.svelte`, `UpdateDialog.svelte`, and `transformer.ts` showed `catch` handlers returning raw values (e.g., `catch: (error) => error`). In wellcrafted@0.33.0, `trySync`/`tryAsync` catch handlers must return `Ok<T>` or `Err<E>`: they do NOT auto-wrap. All catch handlers were updated to wrap returns in `Err(...)`. For `elevenlabs.ts`, `WhisperingErr(...)` already returns `Err<WhisperingError>`, so no change was needed.
