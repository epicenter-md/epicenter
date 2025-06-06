# A Modern Approach to Error Handling in TypeScript

This library provides a robust, Rust-inspired `Result` type and a lightweight, serializable error handling system for TypeScript. It's designed to help you write more predictable, type-safe, and composable code by making error handling an explicit part of your function signatures.

## Core Idea: The Result Type

The core of the library is the `Result<T, E>` type. Instead of throwing exceptions, functions can return a `Result` object that explicitly represents either a success or a failure.

A `Result` is a discriminated union with two possible variants:
- **`Ok<T>`**: Represents a successful outcome, containing a `data` field with the success value of type `T`.
- **`Err<E>`**: Represents a failure outcome, containing an `error` field with the error value of type `E`.

This pattern forces you to acknowledge and handle potential errors at compile time, leading to more resilient applications.

## Quick Start

### Installation
```bash
npm install @epicenterhq/result
```

### Basic Usage
Here's a simple example of a function that returns a `Result`:

```ts
import { Result, Ok, Err, isOk } from "@epicenterhq/result";

// A function that might fail
function divide(numerator: number, denominator: number): Result<number, string> {
  if (denominator === 0) {
    return Err("Cannot divide by zero");
  }
  return Ok(numerator / denominator);
}

// Handling the result
const result = divide(10, 2);

if (isOk(result)) {
  // Within this block, TypeScript knows `result` is of type `Ok<number>`.
  // We can safely access `result.data`.
  console.log(`The result is: ${result.data}`);
} else {
  // Within this block, TypeScript knows `result` is of type `Err<string>`.
  // We can safely access `result.error`.
  console.error(`An error occurred: ${result.error}`);
}
```

## Handling Operation Outcomes

Once you have a `Result`, there are two main patterns for working with it.

### Pattern 1: Using Type Guards (Recommended for Type Safety)

Using the `isOk()` and `isErr()` type guards is the most type-safe way to handle a `Result`. TypeScript's control flow analysis understands these functions and will correctly narrow the type of your `Result` object within `if/else` blocks.

```ts
import { isOk, isErr } from "@epicenterhq/result";

const result = divide(10, 0); // This returns an Err variant

if (isOk(result)) {
  // TypeScript knows `result` is `Ok<number>` here.
  // `result.error` is `null`.
  // `result.data` is `number`.
  const value: number = result.data; // This is safe
  console.log(value);

} else if (isErr(result)) {
  // TypeScript knows `result` is `Err<string>` here.
  // `result.data` is `null`.
  // `result.error` is `string`.
  const error: string = result.error; // This is safe
  console.error(error);
}
```

> **Why is this recommended?** This pattern allows TypeScript to do what it does best. Inside the `isOk` block, `result` is treated as `Ok<T>`, and inside the `isErr` block, it's treated as `Err<E>`. This eliminates the need for type assertions or manual null-checking of `data` and `error` properties, preventing a class of common runtime errors.

### Pattern 2: Destructuring

You can also destructure the `data` and `error` properties directly from the result. This pattern can be visually clean but comes with an important caveat regarding type safety.

```ts
const { data, error } = divide(10, 2);

if (error) {
  // The `error` exists, so we handle it.
  // `error` is of type `string | null`.
  const err: string = error;
  console.error(err);

} else {
  // The `error` is null, so we can use the data.
  // `data` is of type `number | null`.
  const value: number = data; // TypeScript may complain here if strictNullChecks is on
  console.log(value);
}
```

> **The Caveat with Destructuring:** When you destructure, TypeScript analyzes `data` and `error` as separate variables. It often cannot infer the relationship that `data` is non-null *if and only if* `error` is null. As a result, `data` will have the type `T | null` and `error` will have `E | null`, even inside your conditional blocks. This may force you to use non-null assertions (`!`) or perform extra checks, slightly defeating the purpose of a fully type-safe `Result` type.

For maximum type safety and clarity, **we recommend using the `isOk()` and `isErr()` type guards.**

## Wrapping Functions That Throw

What if you're working with a function that throws exceptions, like `JSON.parse` or a network client? This library provides `trySync` and `tryAsync` to safely wrap these operations and convert their outcomes into a `Result`.

