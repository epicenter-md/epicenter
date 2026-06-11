# Tagged Error Migration Plan

Based on [PR #99](https://github.com/wellcrafted-dev/wellcrafted/pull/99): the `createTaggedError` redesign with flat fields and sealed `.withMessage()`.

> **⚠️ Note on `cause` and `underlyingError` patterns**: This spec was written when `cause`/`underlyingError` were typed as `string` and call sites used `extractErrorMessage(error)`. The current pattern types `cause` as `unknown` and calls `extractErrorMessage(cause)` inside the constructor's message template. Call sites pass `{ cause: error }` (the raw caught error). See the `services-layer` skill for the updated pattern.

## Key API Changes from PR #99

- `.withContext<T>()` → `.withFields<T>()` (fields flat on error, not nested)
- `.withCause()` removed (model `cause` as a field in `.withFields()`)
- `.withMessage()` is now **optional** and **seals** the message (callers cannot override)
- Mode 1 (no `.withMessage()`): call sites must provide `{ message: '...' }`
- Mode 2 (`.withMessage()`): message derived from fields, callers cannot set it

## Design Principle

Prefer capturing structured context via `.withFields()`, then derive message when possible. Use Mode 1 only when messages are genuinely too diverse to template.

---

## Mode 2 Errors (sealed `.withMessage()` with `.withFields()`)

These errors have regular, predictable messages that can be derived from structured fields.

### PermissionsServiceError ✅ Mode 2

All 4 call sites follow one invariant template: `"Failed to {action} {permissionType} permissions: {cause}"`.

```ts
export const { PermissionsServiceError, PermissionsServiceErr } =
    createTaggedError('PermissionsServiceError')
        .withFields<{
            action: 'check' | 'request';
            permissionType: 'accessibility' | 'microphone';
            cause: string;
        }>()
        .withMessage(
            ({ action, permissionType, cause }) =>
                `Failed to ${action} ${permissionType} permissions: ${cause}`,
        );
```

Call sites:
```ts
PermissionsServiceErr({ action: 'check', permissionType: 'accessibility', cause: extractErrorMessage(error) })
PermissionsServiceErr({ action: 'request', permissionType: 'microphone', cause: extractErrorMessage(error) })
```

**Note:** Fixes a current bug where the sealed static message `'Permissions check failed'` was discarding all contextual information from call sites.

---

### DeviceStreamServiceError ✅ Mode 2

6 call sites map onto 4 discrete failure scenarios. A `errorKind` discriminant captures the real variation; an optional `underlyingError` captures `extractErrorMessage(error)`.

```ts
const { DeviceStreamServiceError, DeviceStreamServiceErr } = createTaggedError(
    'DeviceStreamServiceError',
)
    .withFields<{
        errorKind:
            | 'permission_denied'
            | 'device_connection_failed'
            | 'enumeration_failed'
            | 'no_devices_available';
        underlyingError?: string;
        deviceId?: string;
        hadPreferredDevice?: boolean;
    }>()
    .withMessage(({ errorKind, underlyingError, hadPreferredDevice }) => {
        const suffix = underlyingError ? ` ${underlyingError}` : '';
        switch (errorKind) {
            case 'permission_denied':
                return `We need permission to see your microphones. Check your browser settings and try again.${suffix}`;
            case 'device_connection_failed':
                return `Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions.${suffix}`;
            case 'enumeration_failed':
                return 'Error enumerating recording devices. Please make sure you have given permission to access your audio devices.';
            case 'no_devices_available':
                return hadPreferredDevice
                    ? "We couldn't connect to any microphones. Make sure they're plugged in and try again!"
                    : "Hmm... We couldn't find any microphones to use. Check your connections and try again!";
        }
    });
```

Call sites:
```ts
DeviceStreamServiceErr({ errorKind: 'permission_denied', underlyingError: extractErrorMessage(error) })
DeviceStreamServiceErr({ errorKind: 'device_connection_failed', deviceId: deviceIdentifier, underlyingError: extractErrorMessage(error) })
DeviceStreamServiceErr({ errorKind: 'enumeration_failed' })
DeviceStreamServiceErr({ errorKind: 'no_devices_available', hadPreferredDevice: selectedDeviceId !== null })
```

---

### FsServiceError ✅ Mode 2

All 3 call sites follow `"Failed to {operation}: {path(s)}: {cause}"`.

```ts
export const { FsServiceError, FsServiceErr } =
    createTaggedError('FsServiceError')
        .withFields<{ operation: string; paths: string | string[]; cause: string }>()
        .withMessage(({ operation, paths, cause }) => {
            const pathStr = Array.isArray(paths) ? paths.join(', ') : paths;
            return `Failed to ${operation}: ${pathStr}: ${cause}`;
        });
```

Call sites:
```ts
FsServiceErr({ operation: 'read file as Blob', paths: path, cause: extractErrorMessage(error) })
FsServiceErr({ operation: 'read file as File', paths: path, cause: extractErrorMessage(error) })
FsServiceErr({ operation: 'read files', paths, cause: extractErrorMessage(error) })
```

---

### FfmpegServiceError ✅ Mode 2

3 call sites, all `"{operation}: {cause}"`. Operations rephrased as clean imperative labels.

```ts
export const { FfmpegServiceErr, FfmpegServiceError } =
    createTaggedError('FfmpegServiceError')
        .withFields<{ operation: string; cause: string }>()
        .withMessage(({ operation, cause }) => `Failed to ${operation}: ${cause}`);
```

Call sites:
```ts
FfmpegServiceErr({ operation: 'check FFmpeg installation via shell', cause: extractErrorMessage(error) })
FfmpegServiceErr({ operation: 'verify temp file accessibility', cause: extractErrorMessage(error) })
FfmpegServiceErr({ operation: 'compress audio', cause: extractErrorMessage(error) })
```

---

### SetTrayIconServiceError ✅ Mode 2

Single call site, static base message + cause.

```ts
const { SetTrayIconServiceErr } =
    createTaggedError('SetTrayIconServiceError')
        .withFields<{ cause: string }>()
        .withMessage(({ cause }) => `Failed to set tray icon: ${cause}`);
```

Call site:
```ts
SetTrayIconServiceErr({ cause: extractErrorMessage(error) })
```

---

### GlobalShortcutServiceError ✅ Mode 2

3 call sites follow `"Failed to {operation} global shortcut '{accelerator}': {cause}"`.

```ts
const { GlobalShortcutServiceError, GlobalShortcutServiceErr } =
    createTaggedError('GlobalShortcutServiceError')
        .withFields<{
            operation: 'register' | 'unregister' | 'unregisterAll';
            accelerator?: string;
            cause: string;
        }>()
        .withMessage(({ operation, accelerator, cause }) =>
            operation === 'unregisterAll'
                ? `Failed to unregister all global shortcuts: ${cause}`
                : `Failed to ${operation} global shortcut '${accelerator}': ${cause}`,
        );
```

Call sites:
```ts
GlobalShortcutServiceErr({ operation: 'register', accelerator, cause: extractErrorMessage(error) })
GlobalShortcutServiceErr({ operation: 'unregister', accelerator, cause: extractErrorMessage(error) })
GlobalShortcutServiceErr({ operation: 'unregisterAll', cause: extractErrorMessage(error) })
```

---

### InvalidAcceleratorError ✅ Mode 2

4 call sites with a `reason` discriminant + optional `accelerator`.

```ts
const { InvalidAcceleratorError, InvalidAcceleratorErr } = createTaggedError(
    'InvalidAcceleratorError',
)
    .withFields<{
        reason: 'invalid_format' | 'no_key_code' | 'multiple_key_codes' | 'generated_invalid';
        accelerator?: string;
    }>()
    .withMessage(({ reason, accelerator }) => {
        switch (reason) {
            case 'invalid_format':
                return `Invalid accelerator format: '${accelerator}'. Must follow Electron accelerator specification.`;
            case 'no_key_code':
                return 'No valid key code found in pressed keys';
            case 'multiple_key_codes':
                return 'Multiple key codes not allowed in accelerator';
            case 'generated_invalid':
                return `Generated invalid accelerator: ${accelerator}`;
        }
    });
```

Call sites:
```ts
InvalidAcceleratorErr({ reason: 'invalid_format', accelerator })
InvalidAcceleratorErr({ reason: 'no_key_code' })
InvalidAcceleratorErr({ reason: 'multiple_key_codes' })
InvalidAcceleratorErr({ reason: 'generated_invalid', accelerator })
```

---

### ResponseError ✅ Mode 2 (mechanical migration)

Already had `.withContext<{ status }>()`: just flatten.

```ts
export const { ResponseError, ResponseErr } =
    createTaggedError('ResponseError')
        .withFields<{ status: number }>()
        .withMessage(({ status }) => `HTTP ${status} response`);
```

Call sites:
```ts
// Before: ResponseErr({ message: extractErrorMessage(await response.json()), context: { status: response.status } })
// After:
ResponseErr({ status: response.status })
```

**Note:** Drops the body error message that was embedded in `message`. The status is the canonical structured fact. If body detail is needed, add `bodyMessage?: string` as an explicit field.

---

### ParseJsonError ✅ Mode 2

1 call site, fields `value` and `parseError` are genuinely useful for debugging.

```ts
const { ParseJsonErr } = createTaggedError('ParseJsonError')
    .withFields<{ value: string; parseError: string }>()
    .withMessage(({ value, parseError }) =>
        `Failed to parse JSON for value "${value.slice(0, 100)}...": ${parseError}`
    );
```

Call site:
```ts
ParseJsonErr({ value, parseError: extractErrorMessage(e) })
```

---

### ExtensionError ✅ Mode 2 (dormant: zero call sites)

Flatten context fields, derive message from `operation` when present.

```ts
export const { ExtensionError, ExtensionErr } = createTaggedError('ExtensionError')
    .withFields<{
        tableName?: string;
        rowId?: string;
        filename?: string;
        filePath?: string;
        directory?: string;
        operation?: string;
    }>()
    .withMessage(({ operation }) =>
        operation
            ? `Extension operation '${operation}' failed`
            : 'An extension operation failed'
    );
```

---

### OsServiceError ✅ Mode 2 (no change: never called)

```ts
export const { OsServiceError, OsServiceErr } =
    createTaggedError('OsServiceError')
        .withMessage(() => 'OS service operation failed');
```

### LocalShortcutServiceError ✅ Mode 2 (no change: never called)

```ts
const { LocalShortcutServiceError } =
    createTaggedError('LocalShortcutServiceError')
        .withMessage(() => 'Local shortcut operation failed');
```

---

## Mode 1 Errors (no `.withMessage()`, message at call site)

These errors have diverse, context-specific messages that can't be meaningfully templated.

### TextServiceError: Mode 1

6+ distinct messages across 3 platform variants (desktop/web/extension). Platform name, operation, and underlying error all vary independently.

```ts
export const { TextServiceError, TextServiceErr } =
    createTaggedError('TextServiceError');
```

---

### RecorderServiceError: Mode 1

10+ distinct messages across 3 recorder backends (navigator/cpal/ffmpeg). Operation context and failure mode vary per site.

```ts
export const { RecorderServiceError, RecorderServiceErr } =
    createTaggedError('RecorderServiceError');
```

---

### CompletionServiceError: Mode 1

10+ messages per provider (OpenAI-compatible, Anthropic, Groq). Status-code-specific user-actionable guidance. Clearest Mode 1 case.

```ts
export const { CompletionServiceError, CompletionServiceErr } =
    createTaggedError('CompletionServiceError');
```

---

### DbServiceError: Mode 1

25+ call sites across file-system and desktop implementations. Messages vary by entity type and operation.

```ts
export const { DbServiceError, DbServiceErr } =
    createTaggedError('DbServiceError');
```

---

### NotificationServiceError: Mode 1

4 distinct messages. One embeds a dynamic `id`. All embed `extractErrorMessage(error)`.

```ts
export const { NotificationServiceError, NotificationServiceErr } =
    createTaggedError('NotificationServiceError');
```

---

### PlaySoundServiceError: Mode 1

Single live call site embeds `extractErrorMessage(error)`.

```ts
export const { PlaySoundServiceError, PlaySoundServiceErr } =
    createTaggedError('PlaySoundServiceError');
```

---

### DownloadServiceError: Mode 1

3 distinct messages with platform-specific phrasing plus dynamic error detail.

```ts
export const { DownloadServiceError, DownloadServiceErr } =
    createTaggedError('DownloadServiceError');
```

---

### ConnectionError: Mode 1

Call sites append `extractErrorMessage(error)`. Current sealed message discards that detail.

```ts
export const { ConnectionError, ConnectionErr } =
    createTaggedError('ConnectionError');
```

---

### AnalyticsServiceError: Mode 1

2 call sites with platform-specific wording plus `extractErrorMessage(error)`.

```ts
const { AnalyticsServiceError, AnalyticsServiceErr } =
    createTaggedError('AnalyticsServiceError');
export { AnalyticsServiceErr, AnalyticsServiceError };
```

---

### AutostartServiceError: Mode 1

3 call sites. Messages are `"Failed to {action} autostart: {cause}"`: could technically be Mode 2, but no downstream consumer inspects the error structurally; the query layer wraps every failure uniformly.

```ts
export const { AutostartServiceError, AutostartServiceErr } =
    createTaggedError('AutostartServiceError');
```

---

### CommandServiceError: Mode 1

2 call sites with different messages. Note: `execute()` call site drops the cause entirely (possible bug).

```ts
export const { CommandServiceError, CommandServiceErr } =
    createTaggedError('CommandServiceError');
```

---

### WorkspaceError: Mode 1

8 call sites: 3 "not found", 1 catch, 4 stubs. Heterogeneous messages, no shared structure.

```ts
export const { WorkspaceError, WorkspaceErr } =
    createTaggedError('WorkspaceError');
```

---

### StaticWorkspaceError: Mode 1

1 call site: `String(error)`. Unpredictable runtime value.

```ts
const { StaticWorkspaceErr } = createTaggedError('StaticWorkspaceError');
```

---

### TransformServiceError: Mode 1 (with `.withFields()`)

7 call sites: 2 validation + 5 DB failures. Messages too diverse for a template, but `operation` field is valuable for structured logging.

```ts
const { TransformServiceError, TransformServiceErr } = createTaggedError(
    'TransformServiceError',
).withFields<{
    operation:
        | 'validate_input'
        | 'validate_steps'
        | 'db_create_run'
        | 'db_add_step'
        | 'db_fail_step'
        | 'db_complete_step'
        | 'db_complete_run';
}>();
```

Call sites:
```ts
TransformServiceErr({ operation: 'validate_input', message: 'Empty input. Please enter some text to transform' })
TransformServiceErr({ operation: 'db_create_run', message: 'Unable to start transformation run' })
```

**Note:** Fixes a real bug: the current sealed message `'Transform operation failed'` silently discards all 7 specific messages.

---

## Summary Table

| Error | Mode | `.withFields()` | `.withMessage()` | Call Sites |
|---|---|---|---|---|
| PermissionsServiceError | 2 | `action`, `permissionType`, `cause` | ✅ template | 4 |
| DeviceStreamServiceError | 2 | `errorKind`, `underlyingError?`, `deviceId?`, `hadPreferredDevice?` | ✅ switch | 6 |
| FsServiceError | 2 | `operation`, `paths`, `cause` | ✅ template | 3 |
| FfmpegServiceError | 2 | `operation`, `cause` | ✅ template | 3 |
| SetTrayIconServiceError | 2 | `cause` | ✅ template | 1 |
| GlobalShortcutServiceError | 2 | `operation`, `accelerator?`, `cause` | ✅ template | 3 |
| InvalidAcceleratorError | 2 | `reason`, `accelerator?` | ✅ switch | 4 |
| ResponseError | 2 | `status` | ✅ template | ~2 |
| ParseJsonError | 2 | `value`, `parseError` | ✅ template | 1 |
| ExtensionError | 2 | 6 optional fields | ✅ conditional | 0 (dormant) |
| OsServiceError | 2 | none | ✅ static | 0 (never called) |
| LocalShortcutServiceError | 2 | none | ✅ static | 0 (never called) |
| TextServiceError | 1 | none | ❌ | 6+ |
| RecorderServiceError | 1 | none | ❌ | 10+ |
| CompletionServiceError | 1 | none | ❌ | 10+ |
| DbServiceError | 1 | none | ❌ | 25+ |
| NotificationServiceError | 1 | none | ❌ | 4 |
| PlaySoundServiceError | 1 | none | ❌ | 1 |
| DownloadServiceError | 1 | none | ❌ | 3 |
| ConnectionError | 1 | none | ❌ | ~2 |
| AnalyticsServiceError | 1 | none | ❌ | 2 |
| AutostartServiceError | 1 | none | ❌ | 3 |
| CommandServiceError | 1 | none | ❌ | 2 |
| WorkspaceError | 1 | none | ❌ | 8 |
| StaticWorkspaceError | 1 | none | ❌ | 1 |
| TransformServiceError | 1 | `operation` (typed union) | ❌ | 7 |

**12 errors → Mode 2** (sealed message, structured fields)
**14 errors → Mode 1** (message at call site)

## Bugs Fixed by This Migration

1. **All Mode 1 errors currently have `.withMessage()` with static strings**: these seal a generic message that discards the specific, contextual messages being passed at call sites. Every Mode 1 migration fixes this by removing `.withMessage()` so call-site messages are actually used.
2. **PermissionsServiceError**: `'Permissions check failed'` discards action and permission type context.
3. **TransformServiceError**: `'Transform operation failed'` discards all 7 specific failure messages.
4. **CommandServiceError `execute()` call site**: drops the underlying error cause entirely (pre-existing bug, not caused by the migration).
