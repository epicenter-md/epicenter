# Error Handling with wellcrafted trySync and tryAsync

## Use trySync/tryAsync Instead of try-catch for Graceful Error Handling

When handling errors that can be gracefully recovered from, use `trySync` (for synchronous code) or `tryAsync` (for asynchronous code) from wellcrafted instead of traditional try-catch blocks. This provides better type safety and explicit error handling.

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
