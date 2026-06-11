# Tagged Error Redesign: Break Up Monolithic Errors, Improve Payload Structure

**Created**: 2026-02-25
**Status**: Superseded by `20260226T233600-tagged-error-minimal-design.md` (wellcrafted) and `20260226T000000-granular-error-migration.md` (epicenter)

> **Note**: This spec proposed `.withMessage()` as a required terminal step with optional `message` override. Both aspects were revised: `.withMessage()` is now optional, and when present it **seals** the message (no override). See the superseding specs for the final design.

## Problem

The `createTaggedError` infrastructure and `Result<T, E>` type follow the "nest, don't flatten" pattern (binary `{ data, error }` split first, then discriminate errors by `name`). But most services don't use the pattern to its potential:

- **24 of 27 errors** are monolithic single-type-per-service (e.g., `RecorderServiceError`, `DbServiceError`)
- **2 of 27** use `.withContext()` (`ResponseError`, `ExtensionError`)
- **0 of 27** use `.withCause()`
- **1 of 27** is a properly discriminated union (`HttpServiceError = ConnectionError | ResponseError | ParseError`)

This means "device busy," "permission denied," and "stream failed" all produce the same `RecorderServiceError` distinguished only by their `message` string. Consumers can't handle specific failures programmatically without string-matching.

## Goals

1. Break monolithic service errors into discriminated unions of specific failure modes
2. Make `.withMessage()` required: every error defines how its message is computed from its structured data
3. Use structured `context` instead of encoding information in message strings
4. Enforce JSON-serializability of error data for logging/observability

## Design Decisions

### 1. Break monolithic errors into unions

**Status: Accepted**

Each service should define errors by failure mode, not by service. The `HttpService` is the model to follow:

```typescript
// Before: one error for everything
const { DbServiceError, DbServiceErr } = createTaggedError('DbServiceError');

// After: specific errors per failure mode
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withContext<{ table: string; id: string }>()
  .withMessage(({ context }) => `${context.table} '${context.id}' not found`);

const { DbConstraintError, DbConstraintErr } = createTaggedError('DbConstraintError')
  .withContext<{ table: string; constraint: string }>()
  .withMessage(({ context }) => `Constraint '${context.constraint}' violated on ${context.table}`);

const { DbConnectionError, DbConnectionErr } = createTaggedError('DbConnectionError')
  .withMessage(() => 'Failed to connect to database');

type DbServiceError = DbNotFoundError | DbConstraintError | DbConnectionError;
```

```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

const { RecorderPermissionError, RecorderPermissionErr } = createTaggedError('RecorderPermissionError')
  .withContext<{ device: string }>()
  .withMessage(({ context }) => `Microphone permission denied for ${context.device}`);

const { RecorderDeviceError, RecorderDeviceErr } = createTaggedError('RecorderDeviceError')
  .withContext<{ deviceId: string }>()
  .withMessage(({ context }) => `Failed to acquire stream from device '${context.deviceId}'`);

type RecorderServiceError = RecorderBusyError | RecorderPermissionError | RecorderDeviceError;
```

**Principle**: The union type name can still be `{Service}ServiceError`. Individual errors are named by failure mode, not by service.

### 2. `.withMessage()` is required, always terminal, callback always required

**Status: Accepted**

Every `createTaggedError` chain **must** end with `.withMessage(fn)`. This is enforced at the type level: the error factory functions (`FooError`, `FooErr`) are only available on the return type of `.withMessage()`, not on the builder itself.

**The callback is always required**: there is no auto-derivation from the error name. Auto-deriving messages from PascalCase names (e.g., `'RecorderBusyError'` -> `'Recorder busy'`) produces low-quality messages: noun phrases instead of sentences, no indication of what happened, and a hidden coupling between the name (chosen for type discrimination) and the message (written for human comprehension). Those are different concerns. The cost of writing `.withMessage(() => 'A recording is already in progress')` is trivial, and the message is always better than what auto-derive would produce.

#### Builder API

`.withMessage()` receives a callback with `{ name, context?, cause? }`: everything the error will have except `message` (since that's what it's computing):

```typescript
// No context, no cause: callback gets { name }
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

// With context: callback gets { name, context }
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withContext<{ table: string; id: string }>()
  .withMessage(({ context }) => `${context.table} '${context.id}' not found`);

// With context and cause: callback gets { name, context, cause }
const { ServiceError, ServiceErr } = createTaggedError('ServiceError')
  .withContext<{ operation: string }>()
  .withCause<DbServiceError>()
  .withMessage(({ context, cause }) =>
    `Operation '${context.operation}' failed: ${cause.message}`
  );
```

#### The callback signature

