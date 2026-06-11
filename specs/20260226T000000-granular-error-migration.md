# Granular Error Migration: Service-by-Service Migration

**Created**: 2026-02-26
**Updated**: 2026-02-27
**Status**: Active
**Depends on**: `wellcrafted/specs/20260226T233600-tagged-error-minimal-design.md` (API design)
**Supersedes**: `20260225T000000-tagged-error-redesign.md` (draft)
**Scope**: All service error migrations in apps/whispering and apps/epicenter

> **⚠️ Note on `extractErrorMessage` at call sites**: This spec shows `extractErrorMessage(error)` being called at call sites and embedded in message strings. The current pattern passes raw `cause: error` to constructors and calls `extractErrorMessage(cause)` inside the constructor's message template. See the `services-layer` skill for the updated pattern.

## Summary

Migrate service errors from monolithic `{ message: "..." }` patterns to the final `createTaggedError` API: flat fields, sealed `.withMessage()` for predictable messages, and call-site `message` for dynamic errors.

This spec covers the **epicenter-side migration only**. The wellcrafted API redesign (flat `TaggedError`, `.withFields()`, no `.withCause()`) is specified in the wellcrafted repo's minimal design spec.

## Prerequisites

Before migrating epicenter services:

1. New `createTaggedError` API implemented and published in wellcrafted
2. Wellcrafted dependency updated in the epicenter monorepo

## New API Quick Reference

See the wellcrafted minimal design spec for full details. Summary of what changed:

```typescript
// Old: nested context, message override
createTaggedError('ResponseError')
  .withContext<{ status: number }>()
  .withMessage(({ context }) => `HTTP ${context.status}`)
ResponseErr({ message: 'custom', context: { status: 404 } })

// New: flat fields, sealed message from template
createTaggedError('ResponseError')
  .withFields<{ status: number }>()
  .withMessage(({ status }) => `HTTP ${status}`)
ResponseErr({ status: 404 })  // message: "HTTP 404", no message input exists
```

The full API surface:

```typescript
createTaggedError('XError')                                    → factory({ message })
createTaggedError('XError').withMessage(fn)                    → factory()
createTaggedError('XError').withFields<F>()                    → factory({ message, ...fields })
createTaggedError('XError').withFields<F>().withMessage(fn)    → factory({ ...fields })
```

- `.withContext()` → `.withFields()` (flat on the error object)
- `.withCause()` → removed (use a typed field if needed)
- `.withMessage()` is **optional**: when present, it **seals** the message (no override)
- Without `.withMessage()`: `message` is required at the call site
- With `.withMessage()`: `message` is NOT in the input type: the template owns it entirely

---

## Design Principles

1. **Name errors by failure mode, not by service.** `RecorderBusyError`, not `RecorderServiceError`.
2. **Union type keeps the service name.** `type RecorderServiceError = RecorderBusyError | RecorderDeviceError | ...`
3. **Split only when callers handle failure modes differently.** Don't create separate error types just for different messages: let the call site provide the message.
4. **Small services can keep one error.** A 3-call-site service doesn't need 3 error types. One error with call-site `message` is fine.
5. **Fields must be JSON-serializable** (`JsonObject`). No `Date`, no `Error` instances, no class instances.

## Deciding Per Error Type

Two questions replace the old three-tier model:

1. **Does this error have useful typed fields for programmatic handling?** → `.withFields<...>()`
2. **Is the message predictable from those fields (or always static)?** → `.withMessage(fn)`

This produces three natural shapes:

**Static message, no fields**: `.withMessage()` with static string:
```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');
RecorderBusyErr()
```

**Structured fields with computed message**: `.withFields<F>().withMessage(fn)`:
```typescript
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withFields<{ status: number }>()
  .withMessage(({ status }) => `HTTP ${status}`);
ResponseErr({ status: 404 })
```

