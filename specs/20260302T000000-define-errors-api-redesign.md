# Migrate to defineErrors v2: Rust-style Namespaced Errors

**Created**: 2026-03-02
**Status**: Implemented
**Depends on**: wellcrafted `0.33.0` shipping `defineErrors` v2 (replaces `createTaggedError`)
**Partially supersedes**: `20260226T000000-granular-error-migration.md` (definition-site patterns only; the per-service granularity decisions in that spec remain valid)
**Scope**: All error definitions in apps/whispering, apps/epicenter, packages/epicenter, packages/svelte-utils

> **⚠️ Note on `cause` pattern**: This spec was written when `cause` was typed as `string` and call sites used `extractErrorMessage(error)`. The current pattern types `cause` as `unknown` and calls `extractErrorMessage(cause)` inside the constructor's message template. Call sites pass `{ cause: error }` (the raw caught error). See `20260302T200000-split-sub-discriminant-errors.md` and the `services-layer` skill for the updated pattern.

## Summary

Once wellcrafted publishes `defineErrors` v2, migrate all 24 error definitions in this monorepo from `createTaggedError` builder chains to Rust-style namespaced `defineErrors`. This migration touches **both definition sites AND call sites**: every `FooServiceErr({...})` becomes `FooError.Variant({...})`.

The key changes:
- Short variant names under a namespace (`HttpError.Connection` not `ConnectionErr`)
- Factories return `Err<...>` directly (no dual `FooError`/`FooErr` factories)
- `InferError<typeof HttpError.Connection>` extracts a single error type
- `InferErrors<typeof HttpError>` extracts the union of all variants
- Value and type share the same name (`const HttpError` + `type HttpError`)

## Prerequisites

1. wellcrafted publishes `0.33.0` with `defineErrors` v2, `InferError`, `InferErrors` exported from `wellcrafted/error`
2. `createTaggedError`, `TaggedError`, `InferErrorUnion` are removed from wellcrafted
3. `bun update wellcrafted` in this monorepo

## New API Quick Reference

```typescript
import { defineErrors, type InferError, type InferErrors } from 'wellcrafted/error';

const HttpError = defineErrors({
  // Each value is a constructor function: input → error body
  // defineErrors stamps `name` from the key (e.g., 'Connection'),
  // freezes the result, and returns Err<...> directly.

  Connection: ({ cause }: { cause: unknown }) => ({
    message: `Failed to connect to the server: ${extractErrorMessage(cause)}`,
    cause,
  }),

  Response: ({ status, bodyMessage }: { status: number; bodyMessage?: string }) => ({
    message: bodyMessage ? `HTTP ${status}: ${bodyMessage}` : `HTTP ${status} response`,
    status,
    bodyMessage,
  }),

  Parse: ({ cause }: { cause: unknown }) => ({
    message: `Failed to parse response body: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

// Value and type share the same name (like class declarations)
type HttpError = InferErrors<typeof HttpError>;

// Individual error types extracted from the factory directly
type ConnectionError = InferError<typeof HttpError.Connection>;
type ResponseError = InferError<typeof HttpError.Response>;
type ParseError = InferError<typeof HttpError.Parse>;
```

### What changed from `createTaggedError`

| Before | After |
|--------|-------|
| `.withFields<{ status: number }>()` | Function parameter: `({ status }: { status: number })` |
| `.withMessage(({ status }) => ...)` | Part of the function body: `=> ({ message: ..., status })` |
| `ReturnType<typeof FooError>` | `InferError<typeof Namespace.Variant>` |
| Manual `A \| B \| C` union | `InferErrors<typeof Namespace>` |
| `{ FooError, FooErr }` destructuring | `Namespace.Variant` dot access |
| `FooErr({ ... })` call site | `Namespace.Variant({ ... })` call site |
| `name` stamped as `'FooError'` | `name` stamped as short key (e.g., `'Connection'`) |
| 4 modes (bare, fields, message, fields+message) | One pattern: a function |

### Every pattern is just a function

```typescript
// Static message, no input
Busy: () => ({ message: 'A recording is already in progress' }),

// Computed message from fields
Service: ({ operation, cause }: { ... }) => ({
  message: `Failed to ${operation} autostart: ${cause}`, operation, cause,
}),