```typescript
type MessageFn<TName, TContext, TCause> =
  (input: MessageInput<TName, TContext, TCause>) => string;

type MessageInput<TName, TContext, TCause> =
  { name: TName }
  & ([TContext] extends [undefined] ? {} : { context: TContext })
  & ([TCause] extends [undefined] ? {} : { cause: TCause });
```

#### Chain ordering

`.withContext()` and `.withCause()` can be in **any order** relative to each other. They fill in independent type parameters. `.withMessage()` must always be **last** because it needs to know the final context and cause types.

```typescript
// All valid:
createTaggedError('X').withMessage(() => 'Something failed')
createTaggedError('X').withContext<T>().withMessage(fn)
createTaggedError('X').withCause<C>().withMessage(fn)
createTaggedError('X').withContext<T>().withCause<C>().withMessage(fn)
createTaggedError('X').withCause<C>().withContext<T>().withMessage(fn)

// Invalid: factories not accessible without withMessage:
const { FooError } = createTaggedError('FooError');  // TS error!
// Property 'FooError' does not exist on type 'ErrorBuilder<...>'

// Invalid: withMessage called without callback:
createTaggedError('X').withMessage()  // TS error!
// Expected 1 arguments, but got 0

// Invalid: withMessage not last:
createTaggedError('X').withMessage(fn).withContext<T>()  // TS error!
// Property 'withContext' does not exist on type 'FinalFactories<...>'
```

#### Type enforcement

The builder type does NOT include factory functions. Only the return type of `.withMessage()` does:

```typescript
// Builder: has chain methods, NO factories
type ErrorBuilder<TName, TContext, TCause> = {
  withContext<T extends JsonObject>(): ErrorBuilder<TName, T, TCause>;
  withCause<T extends AnyTaggedError>(): ErrorBuilder<TName, TContext, T>;
  withMessage(fn: MessageFn<TName, TContext, TCause>): FinalFactories<TName, TContext, TCause>;
};

// FinalFactories: has factories, NO chain methods
type FinalFactories<TName, TContext, TCause> = {
  [K in TName]: (input: ErrorCallInput<TContext, TCause>) => TaggedError<TName, TContext, TCause>;
  [K in ReplaceErrorWithErr<TName>]: (input: ErrorCallInput<TContext, TCause>) => Err<TaggedError<TName, TContext, TCause>>;
};
```

This means you literally cannot construct errors without first defining how their message is computed.

#### Call site: `message` is no longer an input, `context` is the input

```typescript
// Before: message is manual, data trapped in string
RecorderServiceErr({ message: `Failed to acquire stream from device "${deviceName}"` });

// After: just provide structured data, message auto-computes
RecorderDeviceErr({ context: { deviceId } });
// error.message → "Failed to acquire stream from device 'abc123'"
// error.context → { deviceId: 'abc123' }
// error.name → 'RecorderDeviceError'
```

#### Message override per instance

Optional `message` override for one-off cases where the template doesn't suffice:

```typescript
DbNotFoundErr({
  message: 'The recording you are looking for has been deleted',
  context: { table: 'recordings', id: '123' },
});
```

When `message` is provided, it takes precedence. When omitted, the template computes it. Either way, `error.message` is always `string`.

#### Output type is unchanged

The `TaggedError` type always has `message: string`. The template is an implementation detail of the factory:

```typescript
type DbNotFoundError = {
  readonly name: 'DbNotFoundError';
  readonly message: string;
  readonly context: { table: string; id: string };
};
```

### 3. Context must be JSON-serializable

**Status: Accepted**

Tagged errors are plain objects (`{ name, message, context?, cause? }`), not `Error` class instances. This is intentional, no non-enumerable properties, no stack traces, no prototype chains to deal with. Because they're plain objects, JSON serialization is straightforward if we constrain what goes into them.

The `context` constraint changes from `Record<string, unknown>` to `JsonObject`:

```typescript
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;

// Before: allows functions, symbols, circular refs
TContext extends Record<string, unknown> | undefined

// After: enforces serializability
TContext extends JsonObject | undefined
```

`cause` is always an `AnyTaggedError`: which has `name: string`, `message: string`, and optionally `context: JsonObject` and `cause: AnyTaggedError`. Since context is JSON-serializable and cause is recursively a TaggedError, the entire error tree is JSON-serializable by induction.

**Why not `toJSON()` or a `serialize()` function?** They're unnecessary. The object already *is* the serialized form: `JSON.stringify(error)` just works:

```typescript
JSON.stringify(error);
// → {"name":"DbNotFoundError","message":"recordings 'abc' not found","context":{"table":"recordings","id":"abc"}}
```

No `toJSON()` method to maintain, no serialization layer to keep in sync. The `JsonObject` type constraint shifts validation left to definition time. If it compiles, it serializes.

**Caveat**: `JSON.stringify` silently drops `undefined` values in objects. This is acceptable for logging, but means `{ key: undefined }` and `{}` are indistinguishable in serialized output. Prefer omitting optional context fields over setting them to `undefined`.

