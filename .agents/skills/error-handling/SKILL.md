---
name: error-handling
description: Error handling patterns using wellcrafted trySync and tryAsync. Use when writing or reviewing try-catch blocks, refactoring try-catch to linear control flow, working with Result types, or returning HTTP error responses from route handlers.
metadata:
  author: epicenter
  version: '1.2'
---

# Error Handling with wellcrafted trySync and tryAsync

## When to Apply This Skill

Use this pattern when you need to:

- Replace recoverable `try-catch` blocks with `trySync` or `tryAsync`.
- Handle fallback success paths via `Ok(...)` and propagate failures with `Err(...)`.
- Wrap caught exceptions as `cause` for typed domain error constructors.
- Refactor nested error branches into immediate-return linear control flow.
- Convert handler failures into HTTP status responses with explicit guards.

## Use trySync/tryAsync Instead of try-catch for Graceful Error Handling

When handling errors that can be gracefully recovered from, use `trySync` (for synchronous code) or `tryAsync` (for asynchronous code) from wellcrafted instead of traditional try-catch blocks. This provides better type safety and explicit error handling.

> **Related Skills**: See `services-layer` skill for `defineErrors` patterns and service architecture. See `query-layer` skill for error transformation to `WhisperingError`.

### The Pattern

```typescript
import { trySync, tryAsync, Ok, Err } from 'wellcrafted/result';

// SYNCHRONOUS: Use trySync for sync operations
const { data, error } = trySync({
	try: () => {
		const parsed = JSON.parse(jsonString);
		return validateData(parsed); // Automatically wrapped in Ok()
	},
	catch: (e) => {
		// Gracefully handle parsing/validation errors
		console.log('Using default configuration');
		return Ok(defaultConfig); // Return Ok with fallback
	},
});

// ASYNCHRONOUS: Use tryAsync for async operations
await tryAsync({
	try: async () => {
		const child = new Child(session.pid);
		await child.kill();
		console.log(`Process killed successfully`);
	},
	catch: (e) => {
		// Gracefully handle the error
		console.log(`Process was already terminated`);
		return Ok(undefined); // Return Ok(undefined) for void functions
	},
});

// Both support the same catch patterns
const syncResult = trySync({
	try: () => riskyOperation(),
	catch: (error) => {
		// For recoverable errors, return Ok with fallback value
		return Ok('fallback-value');
		// For unrecoverable errors, pass the raw cause — the constructor handles extractErrorMessage
		return CompletionError.ConnectionFailed({ cause: error });
	},
});
```

### Key Rules

1. **Choose the right function** - Use `trySync` for synchronous code, `tryAsync` for asynchronous code
2. **Always await tryAsync** - Unlike try-catch, tryAsync returns a Promise and must be awaited
3. **trySync returns immediately** - No await needed for synchronous operations
4. **Match return types** - If the try block returns `T`, the catch should return `Ok<T>` for graceful handling
5. **Use Ok(undefined) for void** - When the function returns void, use `Ok(undefined)` in the catch
6. **Return Err for propagation** - Use custom error constructors that return `Err` when you want to propagate the error
7. **Transform cause in the constructor, not the call site** - When wrapping a caught error, pass the raw error as `cause: unknown` and let the `defineErrors` constructor call `extractErrorMessage(cause)` inside its message template. Don't call `extractErrorMessage` at the call site. This centralizes message extraction where the message is composed:

```typescript
// ✅ GOOD: cause: error at call site, extractErrorMessage in constructor
catch: (error) => CompletionError.ConnectionFailed({ cause: error })

// ❌ BAD: extractErrorMessage at call site, string passed to constructor
catch: (error) => CompletionError.ConnectionFailed({ underlyingError: extractErrorMessage(error) })
```

8. **CRITICAL: Wrap destructured errors with Err()** - When you destructure `{ data, error }` from tryAsync/trySync, the `error` variable is the raw error value, NOT wrapped in `Err`. You must wrap it before returning:

```typescript
// WRONG - error is just the raw error value, not a Result
const { data, error } = await tryAsync({...});
if (error) return error; // TYPE ERROR: Returns raw error, not Result

// CORRECT - wrap with Err() to return a proper Result
const { data, error } = await tryAsync({...});
if (error) return Err(error); // Returns Err<CustomError>
```

This is different from returning the entire result object:

```typescript
// This is also correct - userResult is already a Result type
const userResult = await tryAsync({...});
if (userResult.error) return userResult; // Returns the full Result
```

### Examples

