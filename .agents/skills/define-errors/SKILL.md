---
name: define-errors
description: 'defineErrors from wellcrafted: variant factories, extractErrorMessage, InferErrors/InferError, call site patterns. Use when creating error types or reviewing error patterns.'
metadata:
  author: epicenter
  version: '3.0'
---

# defineErrors

> **Related Skills**: See `error-handling` for trySync/tryAsync usage and toast-on-error patterns. See `services-layer` for service architecture and namespace exports.

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

1. All variants for a domain live in **one `defineErrors` call**: never spread them across multiple calls
2. The factory function **returns `{ message, ...fields }`**: that is the entire API; no `.withMessage()`, `.withContext()`, or `.withCause()` chains
3. **`cause: unknown`** is just a field like any other: accept it in the input and forward it in the return object
4. **Call `extractErrorMessage(cause)` inside the factory**, never at the call site
5. Each call like `MyError.Variant({ ... })` **returns `Err(...)` automatically**: no separate `FooErr` pair
6. **Shadow the const with a same-name type** using `InferErrors`: `const FooError` / `type FooError`
7. Use `InferError<typeof FooError.Variant>` to extract a single variant's type when needed
8. **Variant names describe the specific failure mode**: never use generic names like `Service`, `Error`, or `Failed`
9. Aim for 2-5 variants per domain, each named by failure mode
10. **Write `.message` for end-user readability**: `toastOnError` shows `.message` as the muted toast description below the bold title. Write messages that make sense to users, not just developers. Avoid raw paths, status codes, or stack traces as the primary message. Include them after a human-readable prefix:

```typescript
// ✅ GOOD: human-readable prefix, technical detail after
message: `Could not save recording: ${extractErrorMessage(cause)}`

// ❌ BAD: raw technical output as the entire message
message: `POST /api/recordings 500: ${extractErrorMessage(cause)}`
```

## Patterns

### 1. Simple variant: no input, static message

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

### 2. Variant with structured fields: message computed from input

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
// error.message -> "users '123' not found"
// error.table   -> "users"
// error.id      -> "123"
```

### 3. Multiple variants in one object: discriminated union built-in

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

## Type Extraction

```typescript
// Full union type for all variants
type HttpError = InferErrors<typeof HttpError>;

// Single variant type
type ConnectionError = InferError<typeof HttpError.Connection>;
```

## Consuming a Variant Union: Exhaustive `switch`, Not `if/else`

`defineErrors` builds a discriminated union tagged by `name`. When you *translate the whole union* (every variant mapped to another error, an exit code, a UI state), discriminate with an exhaustive `switch (error.name)` and pin it with `default: error satisfies never`. Do not use an `if/else` chain.

```ts
// ❌ non-exhaustive fold: a 6th DispatchError variant lands in `else` silently
if (result.error.name === 'RecipientOffline') {
  return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus });
}
return RunError.RemoteCallFailed({ cause: result.error, peerTarget, syncStatus });

// ✅ exhaustive: a 6th variant fails to compile until someone buckets it
switch (result.error.name) {
  case 'RecipientOffline':
    return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus });
  case 'ActionNotFound':
  case 'ActionFailed':
  case 'Cancelled':
  case 'NetworkFailed':
    return RunError.RemoteCallFailed({ cause: result.error, peerTarget, syncStatus });
  default:
    return result.error satisfies never;
}
```

**Why**: error unions grow. The `satisfies never` default makes the *producer* adding a variant break the *consumer's* build, forcing a deliberate decision instead of a silent fall-through into the catch-all branch. Collapsing several variants into one output is fine: list their `case` labels explicitly so the collapse is visible and intentional.

### Not every `error.name === 'X'` is wrong

Two shapes are legitimate and should stay as an `if` or a plain expression:

- **Predicate**: one boolean about one variant.
  ```ts
  get isCreditsExhausted() {
    return chat.error instanceof AiChatHttpError
      && chat.error.detail.name === 'InsufficientCredits';
  }
  ```
- **Guard**: special-case one variant, then let the rest flow through a
  shared path.
  ```ts
  if (result.error.name === 'Throttled') {
    await waitFor(result.error.retryAfterMs);
    return retry();
  }
  // every other variant flows to the shared handling below
  ```

The smell is specifically the **total fold**: every branch consumes the union into a different output, with no compiler pin. If you are translating the whole union, switch on it. This is not error-specific: the same rule applies to any closed discriminated union (state enums keyed by `kind`, `phase`, or `state`). See `code-audit` category 8 for the detection grep recipe.

## Anti-Patterns

```typescript
// WRONG: old createTaggedError API
import { createTaggedError } from 'wellcrafted/error';
const { FooError, FooErr } = createTaggedError('FooError')
  .withContext<{ id: string }>()
  .withMessage(({ context }) => `Not found: ${context.id}`);

// WRONG: calling extractErrorMessage at the call site
catch: (error) => MyError.Failed({ message: extractErrorMessage(error) });
// CORRECT: pass raw cause, call extractErrorMessage inside the factory
catch: (error) => MyError.Failed({ cause: error });

// WRONG: one defineErrors per variant (defeats the namespace grouping)
const BusyError = defineErrors({ BusyError: () => ({ message: 'Busy' }) });
const PermError = defineErrors({ PermError: () => ({ message: 'No perm' }) });
// CORRECT: all variants for a domain in one call
const RecorderError = defineErrors({
  Busy: () => ({ message: 'A recording is already in progress' }),
  PermissionDenied: () => ({ message: 'Microphone permission denied' }),
});