**Dynamic message, no useful fields**: no `.withMessage()`, message at call site:
```typescript
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError');
FsServiceErr({ message: `Failed to read '${path}': ${extractErrorMessage(error)}` })
```

### Why `reason: string` is not a convention

The previous version of this spec proposed `reason: string` as a reserved field meaning "the output of `extractErrorMessage(error)`." This is rejected.

`reason` is just `message` laundered through a field. If every error is `{ reason: string }` with a template of `({ reason }) => 'X failed: ${reason}'`, the template is doing nothing useful. It's prepending a static string that the call site could include in `message` directly.

With `message` as a call-site input, the need for `reason` disappears:
- Errors with predictable messages → use `.withMessage()` as a default
- Errors with dynamic messages → call site passes `message` directly
- No intermediate `reason` field needed in either case

If an error type has a specific named field that happens to be called `reason` for domain-specific purposes, that's fine. It's just a field. But `reason` as a codebase-wide convention for "the stringified caught error" doesn't carry its weight.

### Pattern to follow

The HTTP service is the model:

```typescript
// Static message: callers never need to customize
const { ConnectionError, ConnectionErr } = createTaggedError('ConnectionError')
  .withMessage(() => 'Failed to connect to the server');

// Structured fields: `status` is useful for programmatic handling
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withFields<{ status: number }>()
  .withMessage(({ status }) => `HTTP ${status} response`);

// Static message
const { ParseError, ParseErr } = createTaggedError('ParseError')
  .withMessage(() => 'Failed to parse response body');

type HttpServiceError = ConnectionError | ResponseError | ParseError;

// Call sites
ConnectionErr()                    // static message, no args
ResponseErr({ status: 404 })       // structured fields, computed message
ParseErr()                         // static message, no args
```

---

## Migration Catalog

For each service below: the current monolithic error, the proposed granular errors, and what call sites should look like after migration.

**Important**: The proposed errors below are suggestions based on analyzing current call sites. The implementing agent should read each file and may adjust error names, field types, or groupings based on what makes sense.

---

### 1. RecorderServiceError (LARGEST: ~25 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/recorder/types.ts`
**Call sites**: `navigator.ts`, `desktop/recorder/cpal.ts`, `desktop/recorder/ffmpeg.ts`

**Current**:
```typescript
const { RecorderServiceError, RecorderServiceErr } = createTaggedError('RecorderServiceError')
  .withMessage(() => 'A recording operation failed');
```

**Proposed errors**:
```typescript
// Static: callers show "already recording" UI
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

// Structured: selectedDeviceId is useful for UI ("try selecting a different mic")
const { RecorderDeviceNotFoundError, RecorderDeviceNotFoundErr } = createTaggedError('RecorderDeviceNotFoundError')
  .withFields<{ selectedDeviceId: string | null }>()
  .withMessage(({ selectedDeviceId }) =>
    selectedDeviceId
      ? `Could not find selected microphone '${selectedDeviceId}'. Make sure it's connected.`
      : 'No microphones found. Make sure a microphone is connected.'
  );

// Dynamic message: call site knows what went wrong during start
const { RecorderStartError, RecorderStartErr } = createTaggedError('RecorderStartError');

// Dynamic message: call site knows what went wrong during stop
const { RecorderStopError, RecorderStopErr } = createTaggedError('RecorderStopError');

// Structured: operation + path are useful for debugging
const { RecorderFileError, RecorderFileErr } = createTaggedError('RecorderFileError')
  .withFields<{ operation: string; path?: string }>()
  .withMessage(({ operation, path }) =>
    path
      ? `Failed to ${operation} recording file: ${path}`
      : `Failed to ${operation} recording file`
  );

// Static
const { RecorderDeviceEnumerationError, RecorderDeviceEnumerationErr } = createTaggedError('RecorderDeviceEnumerationError')
  .withMessage(() => 'Failed to enumerate recording devices');