**Implications**: No `Date` objects in context (use ISO strings). No `Error` instances (use `extractErrorMessage()`). No class instances. This is intentional: it forces portable, structured error data.

### 4. Separate errors vs. discriminated union in context

**Status: Accepted**

There are two valid patterns for expressing error variants. The choice depends on how consumers need to discriminate.

#### Approach A: Separate tagged errors (discriminate on `error.name`)

**Default choice.** Each variant gets its own `createTaggedError` call, its own `name`, and its own `context` shape.

Definition:
```typescript
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withContext<{ table: string; id: string }>()
  .withMessage(({ context }) => `${context.table} '${context.id}' not found`);

const { DbConstraintError, DbConstraintErr } = createTaggedError('DbConstraintError')
  .withContext<{ table: string; constraint: string }>()
  .withMessage(({ context }) => `Constraint '${context.constraint}' violated on ${context.table}`);

type DbServiceError = DbNotFoundError | DbConstraintError;
```

Creation:
```typescript
return DbNotFoundErr({ context: { table: 'recordings', id } });
return DbConstraintErr({ context: { table: 'recordings', constraint: 'unique_title' } });
```

Consumption:
```typescript
switch (error.name) {
  case 'DbNotFoundError': {
    // TS narrows: error.context is { table: string; id: string }
    return response(404, `${error.context.table} not found`);
  }
  case 'DbConstraintError': {
    // TS narrows: error.context is { table: string; constraint: string }
    return response(409, error.message);
  }
}
```

#### Approach B: Union context (discriminate on `error.context.kind`)

**Escape hatch** for when variants are internal to the error and consumers rarely distinguish them.

Definition:
```typescript
const { DbError, DbErr } = createTaggedError('DbError')
  .withContext<
    | { kind: 'not_found'; table: string; id: string }
    | { kind: 'constraint'; table: string; constraint: string }
  >()
  .withMessage(({ context }) => {
    switch (context.kind) {
      case 'not_found': return `${context.table} '${context.id}' not found`;
      case 'constraint': return `Constraint '${context.constraint}' violated on ${context.table}`;
    }
  });
```

Creation:
```typescript
return DbErr({ context: { kind: 'not_found', table: 'recordings', id } });
return DbErr({ context: { kind: 'constraint', table: 'recordings', constraint: 'unique_title' } });
```

Consumption when you don't need to discriminate (the common case for this pattern):
```typescript
if (error.name === 'DbError') {
  toast.error(error.message);
}
```

Consumption when you do need to discriminate:
```typescript
if (error.name === 'DbError') {
  switch (error.context.kind) {
    case 'not_found':
      return response(404, `${error.context.table} not found`);
    case 'constraint':
      return response(409, error.message);
  }
}
```

#### When to use which

| Signal | Separate errors (Approach A) | Union context (Approach B) |
|--------|------------------------------|----------------------------|
| Consumer handles variants differently | **Yes**: each `case` in `switch (error.name)` does something fundamentally different (404 vs login prompt vs retry) | No |
| Consumer usually treats all variants the same | No: creating 3 error types just to `toast.error(error.message)` on all of them is over-splitting | **Yes**: one `case` handles everything, drill into `.context.kind` only when needed |
| Error appears in multiple service unions | **Yes**: `ConnectionError` can appear in `HttpServiceError`, `DbServiceError`, etc. Separate names enable reuse across unions | No: `{ kind: 'connection' }` is trapped inside one error's context type |
| Exhaustiveness checking at the top level | **Yes**: `switch (error.name)` with `default: never` catches missing cases across the whole service error union | Partial: exhaustiveness on `error.name`, but `context.kind` discrimination is a second level |
| Many variants (5+) that consumers rarely distinguish individually | No: too much ceremony | **Yes**: one definition, union type does the work |

**Default to Approach A.** The `HttpServiceError` pattern (`ConnectionError | ResponseError | ParseError`) is already proven in the codebase and all consumption sites already `switch` on `error.name`. Approach B is the escape hatch for when you have a cluster of variants that consumers rarely tell apart.

### 5. Keep `context`, `name`, `message`, `cause` key names

**Status: Accepted**

- `name`: Standard JS `Error.name`. Discriminator for tagged unions.
- `message`: Standard JS `Error.message`. Always `string`, always present. Computed by template.
- `context`: Structured payload. Aligns with structured logging conventions ("context" = structured key-value pairs attached to events).
- `cause`: ES2022 `Error.cause`. Error chain.

### 6. Error granularity guidelines

**Status: Accepted**

- **Split** when consumers handle failures differently (not found -> 404, permission denied -> login prompt)
- **Don't split** when the consumer's response is always the same (various DB driver errors -> generic toast)
- Use union context (decision 4) for intra-error variants that don't need name-level discrimination
- Aim for 2-5 error types per service

