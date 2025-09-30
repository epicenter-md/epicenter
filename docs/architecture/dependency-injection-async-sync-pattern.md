# Dependency Injection for Async Dependencies in Synchronous Functions

## The Problem: Mixing Async and Sync Worlds

When building the Whispering transcription app, I encountered an interesting architectural challenge with the `hasLocalTranscriptionCompatibilityIssue()` function. This function needs to determine if there's a compatibility issue between the current recording settings and local transcription models. The catch? One of its key decisions depends on whether FFmpeg is installed - an inherently asynchronous check that requires an RPC call.

The function is called from two different contexts:
1. **Svelte component templates** - Where the function needs to be synchronous for reactive declarations
2. **Async service functions** - Where we can await async operations

## The Initial Coupling Problem

Originally, the function tried to be self-contained:

```typescript
// Original approach - mixed concerns
function hasLocalTranscriptionCompatibilityIssue(): boolean {
  // Check recording settings (sync)
  if (!isUsingLocalTranscription()) return false;
  if (settings.value['recording.method'] === 'cpal' && isUsing16kHz()) {
    return false;
  }

  // But wait... we also need to know if FFmpeg is installed!
  // This requires an async RPC call - can't do this in a sync function
  // So we had to check FFmpeg OUTSIDE and use && !data.ffmpegInstalled everywhere
  return true;
}
```

This led to awkward usage patterns:

```svelte
<!-- Had to couple the FFmpeg check at every call site -->
{#if hasLocalTranscriptionCompatibilityIssue() && !data.ffmpegInstalled}
  <Alert>...</Alert>
{/if}
```

## Why Not Check FFmpeg Inside the Function?

A natural question arises: why doesn't `hasLocalTranscriptionCompatibilityIssue()` just check if FFmpeg is installed internally?

The answer is simple but fundamental: **Svelte template conditionals require synchronous functions**.

Checking FFmpeg installation status requires an async RPC call:

```typescript
// This is inherently async - requires network/IPC communication
const { data: ffmpegInstalled } = await rpc.ffmpeg.checkFfmpegInstalled.ensure();
```

But Svelte template conditionals require synchronous functions:

```svelte
<!-- This is impossible - can't await in template conditionals -->
{#if await hasLocalTranscriptionCompatibilityIssue()}
  <!-- This syntax doesn't exist! -->
{/if}

<!-- Templates need synchronous evaluation -->
{#if hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled: data.ffmpegInstalled })}
  <!-- This works! -->
{/if}
```

### The Solution Through Inversion of Control

By accepting FFmpeg status as a parameter, we invert control - callers fetch the async data in their appropriate context:

1. **Data loaders** fetch it during page load: `+page.server.ts` or `+page.ts`
2. **Async functions** fetch it in their function body before calling our sync function

Then they pass it to this pure synchronous function. This way:
- The function remains synchronous and usable in templates
- The async fetching happens in the appropriate context
- The function becomes pure and testable
- We maintain single responsibility - the function only handles compatibility logic, not I/O

## The Solution: Dependency Injection

The solution was simple but powerful - make `isFFmpegInstalled` an explicit dependency:

```typescript
export function hasLocalTranscriptionCompatibilityIssue({
  isFFmpegInstalled,
}: {
  isFFmpegInstalled: boolean;
}): boolean {
  // FFmpeg solves compatibility issues by converting audio formats
  if (isFFmpegInstalled) return false;

  // Rest of the synchronous logic
  if (!isUsingLocalTranscription()) return false;
  if (settings.value['recording.method'] === 'cpal' && isUsing16kHz()) {
    return false;
  }

  return true;
}
```

This inverts control - the caller is responsible for fetching FFmpeg status asynchronously, then passing it to our synchronous function.

## Two Contexts, One Interface

This dependency injection pattern elegantly handles both usage contexts:

### Context 1: Svelte Components with Data Loaders

```typescript
// In +page.server.ts - load FFmpeg status once during page load
export async function load() {
  // Fetch async data in the appropriate context (data loader)
  const { data: ffmpegInstalled } = await rpc.ffmpeg.checkFfmpegInstalled.ensure();
  return {
    ffmpegInstalled,
    // ... other data
  };
}
```

```svelte
<!-- In component - use preloaded data synchronously -->
{#if hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled: data.ffmpegInstalled })}
  <Alert>...</Alert>
{/if}
```

### Context 2: Async Service Functions

```typescript
async function transcribeWithLocalModel(audio: Blob) {
  // Fetch async data in the appropriate context (async function body)
  // Same RPC call, different context
  const { data: isFFmpegInstalled } = await rpc.ffmpeg.checkFfmpegInstalled.ensure();

  if (hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled })) {
    return WhisperingErr({
      title: 'Recording Settings Incompatible',
      // ...
    });
  }

  // Proceed with transcription...
}
```

## Why This Is True Dependency Injection

This pattern demonstrates classic dependency injection principles:

1. **Inversion of Control**: The function doesn't control *how* to get FFmpeg status - that's determined by the caller
2. **Explicit Dependencies**: The function signature clearly states what it needs to operate
3. **Implementation Agnostic**: The function doesn't care if FFmpeg status comes from a data loader, an RPC call, or even a mock in tests
4. **Single Responsibility**: The function focuses solely on compatibility logic, not on fetching external state

## The Power of Deferred Async Resolution

The key insight here is that we **defer** the async operation to the appropriate context:

- **In Svelte components**: The async work happens in the data loader before the component renders
- **In service functions**: The async work happens in the parent async function body

Both contexts eventually call the same RPC endpoint, but they do so at the appropriate time for their execution model. The synchronous compatibility function doesn't need to know or care about these implementation details.

## Benefits of This Approach

### 1. Maintains Synchronous Nature
The function remains purely synchronous, making it usable in Svelte's reactive declarations and template expressions where async operations aren't allowed.

### 2. Eliminates Redundant Checks
Previously, every call site had to remember to also check `!data.ffmpegInstalled`. Now the logic is centralized within the function.

### 3. Better Testability
Testing becomes trivial - just pass different values for `isFFmpegInstalled`:

```typescript
test('no compatibility issue when FFmpeg is installed', () => {
  expect(hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled: true }))
    .toBe(false);
});

test('has compatibility issue without FFmpeg and non-16kHz recording', () => {
  expect(hasLocalTranscriptionCompatibilityIssue({ isFFmpegInstalled: false }))
    .toBe(true);
});
```

### 4. More Accurate Semantics
The function name now accurately reflects what it does. When FFmpeg is installed, there truly *isn't* a compatibility issue because FFmpeg can convert the audio format.

### 5. Framework-Agnostic Logic
The core logic doesn't depend on Svelte, RPC, or any specific async implementation. It's pure business logic.

## The Broader Pattern

This pattern is particularly useful when:
- You have synchronous logic that depends on async data
- The async data can be fetched differently in different contexts
- You want to keep functions pure and testable
- You're working with frameworks like Svelte that have distinct sync/async boundaries
- You need to use functions in template conditionals or reactive declarations

## Conclusion

By treating async dependencies as explicit parameters rather than internal implementation details, we create more flexible, testable, and maintainable code. The function becomes a pure transformation of its inputs, while the calling context handles the messy details of acquiring those inputs.

This is dependency injection at its finest - not the heavy enterprise framework kind, but the simple, elegant pattern of making dependencies explicit and letting the caller provide them. It's a perfect example of how inverting control can solve the impedance mismatch between async I/O operations and synchronous business logic.