type RecorderServiceError =
  | RecorderBusyError
  | RecorderDeviceNotFoundError
  | RecorderStartError
  | RecorderStopError
  | RecorderFileError
  | RecorderDeviceEnumerationError;
```

**Example call site migration**:
```typescript
// Before
RecorderServiceErr({ message: 'A recording is already in progress.' })
// After: static default
RecorderBusyErr()

// Before
RecorderServiceErr({ message: `Failed to initialize the audio recorder. ${extractErrorMessage(error)}` })
// After: call site provides message
RecorderStartErr({ message: `Failed to initialize the audio recorder. ${extractErrorMessage(error)}` })

// Before
RecorderServiceErr({ message: `Unable to read recording file: ${error.message}` })
// After: structured fields compute message
RecorderFileErr({ operation: 'read', path: filePath })
```

---

### 2. CompletionServiceError (~30 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/completion/types.ts`
**Call sites**: `anthropic.ts`, `groq.ts`, `google.ts`, `openai-compatible.ts`, `custom.ts`

**Current**:
```typescript
const { CompletionServiceError, CompletionServiceErr } = createTaggedError('CompletionServiceError')
  .withMessage(() => 'A completion operation failed');
```

**Proposed errors**:

```typescript
// Structured: provider + statusCode useful for retry logic and user guidance
const { CompletionApiError, CompletionApiErr } = createTaggedError('CompletionApiError')
  .withFields<{ provider: string; statusCode: number }>()
  .withMessage(({ provider, statusCode }) =>
    `${provider} API error (${statusCode})`
  );

// Dynamic message: connection failures have varied context
const { CompletionConnectionError, CompletionConnectionErr } = createTaggedError('CompletionConnectionError')
  .withFields<{ provider: string }>()
  .withMessage(({ provider }) => `Failed to connect to ${provider}`);

// Dynamic message: config issues are specific ("missing API key", "invalid base URL", etc.)
const { CompletionConfigError, CompletionConfigErr } = createTaggedError('CompletionConfigError')
  .withFields<{ provider: string }>();

type CompletionServiceError =
  | CompletionApiError
  | CompletionConnectionError
  | CompletionConfigError;
```

**Example call site migration**:
```typescript
// Before (in anthropic.ts, handling 401)
CompletionServiceErr({ message: 'Invalid API key. Check your Anthropic API key.' })
// After: statusCode is structured, template computes message
CompletionApiErr({ provider: 'Anthropic', statusCode: 401 })
// message: "Anthropic API error (401)"

// Before (in openai-compatible.ts, handling connection error)
CompletionServiceErr({ message: `Failed to connect: ${extractErrorMessage(error)}` })
// After: provider is structured, template computes message
CompletionConnectionErr({ provider: providerName })
// message: "Failed to connect to OpenAI"

// Before (missing API key)
CompletionServiceErr({ message: 'No API key configured for OpenAI.' })
// After: no .withMessage() on CompletionConfigError, message at call site
CompletionConfigErr({ provider: 'OpenAI', message: 'No API key configured for OpenAI.' })
```

---

### 3. DbServiceError (~60+ call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/db/types.ts`
**Call sites**: `desktop.ts`, `web.ts`, `file-system.ts`, `actions.ts`

**Current**:
```typescript
const { DbServiceError, DbServiceErr } = createTaggedError('DbServiceError')
  .withMessage(() => 'A database operation failed');
```

**Proposed errors**:

```typescript
// Structured: table + id useful for retry or redirect logic
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withFields<{ table: string; id: string }>()
  .withMessage(({ table, id }) => `${table} '${id}' not found`);

// Dynamic message: covers many different query failures
const { DbQueryError, DbQueryErr } = createTaggedError('DbQueryError');

// Dynamic message: connection issues vary
const { DbConnectionError, DbConnectionErr } = createTaggedError('DbConnectionError');

// Dynamic message: migration failures vary
const { DbMigrationError, DbMigrationErr } = createTaggedError('DbMigrationError');

type DbServiceError =
  | DbNotFoundError
  | DbQueryError
  | DbConnectionError
  | DbMigrationError;
```