### Synchronous Operations with `trySync`

Use `trySync` for synchronous functions that might throw. You provide the operation and a `mapError` function to transform the caught exception into your desired error type.

```ts
import { trySync, Result } from "@epicenterhq/result";

function parseJson(raw: string): Result<object, Error> {
  return trySync({
    try: () => JSON.parse(raw),
    mapError: (err: unknown) => err as Error, // Map the unknown error to a typed Error
  });
}

const result = parseJson('{"key": "value"}'); // Ok<{key: string}>
const failedResult = parseJson('not json'); // Err<SyntaxError>
```

### Asynchronous Operations with `tryAsync`

Use `tryAsync` for functions that return a `Promise`. It handles both rejected promises and synchronous throws within the async function.

```ts
import { tryAsync, Result } from "@epicenterhq/result";

type User = { id: number; name: string };
type NetworkError = { message: string; statusCode?: number };

async function fetchUser(userId: number): Promise<Result<User, NetworkError>> {
  return tryAsync({
    try: async () => {
      const response = await fetch(`https://api.example.com/users/${userId}`);
      if (!response.ok) {
        // You can throw a custom error object
        throw { message: "Request failed", statusCode: response.status };
      }
      return response.json();
    },
    mapError: (err: unknown) => err as NetworkError, // Transform the caught error
  });
}

const userResult = await fetchUser(1);
```

## A Serializable, Type-Safe Error System

This library promotes a pattern for defining errors as plain, serializable objects rather than instances of JavaScript's `Error` class.

### Why Plain Objects for Errors?

1.  **Serialization-First**: Plain objects can be easily serialized to JSON (`JSON.stringify`) and transmitted across boundaries (network APIs, IPC, web workers) without losing information, unlike `Error` classes.
2.  **Type Safety**: Use TypeScript's literal and union types to create a discriminated union of possible errors, allowing `switch` statements to safely narrow down error types.
3.  **Lightweight**: Avoids the overhead of class instantiation and the complexities of `instanceof` checks.
4.  **Structured Context**: Easily enforce that all errors carry structured, machine-readable context.

### The Core Error Types

The library provides two simple helper types in `@epicenterhq/result` to build your error system.

```typescript
// A base for all errors, ensuring they have a consistent shape.
type BaseError = Readonly<{
  name: string;        // The error's unique name (acts as the "tag").
  message: string;     // A human-readable description of the error.
  context: Record<string, unknown>; // Structured, machine-readable context.
  cause?: unknown;     // The original error that caused this one, for debugging.
}>;

// A helper to create a specific, tagged error type.
type TaggedError<T extends string> = BaseError & {
  readonly name: T;
};
```

### Creating Domain-Specific Errors

You can define a set of possible errors for a specific domain, like a file system service:

```typescript
// Define your specific error types
export type FileNotFoundError = TaggedError<"FileNotFoundError">;
export type PermissionDeniedError = TaggedError<"PermissionDeniedError">;
export type DiskFullError = TaggedError<"DiskFullError">;

// Create a union of all possible errors for this domain
export type FileSystemError = FileNotFoundError | PermissionDeniedError | DiskFullError;

