# Error Naming Convention

This document establishes the clear distinction between error-related concepts in the Result library.

## Key Concepts

### 1. **Error Types** (end with "Error" suffix)
- The actual error values/types that contain error information
- Examples: `ValidationError`, `NetworkError`, `DatabaseError`, `StorageError`
- These are the `E` in `Result<T, E>` and `Err<E>`
- Follow tagged union pattern with `name` property as discriminator

```typescript
type ValidationError = TaggedError<"ValidationError">;
type NetworkError = TaggedError<"NetworkError">;
```

### 2. **Err Data Structure**
- The wrapper that contains an error type in the Result system
- Structure: `{ error: E; data: null }`
- One of the two variants of `Result<T, E>` (the other being `Ok<T>`)
- Created using `Err(errorValue)` constructor

```typescript
const result: Result<string, ValidationError> = Err(validationError);
```

### 3. **Result**
- The union type `Ok<T> | Err<E>` representing either success or failure
- The top-level type that encapsulates both success and error scenarios

## Function Naming

### Updated Function Names
- `mapError` (not `mapErr`) - maps unknown errors to typed error values
- `UnwrapError` (not `UnwrapErr`) - extracts error type from Result type
- `isErr` - checks if something is an Err data structure (unchanged)
- `isOk` - checks if something is an Ok data structure (unchanged)

### Function Signatures
```typescript
trySync<T, E>({
  try: () => T;
  mapError: (error: unknown) => E;  // Maps to error TYPE
}): Result<T, E>

tryAsync<T, E>({
  try: () => Promise<T>;
  mapError: (error: unknown) => E;  // Maps to error TYPE
}): Promise<Result<T, E>>
```

## Documentation Terminology

### Consistent Language
- "Error type" or "error value" - refers to the actual error (ValidationError, etc.)
- "Err data structure" - refers to the wrapper `{ error: E; data: null }`
- "Result" - refers to the union type that can be either Ok or Err

### Examples
```typescript
// Creating an error type
const validationError: ValidationError = {
  name: "ValidationError",
  message: "Input is required",
  context: { input: "" },
  cause: null,
};

// Wrapping in Err data structure
const errResult: Result<string, ValidationError> = Err(validationError);

// Type guards work on the data structure level
if (isErr(errResult)) {
  // errResult.error contains the ValidationError type
  console.log(errResult.error.message);
}
```

## Error Type Naming Rules

1. **Always end with "Error" suffix**: `ValidationError`, not `Validation`
2. **Use PascalCase**: `NetworkError`, not `network_error` or `NETWORK_ERROR`
3. **Be specific**: `AuthenticationError` vs generic `ServiceError`
4. **Follow domain boundaries**: `DatabaseError`, `FileSystemError`, etc.

This convention provides clear semantics and helps developers understand the distinction between the error data itself and the data structures that contain it. 