**Note**: With 60+ call sites across 3 implementations (desktop, web, file-system), this is the largest migration. The implementing agent should:
1. Read each file completely before starting
2. Identify the actual failure modes (many will map to `DbQueryErr`)
3. Not force granularity: if a call site is a generic "this DB operation failed," `DbQueryErr({ message: '...' })` is fine

---

### 4. FsServiceError (3 call sites)

**File**: `apps/whispering/src/lib/services/desktop/fs.ts`

**Current**:
```typescript
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError')
  .withMessage(() => 'File system operation failed');
```

**Proposed**: Keep as one error, no fields, message at call site:
```typescript
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError');
```

**Call site migration**:
```typescript
// Before
FsServiceErr({ message: `Failed to read file as Blob: ${path}: ${extractErrorMessage(error)}` })
// After: same message, just no wrapper
FsServiceErr({ message: `Failed to read file as Blob: ${path}: ${extractErrorMessage(error)}` })
```

Only 3 call sites, callers don't differentiate failure modes. One error with call-site message is the right call.

---

### 5. TextServiceError (~12 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/text/types.ts`
**Call sites**: `desktop.ts`, `extension.ts`, `web.ts`

**Current**:
```typescript
const { TextServiceError, TextServiceErr } = createTaggedError('TextServiceError')
  .withMessage(() => 'Text service operation failed');
```

**Proposed errors**:
```typescript
// Static: genuinely distinct: callers show "not supported on this platform" UI
const { KeystrokeSimulationUnsupportedError, KeystrokeSimulationUnsupportedErr } = createTaggedError('KeystrokeSimulationUnsupportedError')
  .withMessage(() => 'Simulating keystrokes is not supported on this platform');

// Dynamic message: covers clipboard read/write and text insert failures
const { TextServiceError, TextServiceErr } = createTaggedError('TextServiceError');

type TextServiceError =
  | KeystrokeSimulationUnsupportedError
  | TextServiceError;
```

Callers don't differentiate clipboard-read vs clipboard-write vs text-insert at the error handling level. One dynamic-message error + one static error for the genuinely distinct platform limitation.

---

### 6. NotificationServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/notifications/types.ts`
**Call sites**: `desktop.ts`, `web.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { NotificationServiceError, NotificationServiceErr } = createTaggedError('NotificationServiceError');
```

4 call sites, callers don't differentiate send vs remove failures.

---

### 7. PermissionsServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/desktop/permissions.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { PermissionsServiceError, PermissionsServiceErr } = createTaggedError('PermissionsServiceError');
```

4 call sites, callers don't differentiate check vs request failures.

---

### 8. AutostartServiceError (3 call sites)

**File**: `apps/whispering/src/lib/services/desktop/autostart.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { AutostartServiceError, AutostartServiceErr } = createTaggedError('AutostartServiceError');
```

3 call sites, all the same pattern. No need for fields or `.withMessage()`.

---

### 9. CommandServiceError (2 call sites)

**File**: `apps/whispering/src/lib/services/desktop/command.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { CommandServiceError, CommandServiceErr } = createTaggedError('CommandServiceError');
```

2 call sites, callers don't differentiate.

---

### 10. FfmpegServiceError (small)

**File**: `apps/whispering/src/lib/services/desktop/ffmpeg.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { FfmpegServiceError, FfmpegServiceErr } = createTaggedError('FfmpegServiceError');
```

---

### 11. GlobalShortcutServiceError + InvalidAcceleratorError (4 call sites)

**File**: `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`

Already somewhat granular. `InvalidAcceleratorError` is genuinely distinct: callers show different UI for "your shortcut format is wrong" vs "registration failed."

**Proposed**:
```typescript
// Structured: accelerator is useful for UI ("the shortcut 'X' is invalid")
const { InvalidAcceleratorError, InvalidAcceleratorErr } = createTaggedError('InvalidAcceleratorError')
  .withFields<{ accelerator: string }>()
  .withMessage(({ accelerator }) =>
    `Invalid accelerator format: '${accelerator}'. Must follow Electron accelerator specification.`
  );

