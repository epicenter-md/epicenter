# wellcrafted

Delightful TypeScript utilities for elegant, type-safe applications.

## Overview

This library provides delightful TypeScript utilities including:

- **Result Pattern**: Type-safe error handling with `Ok`/`Err` variants (`wellcrafted/result`)
- **Brand Types**: Nominal typing for creating distinct types from primitives (`wellcrafted/brand`)
- **Error Utilities**: Structured, serializable error handling (`wellcrafted/error`)

## Modular Imports

```typescript
// Result handling
import { Result, Ok, Err, isOk, isErr, trySync, tryAsync } from "wellcrafted/result";

// Error utilities
import { type TaggedError, extractErrorMessage } from "wellcrafted/error";

// Brand types
import { type Brand } from "wellcrafted/brand";
```

The Result pattern represents either success (Ok) or failure (Err data structure) of an operation. This implementation uses the "exclusive" approach where `null` values indicate absence (success has `error: null`, failure has `data: null`).

## Implementation

### Exclusive Values with Null

```typescript
// From result.ts
type Ok<T> = { data: T; error: null };
type Err<E> = { error: E; data: null };
type Result<T, E> = Ok<T> | Err<E>;
```

This implementation uses `null` to indicate absence, ensuring that a success result always has `error: null` and a failure result always has `data: null`. This provides clear type discrimination and excellent TypeScript inference.

## Error Type Naming Convention

Error types should follow the convention of ending with "Error" suffix:

- `ValidationError` - for input validation errors
- `NetworkError` - for network-related errors
- `DatabaseError` - for database operation errors
- `AuthenticationError` - for authentication failures

## Usage

The implementation provides utility functions:

- `Ok<T>(data: T)`: Create a success result
- `Err<E>(error: E)`: Create an Err data structure containing an error type
- `isOk(result)`: Type guard to check for success
- `isErr(result)`: Type guard to check for Err data structure
- `trySync<T, E>({ try, mapErr })`: Execute a synchronous operation safely
- `tryAsync<T, E>({ try, mapErr })`: Execute an asynchronous operation safely

### Basic Usage

```typescript
const result = await fetchData();
if (isOk(result)) {
  // Success case: use result.data
} else {
  // Err data structure case: use result.error (which contains the error type)
}
```

### Safe Operation Execution

```typescript
// Wrapping a potentially throwing operation
const result = trySync({
  try: () => JSON.parse(jsonString),
  mapErr: (error) => Err({
    name: "ValidationError",
    message: `JSON parsing failed: ${extractErrorMessage(error)}`,
    context: { jsonString },
    cause: error,
  }),
});

if (isErr(result)) {
  console.error("Parsing failed:", result.error);
} else {
  console.log("Parsed successfully:", result.data);
}
```

## Type Inference

The implementation provides type inference helpers:

- `UnwrapOk<R>`: Extract the success type from a Result type
- `UnwrapError<R>`: Extract the error type from a Result type

## Best Practices

- Always handle both success and Err data structure cases
- Use the `trySync` and `tryAsync` functions to safely execute operations that might throw exceptions
- Follow the error type naming convention with "Error" suffix
- Include meaningful context in error types for better debugging
- Use tagged unions for error types to enable exhaustive pattern matching 