```typescript
// SYNCHRONOUS: JSON parsing with fallback
const { data: config } = trySync({
	try: () => JSON.parse(configString),
	catch: (e) => {
		console.log('Invalid config, using defaults');
		return Ok({ theme: 'dark', autoSave: true });
	},
});

// SYNCHRONOUS: File system check
const { data: exists } = trySync({
	try: () => fs.existsSync(path),
	catch: () => Ok(false), // Assume doesn't exist if check fails
});

// ASYNCHRONOUS: Graceful process termination
await tryAsync({
	try: async () => {
		await process.kill();
	},
	catch: (e) => {
		console.log('Process already dead, continuing...');
		return Ok(undefined);
	},
});

// ASYNCHRONOUS: File operations with fallback
const { data: content } = await tryAsync({
	try: () => readFile(path),
	catch: (e) => {
		console.log('File not found, using default');
		return Ok('default content');
	},
});

// EITHER: Error propagation (works with both)
// Pass the raw caught error as cause — the defineErrors constructor calls extractErrorMessage
const { data, error } = await tryAsync({
	try: () => criticalOperation(),
	catch: (error) =>
		CompletionError.ConnectionFailed({ cause: error }),
});
if (error) return Err(error);
```

### When to Use trySync vs tryAsync vs try-catch

- **Use trySync when**:
  - Working with synchronous operations (JSON parsing, validation, calculations)
  - You need immediate Result types without promises
  - Handling errors in synchronous utility functions
  - Working with filesystem sync operations

- **Use tryAsync when**:
  - Working with async/await operations
  - Making network requests or database calls
  - Reading/writing files asynchronously
  - Any operation that returns a Promise

- **Use traditional try-catch when**:
  - In module-level initialization code where you can't await
  - For simple fire-and-forget operations
  - When you're outside of a function context
  - When integrating with code that expects thrown exceptions

## Wrapping Patterns: Minimal vs Extended

### The Minimal Wrapping Principle

**Wrap only the specific operation that can fail.** This captures the error boundary precisely and makes code easier to reason about.

```typescript
// ✅ GOOD: Wrap only the risky operation, pass raw cause to constructor
const { data: stream, error: streamError } = await tryAsync({
	try: () => navigator.mediaDevices.getUserMedia({ audio: true }),
	catch: (error) =>
		DeviceStreamError.PermissionDenied({ cause: error }),
});

if (streamError) return Err(streamError);

// Continue with non-throwing operations
const mediaRecorder = new MediaRecorder(stream);
mediaRecorder.start();
```

```typescript
// ❌ BAD: Wrapping too much code
const { data, error } = await tryAsync({
	try: async () => {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const mediaRecorder = new MediaRecorder(stream);
		mediaRecorder.start();
		await someOtherAsyncCall();
		return processResults();
	},
	catch: (error) => Err(error), // Too vague! No specific error type
});
```

### The Immediate Return Pattern

**Return errors immediately after checking.** This creates clear control flow and prevents error nesting.

```typescript
// ✅ GOOD: Check and return immediately
const { data: devices, error: enumerateError } = await enumerateDevices();
if (enumerateError) return Err(enumerateError);

const { data: stream, error: streamError } = await getStreamForDevice(
	devices[0],
);
if (streamError) return Err(streamError);

// Happy path continues cleanly
return Ok(stream);
```

```typescript
// ❌ BAD: Nested error handling
const { data: devices, error: enumerateError } = await enumerateDevices();
if (!enumerateError) {
	const { data: stream, error: streamError } = await getStreamForDevice(
		devices[0],
	);
	if (!streamError) {
		return Ok(stream);
	} else {
		return Err(streamError);
	}
} else {
	return Err(enumerateError);
}
```

### When to Extend the Try Block

Sometimes it makes sense to include multiple operations in a single try block:

1. **Atomic operations** - When operations must succeed or fail together
2. **Same error type** - When all operations produce the same error category
3. **Cleanup logic** - When you need to clean up on any failure

```typescript
// Extended block is appropriate here - all operations are part of "starting recording"
const { data: mediaRecorder, error: recorderError } = trySync({
	try: () => {
		const recorder = new MediaRecorder(stream, { bitsPerSecond: bitrate });
		recorder.addEventListener('dataavailable', handleData);
		recorder.start(TIMESLICE_MS);
		return recorder;
	},
	catch: (error) =>
		RecorderError.InitFailed({ cause: error }),
});
```

### Real-World Examples from the Codebase

**Minimal wrap with immediate return:**