## Complete API Example

```typescript
import { createTaggedError } from 'wellcrafted/error';

// --- Error definitions ---

// Simple error: no context, static message
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

// Error with context: structured data, template message
const { RecorderDeviceError, RecorderDeviceErr } = createTaggedError('RecorderDeviceError')
  .withContext<{ deviceId: string; deviceName: string }>()
  .withMessage(({ context }) => `Failed to acquire stream from '${context.deviceName}'`);

// Error with context and cause: full chain
const { TranscriptionError, TranscriptionErr } = createTaggedError('TranscriptionError')
  .withContext<{ model: string; recordingId: string }>()
  .withCause<RecorderServiceError | undefined>()
  .withMessage(({ context, cause }) =>
    cause
      ? `Transcription failed for model '${context.model}': ${cause.message}`
      : `Transcription failed for model '${context.model}'`
  );

// Error with context: permission failure
const { RecorderPermissionError, RecorderPermissionErr } = createTaggedError('RecorderPermissionError')
  .withContext<{ device: string }>()
  .withMessage(({ context }) => `Microphone permission denied for ${context.device}`);

// Union type for the service
type RecorderServiceError =
  | RecorderBusyError
  | RecorderDeviceError
  | RecorderPermissionError;

// --- Call sites ---

// Just context: message auto-computes from template
RecorderDeviceErr({ context: { deviceId: 'abc', deviceName: 'Blue Yeti' } });
// -> { name: 'RecorderDeviceError', message: "Failed to acquire stream from 'Blue Yeti'",
//    context: { deviceId: 'abc', deviceName: 'Blue Yeti' } }

// No context needed
RecorderBusyErr({});
// -> { name: 'RecorderBusyError', message: 'A recording is already in progress' }

// With cause
TranscriptionErr({
  context: { model: 'whisper-large', recordingId: '456' },
  cause: RecorderDeviceError({ context: { deviceId: 'abc', deviceName: 'Blue Yeti' } }),
});

// Message override
RecorderDeviceErr({
  message: 'Custom: device disconnected mid-recording',
  context: { deviceId: 'abc', deviceName: 'Blue Yeti' },
});

// --- JSON serialization: just works ---
const error = RecorderDeviceError({ context: { deviceId: 'abc', deviceName: 'Blue Yeti' } });
JSON.stringify(error);
// -> {"name":"RecorderDeviceError","message":"Failed to acquire stream from 'Blue Yeti'","context":{"deviceId":"abc","deviceName":"Blue Yeti"}}

// --- Type extraction ---
type RecorderDeviceError = ReturnType<typeof RecorderDeviceError>;
// { readonly name: 'RecorderDeviceError'; readonly message: string;
//   readonly context: { deviceId: string; deviceName: string } }
```

## Runtime Implementation Sketch

The current `createTaggedError` runtime is minimal: `withContext`/`withCause` are no-ops that re-invoke `createBuilder()`. The new implementation adds `.withMessage()` as the terminal step that captures the template function:

```typescript
function createTaggedError(name) {
  const createBuilder = () => ({
    withContext() { return createBuilder(); },
    withCause() { return createBuilder(); },
    withMessage(fn) {
      const errorConstructor = (input) => ({
        name,
        message: input.message ?? fn({
          name,
          ...('context' in input ? { context: input.context } : {}),
          ...('cause' in input ? { cause: input.cause } : {}),
        }),
        ...('context' in input ? { context: input.context } : {}),
        ...('cause' in input ? { cause: input.cause } : {}),
      });
      const errName = name.replace(/Error$/, 'Err');
      return {
        [name]: errorConstructor,
        [errName]: (input) => Err(errorConstructor(input)),
      };
    },
  });
  return createBuilder();
}
```

No `deriveMessageFromName` function. The callback is always required, so there's no auto-derivation path to implement.

## Impact on Existing Layers

### Service Layer
- All error definitions must end with `.withMessage(fn)`: callback is required
- Call sites provide `context` (and optionally `cause`), not `message`
- `message` override available for one-off cases

### Query Layer (`WhisperingError`)
- `serviceError.message` extraction continues to work: always present
- Structured `context` enables richer "more details" displays

### Actions/Display Layer
- No changes needed

## Migration Strategy

1. **Update wellcrafted**: Add `.withMessage(fn)` as terminal builder method (callback required), make factories only available after `.withMessage()`, add `JsonObject` constraint on context, remove any auto-derivation code
2. **Migrate all existing errors**: Every `createTaggedError` call must add `.withMessage(fn)`. For monolithic errors being kept as-is temporarily, use `.withMessage(() => 'description of what went wrong')`.
3. **Break up monolithic errors**: One service at a time, starting with `DbService`
4. **Update call sites**: Replace `{ message: '...' }` with `{ context: { ... } }`
