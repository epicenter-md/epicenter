---
name: error-handling
description: Error handling with wellcrafted trySync/tryAsync and toastOnError. Use for try-catch, Result types, error toasts, HTTP errors.
metadata:
  author: epicenter
  version: '2.0'
---

# Error Handling with wellcrafted trySync and tryAsync

## References

Load these on demand based on what you're working on:

- If working with **wrapping boundaries, minimal vs extended wrapping, or immediate-return control flow**, read [references/wrapping-patterns.md](references/wrapping-patterns.md)
- If working with **toast notifications for errors** (`toastOnError`, `extractErrorMessage` in UI), read [references/toast-on-error.md](references/toast-on-error.md)
- If working with **real-world codebase examples and wrapping scenario guidelines**, read [references/real-world-examples.md](references/real-world-examples.md)
- If working with **HTTP route handlers and status-response error conversion**, read [references/http-handlers.md](references/http-handlers.md)
- If working with **workspace actions** (`defineQuery` / `defineMutation`: when to throw vs. return `Err`, how remote callers see your errors, `ActionFailed` semantics), read [../workspace-api/references/action-return-shapes.md](../workspace-api/references/action-return-shapes.md)

## Use trySync/tryAsync Instead of try-catch for Graceful Error Handling

When handling errors that can be gracefully recovered from, use `trySync` (for synchronous code) or `tryAsync` (for asynchronous code) from wellcrafted instead of traditional try-catch blocks. This provides better type safety and explicit error handling.

> **Related Skills**: See `define-errors` skill for `defineErrors` patterns, `services-layer` skill for service architecture, and `query-layer` skill for RPC error pass-through and report-boundary presentation.

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
		return Ok(defaultConfig); // Return Ok with fallback
	},
});

// ASYNCHRONOUS: Use tryAsync for async operations
await tryAsync({
	try: async () => {
		const child = new Child(session.pid);
		await child.kill();
	},
	catch: (e) => {
		// Process was already terminated; nothing to do
		return Ok(undefined); // Return Ok(undefined) for void functions
	},
});