// A factory function to create an error
function createFileNotFoundError(path: string): FileNotFoundError {
  return {
    name: "FileNotFoundError",
    message: `The file at path "${path}" was not found.`,
    context: { path },
  };
}
```

Because `name` is a unique literal type for each error, TypeScript can use it to discriminate between them in a `switch` statement:

```ts
function handleError(error: FileSystemError) {
  switch (error.name) {
    case "FileNotFoundError":
      // TypeScript knows `error` is `FileNotFoundError` here.
      console.error(`Path not found: ${error.context.path}`);
      break;
    case "PermissionDeniedError":
      // TypeScript knows `error` is `PermissionDeniedError` here.
      console.error("Permission was denied.");
      break;
    case "DiskFullError":
      // ...
      break;
  }
}
```

### Best Practices for Errors

#### 1. Include Meaningful Context
Always include function inputs and other relevant state in the `context` object. This is invaluable for logging and debugging.

```typescript
function createDbError(
  message: string,
  query: string,
  params: unknown[],
  cause: unknown
): DbError {
  return {
    name: "DbError",
    message,
    context: {
      query,
      params,
      timestamp: new Date().toISOString(),
    },
    cause,
  };
}
```

#### 2. Handle Errors at the Right Level
Handle or transform errors where you can add more context or make a recovery decision.

```ts
async function initializeApp(): Promise<Result<App, FsError | ValidationError>> {
  const configResult = await readConfig("./config.json");

  // Propagate the file system error directly if config read fails
  if (isErr(configResult)) {
    return configResult;
  }

  // If config is read, but is invalid, return a *different* kind of error
  const validationResult = validateConfig(configResult.data);
  if (isErr(validationResult)) {
    return validationResult;
  }

  return Ok(new App(validationResult.data));
}
```

## API Reference

A summary of the most important exports from the library.

### Types
- **`Result<T, E>`**: The core union type, representing `Ok<T> | Err<E>`.
- **`Ok<T>`**: Represents a success. Contains `{ data: T; error: null; }`.
- **`Err<E>`**: Represents a failure. Contains `{ data: null; error: E; }`.
- **`BaseError` / `TaggedError<T>`**: Helpers for creating a structured error system.

### Functions
- **`Ok(data)`**: Creates a success `Result`.
- **`Err(error)`**: Creates a failure `Result`.
- **`isOk(result)`**: Type guard. Returns `true` if the result is an `Ok` variant.
- **`isErr(result)`**: Type guard. Returns `true` if the result is an `Err` variant.
- **`trySync({ try, mapError })`**: Wraps a synchronous function that may throw.
- **`tryAsync({ try, mapError })`**: Wraps an asynchronous function that may throw or reject.
- **`unwrapIfResult(value)`**: Unwraps a `Result`, returning data on `Ok` or throwing on `Err`.
- **`isResult(value)`**: Type guard. Returns `true` if a value has the shape of a `Result`.


```ts
// Example of a service with a generic error type

// type ServiceError = ...

type Service = {
	query1: (input: Input1) => Result<Output1, ServiceError>;
	query2: (input: Input2) => Result<Output2, ServiceError>;

	mutation1: (input: Input1) => Result<Output1, ServiceError>;
	mutation2: (input: Input2) => Result<Output2, ServiceError>;
};


// Example of a service with a specific error type

type MediaServiceError = string;

type MediaRecorderService = {
	enumerateRecordingDevices: (input: void) => Result<MediaDeviceInfo[], MediaServiceError>;
	initRecordingSession: (input: { bitRate: number }) => Result<void, MediaServiceError>;
	closeRecordingSession: (input: void) => Result<void, MediaServiceError>;
	startRecording: (input: { recordingId: string }) => Result<void, MediaServiceError>;
	stopRecording: (input: void) => Result<Blob, MediaServiceError>;
	cancelRecording: (input: void) => Result<void, MediaServiceError>;
};


type DBError = { code: number; message: string; constraint?: string; };