```typescript
// From device-stream.ts — cause: error at call site, extractErrorMessage in constructor
async function getStreamForDeviceIdentifier(
	deviceIdentifier: DeviceIdentifier,
) {
	return tryAsync({
		try: async () => {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { ...constraints, deviceId: { exact: deviceIdentifier } },
			});
			return stream;
		},
		catch: (error) =>
			DeviceStreamError.DeviceConnectionFailed({ deviceId: deviceIdentifier, cause: error }),
	});
}
```

**Multiple minimal wraps with immediate returns:**

```typescript
// From navigator.ts
startRecording: async (params, { sendStatus }) => {
  if (activeRecording) {
    return RecorderError.AlreadyRecording();
  }

  // First try block - get stream
  const { data: streamResult, error: acquireStreamError } =
    await getRecordingStream({ selectedDeviceId, sendStatus });
  if (acquireStreamError) return Err(acquireStreamError);

  const { stream, deviceOutcome } = streamResult;

  // Second try block - create recorder
  const { data: mediaRecorder, error: recorderError } = trySync({
    try: () => new MediaRecorder(stream, { bitsPerSecond: bitrate }),
    catch: (error) => RecorderError.InitFailed({ cause: error }),
  });

  if (recorderError) {
    cleanupRecordingStream(stream);  // Cleanup on failure
    return Err(recorderError);
  }

  // Happy path continues...
  mediaRecorder.start(TIMESLICE_MS);
  return Ok(deviceOutcome);
},
```

### Summary: Wrapping Guidelines

| Scenario                                     | Approach                                          |
| -------------------------------------------- | ------------------------------------------------- |
| Single risky operation                       | Wrap just that operation                          |
| Sequential operations                        | Wrap each separately, return immediately on error |
| Atomic operations that must succeed together | Wrap together in one block                        |
| Different error types needed                 | Separate blocks with appropriate error types      |
| Need cleanup on failure                      | Wrap, check error, cleanup if needed, return      |

**The goal**: Each `trySync`/`tryAsync` block should represent a single "unit of failure" with a specific, descriptive error message.

## Using trySync/tryAsync in HTTP Handlers

Not all error handling involves propagating `Result` types up a service chain. In HTTP route handlers (Elysia, Express, SvelteKit, etc.), you often want to convert errors directly into HTTP status responses. The same trySync/tryAsync patterns apply; you just return a status response instead of `Err(...)`.

### The Pattern: trySync → early return with status

```typescript
// From packages/server/src/ai/plugin.ts — Elysia route handler
async ({ body, headers, status }) => {
	// Validation guards use return status() directly
	if (!isSupportedProvider(provider)) {
		return status('Bad Request', `Unsupported provider: ${provider}`);
	}

	// Wrap only the call that can throw — chat() may fail on bad adapter config.
	// toServerSentEventsResponse() is pure construction and never throws.
	const { data: stream, error: chatError } = trySync({
		try: () =>
			chat({
				adapter,
				messages,
				abortController,
			}),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (chatError) {
		if (chatError.name === 'AbortError' || abortController.signal.aborted) {
			return status(499, 'Client closed request');
		}
		return status('Bad Gateway', `Provider error: ${chatError.message}`);
	}

	// Happy path — stream is guaranteed non-null after the error check
	return toServerSentEventsResponse(stream, { abortController });
};
```

### Key Differences from Service-Layer Usage

| Service layer                                  | HTTP handler                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `catch: (e) => ServiceErr({ message: '...' })` | `catch: (e) => Err(e instanceof Error ? e : new Error(String(e)))` |
| `if (error) return Err(error)`                 | `if (error) return status(502, error.message)`                     |
| Propagates typed errors up the chain           | Converts errors to HTTP responses immediately                      |
| Caller decides what to do with the error       | Handler IS the final caller                                        |

In HTTP handlers, you're the last stop. There's no caller above you to propagate to; you convert the error into a response and return it. The trySync pattern still gives you linear control flow and surgical error boundaries—you just use `return status(...)` instead of `return Err(...)`.

### Refactoring try-catch to trySync in Handlers

Before (try-catch with throw):

```typescript
try {
	const result = riskyCall();
	return buildResponse(result);
} catch (error) {
	const message = error instanceof Error ? error.message : 'Unknown error';
	throw status(500, message);
}
```

After (trySync with early return):

```typescript
const { data: result, error } = trySync({
	try: () => riskyCall(),
	catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
});

if (error) return status(500, error.message);

return buildResponse(result);
```

The trySync version wraps only the risky call, uses `return` consistently (no `throw` vs `return` mismatch), and keeps the happy path at the bottom of the function.