// Both support the same catch patterns
const syncResult = trySync({
	try: () => riskyOperation(),
	catch: (error) => {
		// For recoverable errors, return Ok with fallback value
		return Ok('fallback-value');
		// For unrecoverable errors, pass the raw cause: the constructor handles extractErrorMessage
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

## Whispering RPC Error Flow

Whispering `$lib/rpc` adapters preserve tagged errors from services and operations. They should return `Err(error)` or the operation result directly, not convert errors into user-facing `{ title, description }` objects.

```typescript
const { data, error } = await services.blobs.audio.getBlob(recording.id);
if (error) return Err(error);
return Ok(data);
```

Presentation happens at the UI or operation boundary:

```typescript
if (error) {
	report.error({ cause: error });
	return;
}
```

## Consuming Result values: destructure `error` explicitly

When reading a `Result<T, E>` that a library (or your own code) returns,
like `table.get(id)`, `tryAsync(...)`, or a service method, **always
destructure both `data` and `error` and check `error` on its own line**,
even when both paths should produce the same action.

```typescript
// ✅ GOOD: error is destructured and checked explicitly
const { data: row, error } = table.get(id);
if (error) {
  log.warn(error);
  return null;
}
if (row === null) return null;       // legitimate absence
use(row);                             // row: TRow

// ❌ BAD: relies on "data is null if error exists" by coincidence
const { data: row } = table.get(id);  // error silently swallowed
if (row === null) return null;
use(row);
```

Why:
- **Reading intent**: the `if (error)` line tells future readers the
  error case is considered, not forgotten.
- **Distinct handling opportunity**: even if you currently do the same
  thing on both branches, splitting the checks gives you a place to
  log / toast / retry on errors without rewriting the control flow.
- **Avoids coincidental behavior**: "data is null when error exists"
  is true in wellcrafted's `Result`, but relying on that fact at the
  call site ties your code to the representation, not the contract.

### When combining conditions is OK

If both cases *genuinely* produce the same action (no log, no toast,
no retry, no distinction worth writing down), one combined condition
is fine, as long as `error` is still destructured:

```typescript
// ✅ OK: error destructured, both cases deliberately collapsed
const { data: row, error } = table.get(id);
if (error || row === null) continue;  // skip in both cases
use(row);
```

The destructure matters; it signals you thought about the error case
and chose to collapse it. The anti-pattern is destructuring *only*
`data` and hoping for the best.

### When to split the checks

Split into two explicit checks when the handling differs:

```typescript
const { data: row, error } = table.get(id);
if (error) {
  logger.warn('row corrupted, replacing', { id, error });
  await replaceWithDefault(id);
  return;
}
if (row === null) {
  await createMissingRow(id);
  return;
}
use(row);
```

This is the form to prefer by default; collapse back only when
there's truly nothing distinct to say.

## When traditional try-catch is still right

`trySync` covers synchronous work and `tryAsync` covers anything returning a Promise. Keep a traditional try-catch only when:

- In module-level initialization code where you can't await
- For simple fire-and-forget operations
- When you're outside of a function context
- When integrating with code that expects thrown exceptions

## Logging errors

Typed errors are structured values, so they're also what the `wellcrafted/logger` wants. `log.warn` / `log.error` take a typed error unary: no message argument, no format string. The error owns its message, and the log sink gets the full object (name, fields, cause) alongside it.

### The canonical pattern

Mint the typed error inside `catch:`, then branch on the Result and log inside the branch. The caller picks the level (`.warn` for recoverable, `.error` for loud) at the call site, matching Rust's `tracing::warn!(?err)` convention, where level lives at the call site and never on the error variant.

```ts
import { createLogger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';

const log = createLogger('sqlite-writer');

const walResult = trySync({
  try: () => db.query('PRAGMA journal_mode = WAL').get(),
  catch: (cause) => SqliteWriterError.PragmaSetupFailed({ pragma: 'WAL', cause }),
});
if (walResult.error !== null) {
  log.warn(walResult.error);
} else if (walResult.data !== 'wal') {
  log.warn(SqliteWriterError.WalSilentFallback({ actualMode: walResult.data }));
}
```

Most epicenter call sites need the Ok branch's data locally, so they branch first and log inside the branch. The mint-and-log shorthand works the same way inside a `.catch` tail when there's no Result to branch on:

```ts
}).catch((cause) => {
  log.warn(MaterializerWriteError.TableWriteFailed({ tableName, cause }));
});
```

`log.warn` / `log.error` accept either the raw tagged error (`result.error` after narrowing) or the `Err`-wrapped factory output (`MyError.Variant({ ... })`) and unwrap structurally.

For the rarer Result-chain shape (`tryAsync(...).then(...)` where the Result flows out of the function), `tapErr(log.warn)` from `wellcrafted/result` is the combinator; see the logging SKILL's See also section.

### Why no `log.error(message, error)`?

Level is context-dependent (same error can be `warn` on a retry, `error` on the last attempt) and message lives on the error variant. That's the whole point of `defineErrors`: the variant's `message:` template encodes the "what operation failed" clause. Duplicating it at the call site would drift and rot.

### Testing with `memorySink`

Never assert on console output. Use `memorySink()` and inspect the events array directly:

```ts
import { createLogger, memorySink } from 'wellcrafted/logger';

test('logs a warning when the materializer write fails', () => {
  const { sink, events } = memorySink();
  const log = createLogger('sqlite-materializer', sink);
  // ... trigger the path ...
  expect(events).toContainEqual(
    expect.objectContaining({
      level: 'warn',
      data: expect.objectContaining({ name: 'TableWriteFailed' }),
    }),
  );
});
```

See the `logging` skill for level semantics, sink composition, and the JSONL file sink.