type DatabaseService = {
	// Queries
	getById: (input: { table: string; id: number }) => Result<Record<string, unknown>, DBError>;

	// Mutations
	insert: (input: ({ table: string; data: Record<string,unknown>) => Result< number, DBError>;
	update: (input: { table: string; id: number; data: Record<string, unknown> }) => Result<void, DBError>;
	delete: (input: { table: string; id: number }) => Result<void, DBError>;
};


// Example of a service with a specific error type
type TRPCError = ...

type TRPCService = {
	getUserById: (input: { id: number }) => Result<User, TRPCError>;
	createUser: (input: User) => Result<void, TRPCError>;
	updateUser: (input: User) => Result<void, TRPCError>;
	deleteUser: (input: { id: number }) => Result<void, TRPCError>;
};

const createTRPCService = (): TRPCService => {
	// Internal service state
	const db = new Map<number, User>()

	return {
		getUserById: async ({ id }: { id: number }) => {
			return db.get(id)
		},
		createUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(user)
			try {
				db.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
		updateUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(user)
			try {
				db.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
		deleteUser: async (id: number, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: number) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(id)
			try {
				db.delete(id)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		}
	}
}


// Example of a service with a specific error type

type ServiceError = ...

const createService = (): Service => {
	// Internal service state
	const db = new Map<number, User>()

	return {
		getUserById: async ({ id }: { id: number }) => {
			return db.get(id)
		},
		createUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(user)
			try {
				db.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
		updateUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(user)
			try {
				db.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
		deleteUser: async (id: number, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: number) => void;
				onSuccess: () => void;
				onError: (error: TRPCError) => void;
				onSettled: () => void;
			}
		) => {
			onMutate(id)
			try {
				db.delete(id)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		}
	}
}


type Service = {
	getUserById: (input: { id: number }) => Result<User, ServiceError>;
	createUser: (input: User) => Result<void, ServiceError>;
	updateUser: (input: User) => Result<void, ServiceError>;
	deleteUser: (input: { id: number }) => Result<void, ServiceError>;
};


// 1. Define the service-wide error
type ServiceError = ...

// 2. Define the service
type Service = {
	// 3. Define the server's query functions, which are pure and just take input and return output or a ServiceError
	query1: (input: Input1) => Result<Output1, ServiceError>;
	query2: (input: Input2) => Result<Output2, ServiceError>;

	// 4. Define the server's mutation functions, which have side effects and take input. They don't return output. They all return void. Instead, they take in callback functions and run them against the input, output, void, or ServiceError throughout the lifetime of the mutation
	mutation1: (input: Input1) => Result<Output1, ServiceError>;
	mutation2: (input: Input2) => Result<Output2, ServiceError>;
};

// 5. Implement the service
const createService = (): Service => {
	// Internal service state
	const internalState = ...

	return {
		query1: async (input: Input1) => {
			try {
				const output = await internalState.query1(input)
				return Ok(output)
			} catch (error) {
				return Err(error)
			}
		},
		mutation1: async (input: Input1, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: Input1) => void;
				onSuccess: (output: Output1) => void;
				onError: (error: ServiceError) => void;
				onSettled: () => void;
      }
		) => {
			onMutate(input)
			try {
				mutateInternalState(input)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
	}
}

## Error Handling

This library includes a lightweight error handling system designed as a drop-in replacement for JavaScript's native `Error` class, with enhanced type safety and serialization capabilities.

### Why This Approach?

Unlike traditional class-based error systems, this library uses plain objects and types for several key reasons:

1. **Serialization-First**: Errors can be easily serialized to JSON and transmitted across boundaries (network, IPC, workers)
2. **Type Safety**: Full TypeScript support with tagged union types for error categorization
3. **Lightweight**: No class instantiation overhead, just plain objects
4. **Structured Context**: Built-in support for contextual information and error chaining

### Core Error Types

```typescript
import { type BaseError, type TaggedError } from "@epicenterhq/result";

// Base error structure - all errors extend this
type BaseError = Readonly<{
  name: string;        // Error type identifier (the "tag")
  message: string;     // Human-readable description
  context: Record<string, unknown>; // Contextual data (inputs, state, etc.)
  cause: unknown;      // Original error that caused this one
}>;

// Tagged error type for domain-specific errors
// The "name" property acts as a tag that allows TypeScript to discriminate between error types
type TaggedError<T extends string> = BaseError & {
  readonly name: T;
};
```

### Creating Domain-Specific Errors

Define typed errors for your specific domains using the tagged union pattern:

```typescript
// File system errors
export type FsError = TaggedError<"FsError">;

// Database errors
export type DbError = TaggedError<"DbError">;

// Validation errors
export type ValidationError = TaggedError<"ValidationError">;

// Network errors
export type NetworkError = TaggedError<"NetworkError">;

// TypeScript can now discriminate between these types based on the "name" tag
function handleError(error: FsError | DbError | ValidationError) {
  switch (error.name) {
    case "FsError":
      // TypeScript knows this is FsError
      console.log("File system error:", error.context);
      break;
    case "DbError":
      // TypeScript knows this is DbError
      console.log("Database error:", error.context);
      break;
    case "ValidationError":
      // TypeScript knows this is ValidationError
      console.log("Validation error:", error.context);
      break;
  }
}
```

### Error Creation Patterns

#### Basic Error Creation

```typescript
import { extractErrorMessage } from "@epicenterhq/result";

function createFsError(message: string, context: Record<string, unknown>, cause?: unknown): FsError {
  return {
    name: "FsError", // This is the tag that identifies the error type
    message,
    context,
    cause: cause ?? null,
  };
}

// Usage
const error: FsError = createFsError(
  "Failed to read file",
  { path: "/invalid/path", encoding: "utf-8" },
  originalError
);
```

#### With tryAsync for Automatic Error Mapping

```typescript
import { tryAsync, type Result } from "@epicenterhq/result";

export async function readFileContent(path: string): Promise<Result<string, FsError>> {
  return await tryAsync({
    try: () => fs.readFile(path, "utf-8"),
    mapErr: (error): FsError => ({
      name: "FsError",
      message: `Failed to read file content: ${extractErrorMessage(error)}`,
      context: { path },
      cause: error,
    }),
  });
}
```

#### Error Chaining and Propagation

```typescript
// Lower-level function
async function readConfig(path: string): Promise<Result<Config, FsError>> {
  return await tryAsync({
    try: () => fs.readFile(path, "utf-8").then(JSON.parse),
    mapErr: (error): FsError => ({
      name: "FsError",
      message: `Failed to read config: ${extractErrorMessage(error)}`,
      context: { path },
      cause: error,
    }),
  });
}

// Higher-level function that chains errors
async function initializeApp(): Promise<Result<App, ValidationError | FsError>> {
  const configResult = await readConfig("./config.json");
  if (isErr(configResult)) {
    // Propagate the FsError as-is, or transform it
    return configResult;
  }

  // Validate the config
  const validationResult = validateConfig(configResult.data);
  if (isErr(validationResult)) {
    return validationResult;
  }

  return Ok(new App(validationResult.data));
}
```

#### Error Recovery and Fallbacks

```typescript
async function readFileWithFallback(
  primaryPath: string,
  fallbackPath: string
): Promise<Result<string, FsError>> {
  const primaryResult = await readFileContent(primaryPath);
  if (isOk(primaryResult)) {
    return primaryResult;
  }

  // Try fallback, but preserve original error context
  const fallbackResult = await readFileContent(fallbackPath);
  if (isOk(fallbackResult)) {
    return fallbackResult;
  }

  // Combine both errors in context
  return Err({
    name: "FsError",
    message: "Failed to read from both primary and fallback paths",
    context: {
      primaryPath,
      fallbackPath,
      primaryError: primaryResult.error,
      fallbackError: fallbackResult.error,
    },
    cause: primaryResult.error,
  });
}
```

### Best Practices

#### 1. Include Meaningful Context

Always include the function inputs and relevant state in the error context:

```typescript
async function updateUser(id: number, data: UserData): Promise<Result<User, DbError>> {
  return await tryAsync({
    try: () => database.updateUser(id, data),
    mapError: (error): DbError => ({
      name: "DbError",
      message: `Failed to update user: ${extractErrorMessage(error)}`,
      context: { 
        userId: id, 
        updateData: data,
        timestamp: new Date().toISOString(),
      },
      cause: error,
    }),
  });
}
```

#### 2. Use Appropriate Error Types

Choose specific error types that make sense for your domain:

```typescript
// Good: Specific error types
type AuthError = TaggedError<"AuthError">;
type RateLimitError = TaggedError<"RateLimitError">;
type ValidationError = TaggedError<"ValidationError">;

// Less ideal: Generic error type
type ServiceError = TaggedError<"ServiceError">;
```

#### 3. Handle Errors at the Right Level

```typescript
// Handle errors where you can meaningfully recover
async function saveDocument(doc: Document): Promise<Result<void, ValidationError | StorageError>> {
  // Validate first
  const validation = validateDocument(doc);
  if (isErr(validation)) {
    return validation; // Let caller handle validation errors
  }

  // Try to save
  const saveResult = await storage.save(validation.data);
  if (isErr(saveResult)) {
    // Maybe we can retry or use a different storage method
    const retryResult = await storage.saveToBackup(validation.data);
    if (isOk(retryResult)) {
      return Ok(undefined);
    }
    
    // If all recovery attempts fail, propagate the error
    return Err({
      name: "StorageError",
      message: "Failed to save document after retry attempts",
      context: {
        documentId: doc.id,
        primaryError: saveResult.error,
        retryError: retryResult.error,
      },
      cause: saveResult.error,
    });
  }

  return Ok(undefined);
}
```

#### 4. Error Serialization

Since errors are plain objects, they serialize naturally:

```typescript
// Serialize error for transmission
const errorJson = JSON.stringify(error);

// Send over network, save to file, etc.
await fetch("/api/errors", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: errorJson,
});

// Deserialize on the other side
const receivedError: FsError = JSON.parse(errorJson);
```

### Migration from Native Errors

Replace native `Error` usage:

```typescript
// Before
function oldFunction() {
  if (condition) {
    throw new Error("Something went wrong");
  }
}

// After
function newFunction(): Result<void, ValidationError> {
  if (condition) {
    return Err({
      name: "ValidationError",
      message: "Something went wrong",
      context: { condition, timestamp: Date.now() },
      cause: null,
    });
  }
  return Ok(undefined);
}
```

### Integration with Result Types

The error handling system is designed to work seamlessly with the Result type system:

```typescript
// Function that might fail
async function processData(input: unknown): Promise<Result<ProcessedData, ValidationError | ProcessingError>> {
  // Validate input
  const validation = validateInput(input);
  if (isErr(validation)) return validation;

  // Process the validated data
  const processing = await processValidData(validation.data);
  if (isErr(processing)) return processing;

  return Ok(processing.data);
}

// Usage
const result = await processData(userInput);
if (isErr(result)) {
  // Handle different error types
  switch (result.error.name) {
    case "ValidationError":
      console.log("Invalid input:", result.error.context);
      break;
    case "ProcessingError":
      console.log("Processing failed:", result.error.context);
      break;
  }
} else {
  // Use the processed data
  console.log("Success:", result.data);
}
```

This error handling approach provides a robust, type-safe, and serializable foundation for error management in TypeScript applications.


## HTTP Server

```typescript
// 1. Define the service-wide error
type HTTPError = ...

// 2. Define the service
type MyServerService = {
	// 3. Define the server's query functions, which are pure and just take input and return output or a ServiceError
	getUserById: (input: { id: number }) => Result<User, HTTPError>;

	// 4. Define the server's mutation functions, which have side effects and take input. They don't return output. They all return void. Instead, they take in callback functions and run them against the input, output, void, or ServiceError throughout the lifetime of the mutation
	createUser: (input: User) => Result<void, HTTPError>;
};

// 5. Implement the service
const createService = (): MyServerService => {
	// Internal service state
	const internalState = new Map<number, User>()

	return {
		getUserById: async ({ id }: { id: number }) => {
			try {
				const output = await internalState.get(id)
				return Ok(output)
			} catch (error) {
				return Err(error)
			}
		},
		createUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: HTTPError) => void;
				onSettled: () => void;
      }
		) => {
			onMutate(user)
			try {
				// Mutate the internal state
				internalState.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
	}
}
```

## TRPC Server

```typescript
// 1. Define the service-wide error
type TRPCError = ...

// 2. Define the service
type MyTRPCService = {
	// 3. Define the server's query functions, which are pure and just take input and return output or a ServiceError
	getUserById: (input: { id: number }) => Result<User, TRPCError>;

	// 4. Define the server's mutation functions, which have side effects and take input. They don't return output. They all return void. Instead, they take in callback functions and run them against the input, output, void, or ServiceError throughout the lifetime of the mutation
	createUser: (input: User) => Result<void, TRPCError>;
};

// 5. Implement the service
const createService = (): MyTRPCService => {
	// Internal service state
	const internalState = new Map<number, User>()

	return {
		getUserById: async ({ id }: { id: number }) => {
			try {
				const output = await internalState.get(id)
				return Ok(output)
			} catch (error) {
				return Err(error)
			}
		},
		createUser: async (user: User, { onMutate, onSuccess, onError, onSettled }:
			{
				onMutate: (data: User) => void;
				onSuccess: () => void;
				onError: (error: HTTPError) => void;
				onSettled: () => void;
      }
		) => {
			onMutate(user)
			try {
				// Mutate the internal state
				internalState.set(user.id, user)
				onSuccess()
			} catch (error) {
				onError(error)
			} finally {
				onSettled()
			}
		},
	}
}
```