// WRONG: using ReturnType instead of InferErrors
type FooError = ReturnType<typeof FooError>;
// CORRECT
type FooError = InferErrors<typeof FooError>;

// WRONG: using separate Err/FooErr pair (old API)
FooErr({ context: { id: '1' } });
// CORRECT: each variant call returns Err(...) automatically
FooError.NotFound({ id: '1' });

// WRONG: generic catch-all with operation string (hides failure modes behind a parameter)
const FfmpegError = defineErrors({
  Service: ({ operation, cause }: { operation: string; cause: unknown }) => ({
    message: `Failed to ${operation}: ${extractErrorMessage(cause)}`,
    operation,
    cause,
  }),
});
// FfmpegError.Service({ operation: 'compress audio', cause }): variant name is meaningless
// CORRECT: each operation is its own variant
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
```

## Anti-pattern: ad-hoc `{ ok, ... }` discriminated unions

When a function (especially across an RPC/IPC/HTTP boundary) needs to signal success or failure, do **not** invent a parallel `{ ok: true, data } | { ok: false, error }` shape. This codebase already uses wellcrafted's `Result<T, E>` (`{ data: T, error: null } | { data: null, error: E }`): a parallel `{ ok }` invention duplicates a stable shape that already has tooling around it.

```ts
// ❌ ad-hoc: parallel invention to Result<T, E>
type CallResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { name: string; message: string } };
```

```ts
// ✅ Use Result + defineErrors
import type { Result } from 'wellcrafted/result';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const CallError = defineErrors({
  Timeout: ({ timeoutMs }: { timeoutMs: number }) => ({
    message: `timed out after ${timeoutMs}ms`,
    timeoutMs,
  }),
  // ...
});
export type CallError = InferErrors<typeof CallError>;

type CallResult<T> = Result<T, CallError>;
```

**Why**: every wellcrafted helper (`isOk`/`isErr`, `tryAsync`/`trySync`, `unwrap`, `tapErr`, the logger's `"name" in err` discriminator) operates on `{ data, error }`. `{ ok }` returns can't compose with any of it. Each ad-hoc invention loses ecosystem leverage and forces every consumer to learn one more shape.

**Wire-format corollary**: when a `Result` crosses a serialization boundary (RPC, IPC, HTTP), the `defineErrors` `{ name, message, ...fields }` shape **is** the wire form. The receiver reconstructs by reading `error.name` to dispatch; no `{ ok }` wrapper needed.

## Whispering RPC Boundary

In Whispering, `$lib/rpc` preserves tagged errors. Do not convert service or operation errors into `{ title, description }` or another user-facing wrapper inside an RPC adapter. UI and operation code choose display copy with `$lib/report`, usually `report.error({ cause: error })`.

Define an RPC-local `defineErrors` namespace only when the adapter itself owns a failure that no lower layer can own, such as a missing state lookup before calling an operation.

**Note: state machines are not Results**: discriminated unions like `{ state: 'in-use' | 'orphan' | 'clean' }` for a startup gate, or `{ outcome: 'graceful' | 'sigterm' }` for a shutdown, are genuine state enums and should stay as discriminated unions. The smell is *errors* dressed as `{ ok }` flags, not state-enums.

## Reserved field name: `name`

`name` is reserved at the type level: TypeScript errors if you return it from a factory, because the factory stamps it from the variant key.

```ts
// ❌ Type error: factory would overwrite this anyway
defineErrors({
  Bad: () => ({ message: 'x', name: 'override' }),
});

// ✅ Fine
defineErrors({
  Good: ({ path, payload }: { path: string; payload: unknown }) => ({
    message: `failed at ${path}`,
    path,
    payload,
  }),
});
```

### Soft convention: avoid `data` as a field name

`Err<E>` carries a `data: null` at the wrapper level (it's how the shape distinguishes `Err` from `Ok`). A variant body with its own `data` field is visually confusing: `err.data` (the wrapper's null) shadows `err.error.data` (your field) in every reader's head.

This is **not** type-enforced (an earlier wellcrafted PR tried to reserve `data` and reverted; the logger's `"name" in err` discriminator doesn't depend on the reservation, so the breaking change was dropped). Prefer `payload`, `body`, `value`, or a domain-specific name like `path`, `response`, `input`.

## Related: don't call `Err(null)`; wrap caught values in a tagged error

`wellcrafted`'s Result shape can't distinguish `Err(null)` from `Ok(null)`: both produce `{ data: null, error: null }`, and `isErr` reads both as success. The `Err` constructor accepts any `E`; there's no type-level ban (one was tried and reverted because it was bypassable by casts and taught the wrong fix).

The rule lives in idiom: **at every `catch (error: unknown)` boundary, wrap the caught value in a tagged error from `defineErrors`, don't pass it straight to `Err`.**

```ts
// ❌ If error is ever null/undefined at runtime, Err silently becomes Ok
catch: (error) => Err(error)

// ✅ Tagged error is always non-null by construction
const Errors = defineErrors({
  Unexpected: ({ cause }: { cause: unknown }) => ({
    message: extractErrorMessage(cause),
    cause,
  }),
});
catch: (error) => Errors.Unexpected({ cause: error })
```

See [docs/articles/ok-null-is-fine-err-null-is-a-lie.md](../../../docs/articles/ok-null-is-fine-err-null-is-a-lie.md) for the full rationale, and the wellcrafted philosophy doc at `docs/philosophy/err-null-is-ok-null.md` for the deep dive on why the type-level ban failed.
