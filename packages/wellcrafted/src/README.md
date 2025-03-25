# Result

A TypeScript implementation of the Result pattern, providing a type-safe way to handle operations that can fail.

## Overview

The Result pattern represents either success (Ok) or failure (Err) of an operation. This implementation provides two different approaches:

1. **Discriminated** (`discriminated.ts`): Uses a boolean `ok` property as the discriminant.
2. **Exclusive** (`exclusive.ts`): Uses `null` values to indicate absence (success has `error: null`, failure has `data: null`).

## Implementations

### Discriminated Union with Boolean Flag

```typescript
// From discriminated.ts
type Ok<T> = { ok: true; data: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;
```

This implementation follows the common pattern of using a boolean discriminant (`ok`) to distinguish between success and failure cases. TypeScript's discriminated unions work effectively with this pattern.

### Exclusive Values with Null

```typescript
// From exclusive.ts
type Ok<T> = { data: T; error: null };
type Err<E> = { error: E; data: null };
type Result<T, E> = Ok<T> | Err<E>;
```

This implementation uses `null` to indicate absence, ensuring that a success result always has `error: null` and a failure result always has `data: null`.

## Usage

Both implementations provide similar utility functions:

- `Ok<T>(data: T)`: Create a success result
- `Err<E>(error: E)`: Create an error result
- `trySync<T, E>({ try, mapErr })`: Execute a synchronous operation safely
- `tryAsync<T, E>({ try, mapErr })`: Execute an asynchronous operation safely

The `discriminated.ts` implementation requires checking the `ok` property:

```typescript
const result = await fetchData();
if (result.ok) {
  // Success case: use result.data
} else {
  // Error case: use result.error
}
```

The `exclusive.ts` implementation provides type guards:

```typescript
const result = await fetchData();
if (isOk(result)) {
  // Success case: use result.data
} else {
  // Error case: use result.error
}
```

## Type Inference

Both implementations provide type inference helpers:

- `InferOk<R>`: Extract the success type from a Result type
- `InferErr<R>`: Extract the error type from a Result type

## Best Practices

- Use the discriminated union version (with boolean flag) when you need simple conditionals based on `result.ok`
- Use the exclusive version when you prefer using type guards (`isOk`/`isErr`) for more explicit type narrowing
- Always handle both success and error cases
- Use the `trySync` and `tryAsync` functions to safely execute operations that might throw exceptions 