// Message at call site
Service: ({ message }: { message: string }) => ({ message }),

// Fields + call-site message
Service: ({ operation, message }: { ... }) => ({ message, operation }),

// Complex logic
InvalidAccelerator: (input: { reason: ...; accelerator?: string }) => {
  return { message: messages[input.reason], ...input };
},
```

### Call sites change

```typescript
// BEFORE (v1 / createTaggedError):
AutostartServiceErr({ operation: 'check', cause: extractErrorMessage(error) })
ResponseErr({ status: 404 })
ConnectionErr({ cause: extractErrorMessage(error) })

// AFTER (v2 / defineErrors namespaced: cause: unknown, extractErrorMessage in constructor):
AutostartError.Service({ operation: 'check', cause: error })
HttpError.Response({ status: 404 })
HttpError.Connection({ cause: error })
```

### Discrimination changes

```typescript
// BEFORE: if (error.name === 'ConnectionError')
// AFTER:  if (error.name === 'Connection')
```

---

## Migration Catalog

For each file: the current definition, the v2 replacement, and call site changes. The implementing agent should verify each conversion produces the correct factory signature and update all call sites.

---

### 1. HTTP service errors (grouped: the model)

**File**: `apps/whispering/src/lib/services/isomorphic/http/types.ts`

**Before**:
```typescript
export const { ConnectionError, ConnectionErr } = createTaggedError('ConnectionError')
  .withFields<{ cause: string }>()
  .withMessage(({ cause }) => `Failed to connect to the server: ${cause}`);
type ConnectionError = ReturnType<typeof ConnectionError>;

export const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withFields<{ status: number; bodyMessage?: string }>()
  .withMessage(({ status, bodyMessage }) =>
    bodyMessage ? `HTTP ${status}: ${bodyMessage}` : `HTTP ${status} response`,
  );
export type ResponseError = ReturnType<typeof ResponseError>;

export const { ParseError, ParseErr } = createTaggedError('ParseError')
  .withFields<{ cause: string }>()
  .withMessage(({ cause }) => `Failed to parse response body: ${cause}`);
export type ParseError = ReturnType<typeof ParseError>;

export type HttpServiceError = ConnectionError | ResponseError | ParseError;
```

**After**:
```typescript
export const HttpError = defineErrors({
  Connection: ({ cause }: { cause: string }) => ({
    message: `Failed to connect to the server: ${cause}`,
    cause,
  }),
  Response: ({ status, bodyMessage }: { status: number; bodyMessage?: string }) => ({
    message: bodyMessage ? `HTTP ${status}: ${bodyMessage}` : `HTTP ${status} response`,
    status,
    bodyMessage,
  }),
  Parse: ({ cause }: { cause: string }) => ({
    message: `Failed to parse response body: ${cause}`,
    cause,
  }),
});

export type HttpError = InferErrors<typeof HttpError>;
export type ConnectionError = InferError<typeof HttpError.Connection>;
export type ResponseError = InferError<typeof HttpError.Response>;
export type ParseError = InferError<typeof HttpError.Parse>;
```

**Call site changes**:
```typescript
// BEFORE: ConnectionErr({ cause: extractErrorMessage(error) })
// AFTER:  HttpError.Connection({ cause: extractErrorMessage(error) })

// BEFORE: ResponseErr({ status: response.status })
// AFTER:  HttpError.Response({ status: response.status })

// BEFORE: ParseErr({ cause: extractErrorMessage(error) })
// AFTER:  HttpError.Parse({ cause: extractErrorMessage(error) })
```

**Discrimination changes**:
```typescript
// BEFORE: error.name === 'ConnectionError'
// AFTER:  error.name === 'Connection'
```

**Type reference changes**:
```typescript
// BEFORE: HttpServiceError
// AFTER:  HttpError
```

---

### 2. Global shortcut errors (grouped, mixed complexity)

**File**: `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`

**After**:
```typescript
const ShortcutError = defineErrors({
  InvalidAccelerator: (input: {
    reason: 'invalid_format' | 'no_key_code' | 'multiple_key_codes' | 'generated_invalid';
    accelerator?: string;
  }) => {
    const messages = {
      invalid_format: `Invalid accelerator format: '${input.accelerator}'. Must follow Electron accelerator specification.`,
      no_key_code: 'No valid key code found in pressed keys',
      multiple_key_codes: 'Multiple key codes not allowed in accelerator',
      generated_invalid: `Generated invalid accelerator: ${input.accelerator}`,
    } as const;
    return { message: messages[input.reason], ...input };
  },

  Service: ({ operation, accelerator, cause }: {
    operation: 'register' | 'unregister' | 'unregisterAll';
    accelerator?: string;
    cause: string;
  }) => ({
    message: operation === 'unregisterAll'
      ? `Failed to unregister all global shortcuts: ${cause}`
      : `Failed to ${operation} global shortcut '${accelerator}': ${cause}`,
    operation,
    accelerator,
    cause,
  }),
});