// Dynamic message: registration/unregistration failures vary
const { GlobalShortcutServiceError, GlobalShortcutServiceErr } = createTaggedError('GlobalShortcutServiceError');

type GlobalShortcutServiceError =
  | InvalidAcceleratorError
  | GlobalShortcutServiceError;
```

---

### 12. DownloadServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/download/types.ts`
**Call sites**: `desktop.ts`, `web.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { DownloadServiceError, DownloadServiceErr } = createTaggedError('DownloadServiceError');
```

4 call sites, callers don't differentiate "no path" vs "save failed."

---

### 13. PlaySoundServiceError (1 call site)

**File**: `apps/whispering/src/lib/services/isomorphic/sound/types.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { PlaySoundServiceError, PlaySoundServiceErr } = createTaggedError('PlaySoundServiceError');
```

1 call site. Simplest possible form.

---

### 14. DeviceStreamServiceError (local, in device-stream.ts)

**File**: `apps/whispering/src/lib/services/isomorphic/device-stream.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { DeviceStreamServiceError, DeviceStreamServiceErr } = createTaggedError('DeviceStreamServiceError');
```

---

### 15. AnalyticsServiceError (minimal)

**File**: `apps/whispering/src/lib/services/isomorphic/analytics/types.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { AnalyticsServiceError, AnalyticsServiceErr } = createTaggedError('AnalyticsServiceError');
```

---

### 16. OsServiceError (minimal)

**File**: `apps/whispering/src/lib/services/isomorphic/os/types.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { OsServiceError, OsServiceErr } = createTaggedError('OsServiceError');
```

---

### 17. LocalShortcutServiceError (check call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/local-shortcut-manager.ts`

Check usage and apply same pattern as global shortcut service if there's an `InvalidAcceleratorError` equivalent. Otherwise, one error with call-site message.

---

### 18. SetTrayIconServiceError (internal, 1 call site)

**File**: `apps/whispering/src/lib/services/desktop/tray.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { SetTrayIconServiceError, SetTrayIconServiceErr } = createTaggedError('SetTrayIconServiceError');
```

---

### 19. TransformServiceError (in query layer)

**File**: `apps/whispering/src/lib/query/isomorphic/transformer.ts`

Check call sites and apply appropriate granularity.

---

### 20. StaticWorkspaceError (in epicenter app)

**File**: `apps/epicenter/src/lib/workspaces/static/queries.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { StaticWorkspaceError, StaticWorkspaceErr } = createTaggedError('StaticWorkspaceError');
```

---

### 21. WorkspaceError (in epicenter app)

**File**: `apps/epicenter/src/lib/workspaces/dynamic/queries.ts`

**Proposed**: Keep as one error, message at call site:
```typescript
const { WorkspaceError, WorkspaceErr } = createTaggedError('WorkspaceError');
```

---

### 22. ExtensionError (in epicenter package)

**File**: `packages/epicenter/src/shared/errors.ts`

Already has `.withContext<ExtensionErrorContext | undefined>()`. Convert to `.withFields()` with flat fields. Review whether the optional fields are actually used for programmatic handling: if not, drop them and use call-site message.

---

### 23. ParseJsonError (in svelte-utils)

**File**: `packages/svelte-utils/src/createPersistedState.svelte.ts`

**Proposed**: Structured: `preview` is useful for debugging:
```typescript
const { ParseJsonError, ParseJsonErr } = createTaggedError('ParseJsonError')
  .withFields<{ preview: string }>()
  .withMessage(({ preview }) => `Failed to parse JSON: "${preview}..."`);
```

