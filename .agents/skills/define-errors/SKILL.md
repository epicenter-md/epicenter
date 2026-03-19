---
name: define-errors
description: How to define and use defineErrors from wellcrafted. Use when creating new error types, updating error definitions, or reviewing error patterns. Covers variant factories, extractErrorMessage for cause, InferErrors/InferError for types, and call site patterns.
metadata:
  author: epicenter
  version: '3.0'
---

# defineErrors

> **Related Skills**: See `error-handling` for trySync/tryAsync usage. See `services-layer` for service architecture and namespace exports.

## When to Apply This Skill

Use this pattern when you need to:

- Define or refactor domain error variants using `defineErrors`.
- Add error variants that include structured fields and `cause: unknown`.
- Centralize `extractErrorMessage(cause)` inside variant factories.
- Infer union and single-variant types via `InferErrors`/`InferError`.
- Replace old `createTaggedError` and split Err-pair patterns.

## Import

```typescript
import {
  defineErrors,
  extractErrorMessage,
  type InferErrors,
  type InferError,
} from 'wellcrafted/error';
```

## Core Rules

1. All variants for a domain live in **one `defineErrors` call** — never spread them across multiple calls
2. The factory function **returns `{ message, ...fields }`** — that is the entire API; no `.withMessage()`, `.withContext()`, or `.withCause()` chains
3. **`cause: unknown`** is just a field like any other — accept it in the input and forward it in the return object
4. **Call `extractErrorMessage(cause)` inside the factory**, never at the call site
5. Each call like `MyError.Variant({ ... })` **returns `Err(...)` automatically** — no separate `FooErr` pair
6. **Shadow the const with a same-name type** using `InferErrors` — `const FooError` / `type FooError`
7. Use `InferError<typeof FooError.Variant>` to extract a single variant's type when needed
8. **Variant names describe the specific failure mode** — never use generic names like `Service`, `Error`, or `Failed`
9. Aim for 2–5 variants per domain, each named by failure mode

## Patterns

### 1. Simple variant — no input, static message

```typescript
export const RecorderError = defineErrors({
  AlreadyRecording: () => ({
    message: 'A recording is already in progress',
  }),
});
export type RecorderError = InferErrors<typeof RecorderError>;

// Call site
return RecorderError.AlreadyRecording();
```

### 2. Variant with structured fields — message computed from input

```typescript
export const DbError = defineErrors({
  NotFound: ({ table, id }: { table: string; id: string }) => ({
    message: `${table} '${id}' not found`,
    table,
    id,
  }),
});
export type DbError = InferErrors<typeof DbError>;

// Call site
return DbError.NotFound({ table: 'users', id: '123' });
// error.message → "users '123' not found"
// error.table   → "users"
// error.id      → "123"
```

### 3. Variant with cause — extractErrorMessage inside the factory

```typescript
import { extractErrorMessage } from 'wellcrafted/error';

export const FfmpegError = defineErrors({
  CompressFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to compress audio: ${extractErrorMessage(cause)}`,
    cause,
  }),
  VerifyFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to verify temp file: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
export type FfmpegError = InferErrors<typeof FfmpegError>;

// Call site — pass the raw caught error, never call extractErrorMessage here
catch: (error) => FfmpegError.CompressFailed({ cause: error }),
```

### 4. Multiple variants in one object — discriminated union built-in

```typescript
export const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({
    deviceId,
    cause,
  }: {
    deviceId: string;
    cause: unknown;
  }) => ({
    message: `Unable to connect to device '${deviceId}'. ${extractErrorMessage(cause)}`,
    deviceId,
    cause,
  }),
  NoDevicesFound: () => ({
    message: "No microphones found. Check your connections and try again.",
  }),
});
export type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
// DeviceStreamError is automatically the union of all three variants

// Extracting a single variant type
type NoDevicesFoundError = InferError<typeof DeviceStreamError.NoDevicesFound>;
```

### 5. Domain errors with specific operation failures

```typescript
export const FsError = defineErrors({
  ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to read '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to write '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  DeleteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to delete '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
});
export type FsError = InferErrors<typeof FsError>;

// Call site
return FsError.ReadFailed({ path: '/tmp/foo.txt', cause: error });
```

## Type Extraction

```typescript
// Full union type for all variants
type HttpError = InferErrors<typeof HttpError>;

// Single variant type
type ConnectionError = InferError<typeof HttpError.Connection>;
```

## Anti-Patterns

```typescript
// WRONG — old createTaggedError API
import { createTaggedError } from 'wellcrafted/error';
const { FooError, FooErr } = createTaggedError('FooError')
  .withContext<{ id: string }>()
  .withMessage(({ context }) => `Not found: ${context.id}`);

// WRONG — calling extractErrorMessage at the call site
catch: (error) => MyError.Failed({ message: extractErrorMessage(error) });
// CORRECT — pass raw cause, call extractErrorMessage inside the factory
catch: (error) => MyError.Failed({ cause: error });

// WRONG — one defineErrors per variant (defeats the namespace grouping)
const BusyError = defineErrors({ BusyError: () => ({ message: 'Busy' }) });
const PermError = defineErrors({ PermError: () => ({ message: 'No perm' }) });
// CORRECT — all variants for a domain in one call
const RecorderError = defineErrors({
  Busy: () => ({ message: 'A recording is already in progress' }),
  PermissionDenied: () => ({ message: 'Microphone permission denied' }),
});

// WRONG — using ReturnType instead of InferErrors
type FooError = ReturnType<typeof FooError>;
// CORRECT
type FooError = InferErrors<typeof FooError>;

// WRONG — using separate Err/FooErr pair (old API)
FooErr({ context: { id: '1' } });
// CORRECT — each variant call returns Err(...) automatically
FooError.NotFound({ id: '1' });

// WRONG — generic "Service" variant name (says nothing about the failure mode)
const RecorderError = defineErrors({
  Service: ({ message }: { message: string }) => ({ message }),
});
// RecorderError.Service({ message: '...' }) — "Service" is not a failure mode
// CORRECT — name each variant by what actually went wrong
const RecorderError = defineErrors({
  AlreadyRecording: () => ({ message: 'A recording is already in progress' }),
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceNotFound: ({ deviceId }: { deviceId: string }) => ({
    message: `Device not found: ${deviceId}`,
    deviceId,
  }),
});

// WRONG — generic catch-all with operation string (hides failure modes behind a parameter)
const FfmpegError = defineErrors({
  Service: ({ operation, cause }: { operation: string; cause: unknown }) => ({
    message: `Failed to ${operation}: ${extractErrorMessage(cause)}`,
    operation,
    cause,
  }),
});
// FfmpegError.Service({ operation: 'compress audio', cause }) — variant name is meaningless
// CORRECT — each operation is its own variant
const FfmpegError = defineErrors({
  CompressFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to compress audio: ${extractErrorMessage(cause)}`,
    cause,
  }),
  VerifyFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to verify temp file: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

// WRONG — monolithic single-variant error for a domain with many failure modes
const RecorderError = defineErrors({
  Error: ({ message }: { message: string }) => ({ message }), // Too vague
});
// CORRECT — split by failure mode
const RecorderError = defineErrors({
  AlreadyRecording: () => ({ message: 'A recording is already in progress' }),
  InitFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to initialize recorder: ${extractErrorMessage(cause)}`,
    cause,
  }),
  StreamAcquisition: ({ cause }: { cause: unknown }) => ({
    message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
```