type ShortcutError = InferErrors<typeof ShortcutError>;
type InvalidAcceleratorError = InferError<typeof ShortcutError.InvalidAccelerator>;
type GlobalShortcutServiceError = InferError<typeof ShortcutError.Service>;
```

**Call site changes**:
```typescript
// BEFORE: InvalidAcceleratorErr({ reason: 'invalid_format', accelerator })
// AFTER:  ShortcutError.InvalidAccelerator({ reason: 'invalid_format', accelerator })

// BEFORE: GlobalShortcutServiceErr({ operation: 'register', accelerator, cause: extractErrorMessage(error) })
// AFTER:  ShortcutError.Service({ operation: 'register', accelerator, cause: extractErrorMessage(error) })
```

**Discrimination changes**:
```typescript
// BEFORE: error.name === 'InvalidAcceleratorError'
// AFTER:  error.name === 'InvalidAccelerator'

// BEFORE: error.name === 'GlobalShortcutServiceError'
// AFTER:  error.name === 'Service'
```

---

### 3. Device stream error (complex switch)

**File**: `apps/whispering/src/lib/services/isomorphic/device-stream.ts`

**After**:
```typescript
const DeviceStreamError = defineErrors({
  Service: (input: {
    errorKind: 'permission_denied' | 'device_connection_failed' | 'enumeration_failed' | 'no_devices_available';
    underlyingError?: string;
    deviceId?: string;
    hadPreferredDevice?: boolean;
  }) => {
    const suffix = input.underlyingError ? ` ${input.underlyingError}` : '';
    const messages = {
      permission_denied: `We need permission to see your microphones. Check your browser settings and try again.${suffix}`,
      device_connection_failed: `Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions.${suffix}`,
      enumeration_failed: 'Error enumerating recording devices. Please make sure you have given permission to access your audio devices.',
      no_devices_available: input.hadPreferredDevice
        ? "We couldn't connect to any microphones. Make sure they're plugged in and try again!"
        : "Hmm... We couldn't find any microphones to use. Check your connections and try again!",
    } as const;
    return { message: messages[input.errorKind], ...input };
  },
});
type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
```

**Call site changes**:
```typescript
// BEFORE: DeviceStreamServiceErr({ errorKind: 'permission_denied', underlyingError: extractErrorMessage(error) })
// AFTER:  DeviceStreamError.Service({ errorKind: 'permission_denied', underlyingError: extractErrorMessage(error) })
```

---

### 4. Simple services with fields + sealed message

Each of these follows the same pattern: single-variant namespace with computed message.

**`apps/whispering/src/lib/services/desktop/autostart.ts`**:
```typescript
export const AutostartError = defineErrors({
  Service: ({ operation, cause }: {
    operation: 'check' | 'enable' | 'disable';
    cause: string;
  }) => ({
    message: `Failed to ${operation} autostart: ${cause}`,
    operation,
    cause,
  }),
});
export type AutostartError = InferErrors<typeof AutostartError>;
```

Call site: `AutostartError.Service({ operation: 'check', cause: extractErrorMessage(error) })`

**`apps/whispering/src/lib/services/desktop/command.ts`**:
```typescript
export const CommandError = defineErrors({
  Service: ({ operation, cause }: {
    operation: 'execute' | 'spawn';
    cause: string;
  }) => ({
    message: `Failed to ${operation} command: ${cause}`,
    operation,
    cause,
  }),
});
export type CommandError = InferErrors<typeof CommandError>;
```

Call site: `CommandError.Service({ operation: 'execute', cause: extractErrorMessage(error) })`

**`apps/whispering/src/lib/services/desktop/ffmpeg.ts`**:
```typescript
export const FfmpegError = defineErrors({
  Service: ({ operation, cause }: { operation: string; cause: string }) => ({
    message: `Failed to ${operation}: ${cause}`,
    operation,
    cause,
  }),
});
export type FfmpegError = InferErrors<typeof FfmpegError>;
```

Call site: `FfmpegError.Service({ operation: 'compress audio', cause: extractErrorMessage(error) })`

**`apps/whispering/src/lib/services/desktop/fs.ts`**:
```typescript
export const FsError = defineErrors({
  Service: ({ operation, paths, cause }: {
    operation: string;
    paths: string | string[];
    cause: string;
  }) => {
    const pathStr = Array.isArray(paths) ? paths.join(', ') : paths;
    return {
      message: `Failed to ${operation}: ${pathStr}: ${cause}`,
      operation,
      paths,
      cause,
    };
  },
});
export type FsError = InferErrors<typeof FsError>;
```

Call site: `FsError.Service({ operation: 'read file as Blob', paths: path, cause: extractErrorMessage(error) })`

**`apps/whispering/src/lib/services/desktop/permissions.ts`**:
```typescript
export const PermissionsError = defineErrors({
  Service: ({ action, permissionType, cause }: {
    action: 'check' | 'request';
    permissionType: 'accessibility' | 'microphone';
    cause: string;
  }) => ({
    message: `Failed to ${action} ${permissionType} permissions: ${cause}`,
    action,
    permissionType,
    cause,
  }),
});
export type PermissionsError = InferErrors<typeof PermissionsError>;
```

Call site: `PermissionsError.Service({ action: 'check', permissionType: 'accessibility', cause: extractErrorMessage(error) })`

**`apps/whispering/src/lib/services/desktop/tray.ts`**:
```typescript
export const TrayError = defineErrors({
  SetIcon: ({ cause }: { cause: string }) => ({
    message: `Failed to set tray icon: ${cause}`,
    cause,
  }),
});
export type TrayError = InferErrors<typeof TrayError>;
```

Call site: `TrayError.SetIcon({ cause: extractErrorMessage(error) })`

---

### 5. Bare errors (message at call site)

These all follow the same minimal pattern: message provided by the caller:

```typescript
const FooError = defineErrors({
  Service: ({ message }: { message: string }) => ({ message }),
});
export type FooError = InferErrors<typeof FooError>;
```

**Files to update**:
- `apps/whispering/src/lib/services/isomorphic/analytics/types.ts`:
  `AnalyticsError.Service({ message: '...' })` (was `AnalyticsServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/completion/types.ts`:
  `CompletionError.Service({ message: '...' })` (was `CompletionServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/db/types.ts`:
  `DbError.Service({ message: '...' })` (was `DbServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/download/types.ts`:
  `DownloadError.Service({ message: '...' })` (was `DownloadServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/notifications/types.ts`:
  `NotificationError.Service({ message: '...' })` (was `NotificationServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/recorder/types.ts`:
  `RecorderError.Service({ message: '...' })` (was `RecorderServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/sound/types.ts`:
  `SoundError.Play({ message: '...' })` (was `PlaySoundServiceErr`)
- `apps/whispering/src/lib/services/isomorphic/text/types.ts`:
  `TextError.Service({ message: '...' })` (was `TextServiceErr`)
- `apps/epicenter/src/lib/workspaces/dynamic/queries.ts`:
  `WorkspaceError.Failed({ message: '...' })` (was `WorkspaceErr`)
- `apps/epicenter/src/lib/workspaces/static/queries.ts`:
  `StaticWorkspaceError.Failed({ message: '...' })` (was `StaticWorkspaceErr`)

---

### 6. Fields without sealed message

**`apps/whispering/src/lib/query/isomorphic/transformer.ts`**:
```typescript
export const TransformError = defineErrors({
  Service: ({ operation, message }: {
    operation: 'validate_input' | 'validate_steps' | 'db_create_run'
      | 'db_add_step' | 'db_fail_step' | 'db_complete_step' | 'db_complete_run';
    message: string;
  }) => ({
    message,
    operation,
  }),
});
export type TransformError = InferErrors<typeof TransformError>;
```

Call site: `TransformError.Service({ operation: 'validate_input', message: 'Empty input...' })`

---

### 7. Packages

**`packages/epicenter/src/shared/errors.ts`**:
```typescript
export const ExtensionError = defineErrors({
  Operation: (input: {
    tableName?: string;
    rowId?: string;
    filename?: string;
    filePath?: string;
    directory?: string;
    operation?: string;
  }) => ({
    message: input.operation
      ? `Extension operation '${input.operation}' failed`
      : 'An extension operation failed',
    ...input,
  }),
});
export type ExtensionError = InferErrors<typeof ExtensionError>;
```

Call site: `ExtensionError.Operation({ tableName: '...', operation: 'insert' })`

**`packages/svelte-utils/src/createPersistedState.svelte.ts`**:
```typescript
const ParseError = defineErrors({
  Json: ({ value, parseError }: { value: string; parseError: string }) => ({
    message: `Failed to parse JSON for value "${value.slice(0, 100)}...": ${parseError}`,
    value,
    parseError,
  }),
});
type ParseError = InferErrors<typeof ParseError>;
```

Call site: `ParseError.Json({ value, parseError: extractErrorMessage(e) })`

---

## Naming Convention

The v2 API follows Rust's `thiserror` pattern:

```
┌──────────────────────────────────────────────────────────────┐
│  Namespace (singular noun)  │  Variant (short discriminant)  │
├─────────────────────────────┼────────────────────────────────┤
│  HttpError                  │  .Connection                   │
│  HttpError                  │  .Response                     │
│  HttpError                  │  .Parse                        │
│  ShortcutError              │  .InvalidAccelerator           │
│  ShortcutError              │  .Service                      │
│  AutostartError             │  .Service                      │
│  DbError                    │  .Service                      │
│  TrayError                  │  .SetIcon                      │
│  ParseError                 │  .Json                         │
└─────────────────────────────┴────────────────────────────────┘
```

- **Namespace**: Drop the `Service` suffix. `AutostartServiceError` → `AutostartError`. `FfmpegServiceError` → `FfmpegError`.
- **Variant**: Describes the failure mode. For single-variant services, `Service` is fine. For more specific cases: `SetIcon`, `Json`, `InvalidAccelerator`.
- **`name` stamp**: The variant name (e.g., `'Connection'`, `'Service'`, `'SetIcon'`).

## Mechanical changes checklist

For each file:

- [ ] Replace `import { createTaggedError } from 'wellcrafted/error'` with `import { defineErrors, type InferError, type InferErrors } from 'wellcrafted/error'`
- [ ] Convert builder chain to constructor function inside `defineErrors({})`
- [ ] Choose namespace name (drop `Service` suffix) and short variant name
- [ ] Replace `type FooError = ReturnType<typeof FooError>` with `type FooError = InferErrors<typeof FooError>`
- [ ] For individual variant types: `type ConnectionError = InferError<typeof HttpError.Connection>`
- [ ] **Update all call sites**: `FooServiceErr({...})` → `FooError.Variant({...})`
- [ ] **Update all discrimination**: `error.name === 'FooServiceError'` → `error.name === 'Variant'`
- [ ] **Update type references**: `FooServiceError` → `FooError` in function signatures, union types, generics

## Implementation order

1. [x] **Update wellcrafted**: `bun update wellcrafted` to `0.33.0`
2. [x] **Migrate grouped errors first** (biggest win from namespacing):
   - [x] `http/types.ts` (3 errors → `HttpError` with 3 variants) + consumers `desktop.ts`, `web.ts`, `index.ts`
   - [x] `global-shortcut-manager.ts` (2 errors → `ShortcutError` with 2 variants)
3. [x] **Migrate services with fields + sealed message** (definition + call site changes):
   - [x] `autostart.ts`, `command.ts`, `ffmpeg.ts`, `fs.ts`, `permissions.ts`, `tray.ts`, `device-stream.ts`
   - [x] `os/types.ts` (not in original spec: discovered during audit)
   - [x] `local-shortcut-manager.ts` (not in original spec: discovered during audit)
4. [x] **Migrate bare errors** (definition + call site changes):
   - [x] DbError, CompletionError, RecorderError (60+ call sites across 18 files)
   - [x] TextError, AnalyticsError, NotificationError, DownloadError, SoundError (23 files)
5. [x] **Migrate packages**:
   - [x] `packages/epicenter/src/shared/errors.ts` (ExtensionError.Operation)
   - [x] `packages/svelte-utils/src/createPersistedState.svelte.ts` (ParseError.Json)
6. [x] **Migrate query layer**:
   - [x] `transformer.ts` (TransformError.Service)
   - [x] `dynamic/queries.ts` (WorkspaceError.Failed)
   - [x] `static/queries.ts` (StaticWorkspaceError.Failed)

## Verification

1. `bun run typecheck`: no type errors across the monorepo
2. `bun run build`: build succeeds for all apps/packages
3. Spot-check: for 3-4 migrated files, verify the factory's return type matches the expected shape (same `message`, and field types, but `name` is now the short variant key)
4. **Every call site must be updated**: grep for old names (`FooServiceErr`, `FooServiceError(`) to ensure no stragglers
5. **Every discrimination must be updated**: grep for old `name` checks (`=== 'FooServiceError'`)

## Notes for implementing agent

- **Call sites MUST change.** Every `FooServiceErr({...})` becomes `Namespace.Variant({...})`. Every `error.name === 'FooServiceError'` becomes `error.name === 'Variant'`.
- **Use `...input` spread** for errors with many fields to avoid repetition. For errors with 1-2 fields, explicit listing is fine.
- **`InferErrors` replaces manual unions.** For multi-variant namespaces, `type HttpError = InferErrors<typeof HttpError>` is the union.
- **`InferError` takes the factory directly.** `InferError<typeof HttpError.Connection>`: no string key.
- **Keep `extractErrorMessage` imports.** That utility is unchanged.
- **`name` is auto-stamped as the short variant key.** Do not include `name` in the constructor return: `defineErrors` adds it.
- The per-service granularity decisions from `20260226T000000-granular-error-migration.md` (whether to split `RecorderServiceError` into `RecorderBusyError` + `RecorderStartError`, etc.) remain valid and are not affected by this API change. This spec only changes how errors are defined, not which errors exist.
- **Errors are `Readonly` and `Object.freeze`d.** This is automatic.
- **Every factory returns `Err<...>` directly.** No need for `Err()` wrapping at call sites.

## Review

**Completed**: 2026-03-02
**Branch**: braden-w/review-service-errors

### Summary

Migrated all 24+ error definitions from `createTaggedError` builder chains to `defineErrors` v2 namespaced API. This included updating ~150+ call sites across 50+ files, fixing discrimination checks (`error.name === 'FooServiceError'` → `error.name === 'Variant'`), and updating all type references.

### Deviations from Spec

- **Two additional definition files discovered**: `os/types.ts` (OsError) and `local-shortcut-manager.ts` (LocalShortcutError) were not in the original spec but used `createTaggedError` and needed migration.
- **`TaggedError` generic removed from wellcrafted 0.33.0**: `WhisperingError` in `result.ts` and `LoggableError` in `error-logger.ts` depended on `TaggedError<T>` which was removed. Fixed to use `AnyTaggedError` + explicit literal `name` type.
- **`context` property removed**: The old `createTaggedError` wrapped fields in a `context` object. `defineErrors` v2 puts fields at the top level. Fixed `deepgram.ts` and `speaches.ts` which destructured `context: { status }` → now just `{ status }`.
- **Discrimination in `delivery.ts`**: After migration, `TextError` has `name: 'Service'` which is less specific than the old `'TextServiceError'`. The narrowing still works correctly via discriminated union with `WhisperingError`'s literal `name: 'WhisperingError'`.

### Follow-up Work

- The `WhisperingError` pattern in `result.ts` still uses manual construction rather than `defineErrors`. Consider migrating it for consistency (out of scope: it doesn't use `createTaggedError`).
- Pre-existing type errors in `packages/ui` (Record type args), `+page.svelte` (void/Promise mismatch), `packages/filesystem` (FileId), `apps/demo-mcp` (DrizzleDb) are unrelated to this migration.
