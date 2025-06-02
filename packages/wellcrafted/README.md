# Lightweight Result & Error Handling Library

A TypeScript library providing Rust-inspired Result types and a lightweight error handling system designed for serialization across boundaries.

## Quick Start

Typical usage will be like

```ts
const { data, error } = await operation();
// Since you destructured, remember to rewrap data and error values with Ok or Err
if (error) return Err(error);
// Do something with data
return Ok(data);
```

but in cases where type inference breaks and data is inferred as `T | null` instead of `T`, you should use the isErr

```ts
const result = await operation();
if (isErr(result)) return result;
// Do something with data
return result
```


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