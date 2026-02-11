---
name: error-handling
description: Error handling patterns using wellcrafted trySync and tryAsync. Use when writing error handling code, using try-catch blocks, or working with Result types and graceful error recovery.
metadata:
  author: epicenter
  version: '1.1'
---

# Error Handling with wellcrafted trySync and tryAsync

## Use trySync/tryAsync Instead of try-catch for Graceful Error Handling

When handling errors that can be gracefully recovered from, use `trySync` (for synchronous code) or `tryAsync` (for asynchronous code) from wellcrafted instead of traditional try-catch blocks. This provides better type safety and explicit error handling.

> **Related Skills**: See `services-layer` skill for `createTaggedError` patterns. See `query-layer` skill for error transformation to `WhisperingError`.

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
		// For unrecoverable errors, return Err
		return ServiceErr({
			message: 'Operation failed',
			cause: error,
		});
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
7. **CRITICAL: Wrap destructured errors with Err()** - When you destructure `{ data, error }` from tryAsync/trySync, the `error` variable is the raw error value, NOT wrapped in `Err`. You must wrap it before returning:

```typescript
// WRONG - error is just the raw TaggedError, not a Result
const { data, error } = await tryAsync({...});
if (error) return error; // TYPE ERROR: Returns TaggedError, not Result

// CORRECT - wrap with Err() to return a proper Result
const { data, error } = await tryAsync({...});
if (error) return Err(error); // Returns Err<TaggedError>
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
const { data, error } = await tryAsync({
	try: () => criticalOperation(),
	catch: (error) =>
		ServiceErr({
			message: 'Critical operation failed',
			cause: error,
		}),
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
// ✅ GOOD: Wrap only the risky operation
const { data: stream, error: streamError } = await tryAsync({
	try: () => navigator.mediaDevices.getUserMedia({ audio: true }),
	catch: (error) =>
		DeviceStreamServiceErr({
			message: `Microphone access failed: ${extractErrorMessage(error)}`,
		}),
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
	catch: (error) => GenericErr({ message: 'Something failed' }), // Too vague!
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
		RecorderServiceErr({
			message: `Failed to initialize recorder: ${extractErrorMessage(error)}`,
		}),
});
```

### Real-World Examples from the Codebase

**Minimal wrap with immediate return:**

```typescript
// From device-stream.ts
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
			DeviceStreamServiceErr({
				message: `Unable to connect to microphone. ${extractErrorMessage(error)}`,
			}),
	});
}
```

**Multiple minimal wraps with immediate returns:**

```typescript
// From navigator.ts
startRecording: async (params, { sendStatus }) => {
  if (activeRecording) {
    return RecorderServiceErr({ message: 'Already recording.' });
  }

  // First try block - get stream
  const { data: streamResult, error: acquireStreamError } =
    await getRecordingStream({ selectedDeviceId, sendStatus });
  if (acquireStreamError) return Err(acquireStreamError);

  const { stream, deviceOutcome } = streamResult;

  // Second try block - create recorder
  const { data: mediaRecorder, error: recorderError } = trySync({
    try: () => new MediaRecorder(stream, { bitsPerSecond: bitrate }),
    catch: (error) => RecorderServiceErr({
      message: `Failed to initialize recorder. ${extractErrorMessage(error)}`,
    }),
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