---

### 24. HttpServiceError (already close: the model)

**File**: `apps/whispering/src/lib/services/isomorphic/http/types.ts`

Already uses the target pattern. Changes needed:
- Convert `.withContext()` to `.withFields()` in definitions
- Update template callbacks from `({ context })` to flat destructuring
- Review whether `.withMessage()` templates are sufficient for all call sites: if any call site currently overrides with a custom message, either the template needs to handle that case via fields, or that call site should use a different error type

```typescript
// ConnectionErr(): static, sealed message
// ResponseErr({ status: 404 }): computed from fields, sealed
// ParseErr(): static, sealed message
```

The HTTP service needs review: `ConnectionError` and `ParseError` currently have static messages. If some call sites need different messages (e.g., connection errors with specific context), either add fields to the template or split into a separate error type. Message override is not available: `.withMessage()` seals the message.

---

## Skills to Update

After migration, update these skills:

1. **`.agents/skills/services-layer/SKILL.md`**: Show the new patterns: static `.withMessage()`, structured fields, and call-site `message`.
2. **`.agents/skills/error-handling/SKILL.md`**: Update trySync/tryAsync examples to show call-site `message` and optional `.withMessage()` defaults.
3. **`.agents/skills/create-tagged-error/SKILL.md`** (if it exists): Update API reference for `.withFields()` and optional `.withMessage()`.

---

## Implementation Order

1. **Implement and publish new wellcrafted version** (see wellcrafted spec)
2. **Update wellcrafted dependency** in the monorepo
3. **Migrate services**: can be done in parallel per service, but commit atomically:
   - Start with **HttpService** (already close, just convert to flat + `.withFields()`)
   - Then **FsService** (3 call sites, easy win)
   - Then small services: **NotificationService**, **PermissionsService**, **AutostartService**, **CommandService**, **PlaySoundService**, **DeviceStreamService**, **SetTrayIcon**, **AnalyticsService**, **OsService**, **DownloadService**, **FfmpegService**
   - Then **TextService** (split out `KeystrokeSimulationUnsupportedError`)
   - Then **GlobalShortcutService** (split out `InvalidAcceleratorError`)
   - Then **CompletionService** (~30 call sites)
   - Then **RecorderService** (~25 call sites)
   - Then **DbService** (~60 call sites, largest)
   - Then **ExtensionError**, **ParseJsonError**, **WorkspaceError**, **StaticWorkspaceError**
4. **Update skills** after all services are migrated
5. **Type check**: `bun run typecheck` must pass
6. **Build**: `bun run build` must pass

## Notes for Implementing Agent

- The proposed error types above are **suggestions**. Read each service file completely before deciding on the final error types. The actual failure modes in the code may differ from what's predicted here.
- When in doubt, fewer error types is better. Don't create an error type that has only 1 call site unless it represents a genuinely distinct failure mode that callers handle differently.
- **No `reason: string` convention.** If the only dynamic content is a caught exception message, skip `.withMessage()` and let the call site pass `message` directly. Don't launder `message` through a field.
- Many existing error messages are user-facing and well-written. Preserve that quality: when converting to call-site `message`, keep the original message text.
- The `type XServiceError = A | B | C` union must be exported and used in the service's return type signatures. Verify that `Result<T, XServiceError>` still works with the new union type in all service method signatures.
- **For single-error services with all-dynamic messages**, the simplest form is `createTaggedError('XError')` with no `.withFields()` and no `.withMessage()`. Call sites pass `{ message: '...' }`. This is intentional: not every error needs typed fields.
- **`.withMessage()` seals the message.** When `.withMessage()` is present, `message` is NOT in the factory input type. The template owns the message entirely. If a call site needs a different message than what the template produces, either: (a) add fields to make the template more expressive, or (b) use a different error type. Do not add a message override escape hatch.
