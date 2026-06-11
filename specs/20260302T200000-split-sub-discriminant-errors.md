# Split Sub-Discriminant Error Variants

**Created**: 2026-03-02
**Status**: Implemented
**Depends on**: `20260302T000000-define-errors-api-redesign.md` (defineErrors v2 must be in place)
**Scope**: 7 `defineErrors` definitions that use string literal union fields as sub-discriminants

## Summary

Migrate all `defineErrors` variants that use a string literal union field (`reason`, `operation`, `errorKind`, `action`) as a sub-discriminant into properly split first-class variants. Each variant gets exactly the fields it needs, no optional fields, no switch statements inside constructors.

## Motivation

Using a discriminated union *inside* a variant's input type is a code smell. It means the variant is doing double duty. It's really N different error types crammed into one. Symptoms:

1. **Optional fields that are only relevant for some sub-discriminants.** `accelerator` is only meaningful for `invalid_format` and `generated_invalid`, but it's `accelerator?: string` on every call site.
2. **Switch/lookup tables inside constructors.** The constructor has to map `reason` → message, which is logic that `defineErrors` already handles via separate variants.
3. **Callers can't narrow on the sub-discriminant.** TypeScript narrowing works on the variant `name` field, not on arbitrary fields inside the error. A consumer checking `error.name === 'InvalidAccelerator'` gets the full union of all `reason` values: they'd need a second narrowing step on `error.reason`.
4. **Fields leak across variants.** `deviceId` only matters for `device_connection_failed`, but it's visible (as `undefined`) on all `DeviceStreamError.Service` errors.

The fix is mechanical: promote each sub-discriminant value to its own variant.

## Instances

### 1. `ShortcutError.InvalidAccelerator`: `reason` field

**File:** `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`

**Before:**
```typescript
const ShortcutError = defineErrors({
  InvalidAccelerator: (input: {
    reason: 'invalid_format' | 'no_key_code' | 'multiple_key_codes' | 'generated_invalid';
    accelerator?: string;
  }) => {
    const messages = {
      invalid_format: `Invalid accelerator format: '${input.accelerator}'.`,
      no_key_code: 'No valid key code found in pressed keys',
      multiple_key_codes: 'Multiple key codes not allowed in accelerator',
      generated_invalid: `Generated invalid accelerator: ${input.accelerator}`,
    } as const;
    return { message: messages[input.reason], ...input };
  },
  // ...
});

type InvalidAcceleratorError = InferError<typeof ShortcutError.InvalidAccelerator>;
```

**After:**
```typescript
const ShortcutError = defineErrors({
  InvalidFormat: ({ accelerator }: { accelerator: string }) => ({
    message: `Invalid accelerator format: '${accelerator}'. Must follow Electron accelerator specification.`,
    accelerator,
  }),
  NoKeyCode: () => ({
    message: 'No valid key code found in pressed keys',
  }),
  MultipleKeyCodes: () => ({
    message: 'Multiple key codes not allowed in accelerator',
  }),
  GeneratedInvalid: ({ accelerator }: { accelerator: string }) => ({
    message: `Generated invalid accelerator: ${accelerator}`,
    accelerator,
  }),
  // ... (Service variants unchanged)
});

type InvalidAcceleratorError =
  | InferError<typeof ShortcutError.InvalidFormat>
  | InferError<typeof ShortcutError.NoKeyCode>
  | InferError<typeof ShortcutError.MultipleKeyCodes>
  | InferError<typeof ShortcutError.GeneratedInvalid>;
```

**Call site changes:**
```typescript
// Before
ShortcutError.InvalidAccelerator({ reason: 'invalid_format', accelerator })
ShortcutError.InvalidAccelerator({ reason: 'no_key_code' })
ShortcutError.InvalidAccelerator({ reason: 'multiple_key_codes' })
ShortcutError.InvalidAccelerator({ reason: 'generated_invalid', accelerator })

// After
ShortcutError.InvalidFormat({ accelerator })
ShortcutError.NoKeyCode()
ShortcutError.MultipleKeyCodes()
ShortcutError.GeneratedInvalid({ accelerator })
```

**Note:** `accelerator` goes from `string | undefined` on all call sites to `string` (required) only on the two variants that actually use it.

---

### 2. `ShortcutError.Service`: `operation` field

**File:** `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`

**Before:**
```typescript
const ShortcutError = defineErrors({
  // ...
  Service: ({ operation, accelerator, cause }: {
    operation: 'register' | 'unregister' | 'unregisterAll';
    accelerator?: string;
    cause: unknown;
  }) => ({
    message: operation === 'unregisterAll'
      ? `Failed to unregister all global shortcuts: ${extractErrorMessage(cause)}`
      : `Failed to ${operation} global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
    operation, accelerator, cause,
  }),
});

type GlobalShortcutServiceError = InferError<typeof ShortcutError.Service>;
```

**After:**
```typescript
const ShortcutError = defineErrors({
  // ...
  RegisterFailed: ({ accelerator, cause }: { accelerator: string; cause: unknown }) => ({
    message: `Failed to register global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
    accelerator, cause,
  }),
  UnregisterFailed: ({ accelerator, cause }: { accelerator: string; cause: unknown }) => ({
    message: `Failed to unregister global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
    accelerator, cause,
  }),
  UnregisterAllFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to unregister all global shortcuts: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

type GlobalShortcutServiceError =
  | InferError<typeof ShortcutError.RegisterFailed>
  | InferError<typeof ShortcutError.UnregisterFailed>
  | InferError<typeof ShortcutError.UnregisterAllFailed>;
```

**Call site changes:**
```typescript
// Before
ShortcutError.Service({ operation: 'register', accelerator, cause: error })
ShortcutError.Service({ operation: 'unregister', accelerator, cause: error })
ShortcutError.Service({ operation: 'unregisterAll', cause: error })

// After
ShortcutError.RegisterFailed({ accelerator, cause: error })
ShortcutError.UnregisterFailed({ accelerator, cause: error })
ShortcutError.UnregisterAllFailed({ cause: error })
```

**Note:** `accelerator` goes from optional to required on Register/Unregister, and absent on UnregisterAll. The ternary in the constructor disappears.

---

### 3. `DeviceStreamError.Service`: `errorKind` field

**File:** `apps/whispering/src/lib/services/isomorphic/device-stream.ts`

**Before:**
```typescript
const DeviceStreamError = defineErrors({
  Service: (input: {
    errorKind: 'permission_denied' | 'device_connection_failed' | 'enumeration_failed' | 'no_devices_available';
    underlyingError?: string;
    deviceId?: string;
    hadPreferredDevice?: boolean;
  }) => {
    const suffix = input.underlyingError ? ` ${input.underlyingError}` : '';
    const messages = { /* lookup table */ } as const;
    return { message: messages[input.errorKind], ...input };
  },
});
type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
```

**After (further refined: optional keys eliminated):**
```typescript
const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `We need permission to see your microphones. Check your browser settings and try again. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({ deviceId, cause }: { deviceId: string; cause: unknown }) => ({
    message: `Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions. ${extractErrorMessage(cause)}`,
    deviceId, cause,
  }),
  EnumerationFailed: () => ({
    message: 'Error enumerating recording devices. Please make sure you have given permission to access your audio devices.',
  }),
  NoDevicesFound: () => ({
    message: "Hmm... We couldn't find any microphones to use. Check your connections and try again!",
  }),
  PreferredDeviceUnavailable: () => ({
    message: "We couldn't connect to any microphones. Make sure they're plugged in and try again!",
  }),
});
type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
```

**Call site changes:**
```typescript
// Before
DeviceStreamError.Service({ errorKind: 'permission_denied', underlyingError: extractErrorMessage(error) })
DeviceStreamError.Service({ errorKind: 'device_connection_failed', deviceId: deviceIdentifier, underlyingError: extractErrorMessage(error) })
DeviceStreamError.Service({ errorKind: 'enumeration_failed' })
DeviceStreamError.Service({ errorKind: 'no_devices_available', hadPreferredDevice: false })

// After
DeviceStreamError.PermissionDenied({ cause: error })
DeviceStreamError.DeviceConnectionFailed({ deviceId: deviceIdentifier, cause: error })
DeviceStreamError.EnumerationFailed()
DeviceStreamError.NoDevicesFound()
// or
DeviceStreamError.PreferredDeviceUnavailable()
```

**Notes:**
- `deviceId` is now required on `DeviceConnectionFailed` (the only variant that uses it) instead of optional on the mega-union.
- `underlyingError?: string` was renamed to `cause: unknown` and made required: all call sites were already passing it.
- `NoDevicesAvailable({ hadPreferredDevice?: boolean })` was split into `NoDevicesFound()` and `PreferredDeviceUnavailable()`: the boolean was a sub-discriminant controlling the message.

---

### 4. `PermissionsError.Service`: `action` + `permissionType` fields

**File:** `apps/whispering/src/lib/services/desktop/permissions.ts`

**Before:**
```typescript
export const PermissionsError = defineErrors({
  Service: ({ action, permissionType, cause }: {
    action: 'check' | 'request';
    permissionType: 'accessibility' | 'microphone';
    cause: unknown;
  }) => ({
    message: `Failed to ${action} ${permissionType} permissions: ${extractErrorMessage(cause)}`,
    action, permissionType, cause,
  }),
});
export type PermissionsError = InferErrors<typeof PermissionsError>;
```

**After:**
```typescript
export const PermissionsError = defineErrors({
  CheckAccessibility: ({ cause }: { cause: unknown }) => ({
    message: `Failed to check accessibility permissions: ${extractErrorMessage(cause)}`,
    cause,
  }),
  RequestAccessibility: ({ cause }: { cause: unknown }) => ({
    message: `Failed to request accessibility permissions: ${extractErrorMessage(cause)}`,
    cause,
  }),
  CheckMicrophone: ({ cause }: { cause: unknown }) => ({
    message: `Failed to check microphone permissions: ${extractErrorMessage(cause)}`,
    cause,
  }),
  RequestMicrophone: ({ cause }: { cause: unknown }) => ({
    message: `Failed to request microphone permissions: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
export type PermissionsError = InferErrors<typeof PermissionsError>;
```

**Call site changes:**
```typescript
// Before
PermissionsError.Service({ action: 'check', permissionType: 'accessibility', cause: error })
PermissionsError.Service({ action: 'request', permissionType: 'accessibility', cause: error })
PermissionsError.Service({ action: 'check', permissionType: 'microphone', cause: error })
PermissionsError.Service({ action: 'request', permissionType: 'microphone', cause: error })

// After
PermissionsError.CheckAccessibility({ cause: error })
PermissionsError.RequestAccessibility({ cause: error })
PermissionsError.CheckMicrophone({ cause: error })
PermissionsError.RequestMicrophone({ cause: error })
```

**Note:** The two sub-discriminants (`action` x `permissionType`) produced a 2x2 matrix. Exactly 4 call sites, one per combination: confirming these are genuinely separate failure modes.

---

### 5. `AutostartError.Service`: `operation` field

**File:** `apps/whispering/src/lib/services/desktop/autostart.ts`

**Before:**
```typescript
export const AutostartError = defineErrors({
  Service: ({ operation, cause }: {
    operation: 'check' | 'enable' | 'disable';
    cause: unknown;
  }) => ({
    message: `Failed to ${operation} autostart: ${extractErrorMessage(cause)}`,
    operation, cause,
  }),
});
export type AutostartError = InferErrors<typeof AutostartError>;
```

**After:**
```typescript
export const AutostartError = defineErrors({
  CheckFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to check autostart: ${extractErrorMessage(cause)}`,
    cause,
  }),
  EnableFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to enable autostart: ${extractErrorMessage(cause)}`,
    cause,
  }),
  DisableFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to disable autostart: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
export type AutostartError = InferErrors<typeof AutostartError>;
```

**Call site changes:**
```typescript
// Before
AutostartError.Service({ operation: 'check', cause: error })
AutostartError.Service({ operation: 'enable', cause: error })
AutostartError.Service({ operation: 'disable', cause: error })

// After
AutostartError.CheckFailed({ cause: error })
AutostartError.EnableFailed({ cause: error })
AutostartError.DisableFailed({ cause: error })
```

---

### 6. `CommandError.Service`: `operation` field

**File:** `apps/whispering/src/lib/services/desktop/command.ts`

**Before:**
```typescript
export const CommandError = defineErrors({
  Service: ({ operation, cause }: {
    operation: 'execute' | 'spawn';
    cause: unknown;
  }) => ({
    message: `Failed to ${operation} command: ${extractErrorMessage(cause)}`,
    operation, cause,
  }),
});
export type CommandError = InferErrors<typeof CommandError>;
```

**After:**
```typescript
export const CommandError = defineErrors({
  ExecuteFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to execute command: ${extractErrorMessage(cause)}`,
    cause,
  }),
  SpawnFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to spawn command: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
export type CommandError = InferErrors<typeof CommandError>;
```

**Call site changes:**
```typescript
// Before
CommandError.Service({ operation: 'execute', cause: error })
CommandError.Service({ operation: 'spawn', cause: error })

// After
CommandError.ExecuteFailed({ cause: error })
CommandError.SpawnFailed({ cause: error })
```

---

### 7. `TransformError.Service`: `operation` field

**File:** `apps/whispering/src/lib/query/isomorphic/transformer.ts`

**Before:**
```typescript
export const TransformError = defineErrors({
  Service: ({ operation, message }: {
    operation:
      | 'validate_input'
      | 'validate_steps'
      | 'db_create_run'
      | 'db_add_step'
      | 'db_fail_step'
      | 'db_complete_step'
      | 'db_complete_run';
    message: string;
  }) => ({
    message,
    operation,
  }),
});
export type TransformError = InferErrors<typeof TransformError>;
```

**After:**
```typescript
export const TransformError = defineErrors({
  InvalidInput: ({ message }: { message: string }) => ({ message }),
  NoSteps: ({ message }: { message: string }) => ({ message }),
  DbCreateRunFailed: ({ message }: { message: string }) => ({ message }),
  DbAddStepFailed: ({ message }: { message: string }) => ({ message }),
  DbFailStepFailed: ({ message }: { message: string }) => ({ message }),
  DbCompleteStepFailed: ({ message }: { message: string }) => ({ message }),
  DbCompleteRunFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;
```

**Call site changes:**
```typescript
// Before
TransformError.Service({ operation: 'validate_input', message: 'Empty input...' })
TransformError.Service({ operation: 'validate_steps', message: 'No steps configured...' })
TransformError.Service({ operation: 'db_create_run', message: 'Unable to start...' })
TransformError.Service({ operation: 'db_add_step', message: 'Unable to initialize...' })
TransformError.Service({ operation: 'db_fail_step', message: 'Unable to save failed...' })
TransformError.Service({ operation: 'db_complete_step', message: 'Unable to save completed step...' })
TransformError.Service({ operation: 'db_complete_run', message: 'Unable to save completed run...' })

// After
TransformError.InvalidInput({ message: 'Empty input...' })
TransformError.NoSteps({ message: 'No steps configured...' })
TransformError.DbCreateRunFailed({ message: 'Unable to start...' })
TransformError.DbAddStepFailed({ message: 'Unable to initialize...' })
TransformError.DbFailStepFailed({ message: 'Unable to save failed...' })
TransformError.DbCompleteStepFailed({ message: 'Unable to save completed step...' })
TransformError.DbCompleteRunFailed({ message: 'Unable to save completed run...' })
```

**Note:** The `operation` field was purely a sub-discriminant with no consumer: nobody switches on `error.operation`. Each variant's message was already unique. Splitting removes the dead `operation` field entirely.

---

## Type Alias Updates

For files that export individual error type aliases, update them to use `InferError` on the new variants. The union type stays the same: `InferErrors<typeof Namespace>` automatically covers all variants:

```typescript
// Before (global-shortcut-manager.ts)
type InvalidAcceleratorError = InferError<typeof ShortcutError.InvalidAccelerator>;
type GlobalShortcutServiceError = InferError<typeof ShortcutError.Service>;

// After
type InvalidAcceleratorError =
  | InferError<typeof ShortcutError.InvalidFormat>
  | InferError<typeof ShortcutError.NoKeyCode>
  | InferError<typeof ShortcutError.MultipleKeyCodes>
  | InferError<typeof ShortcutError.GeneratedInvalid>;

type GlobalShortcutServiceError =
  | InferError<typeof ShortcutError.RegisterFailed>
  | InferError<typeof ShortcutError.UnregisterFailed>
  | InferError<typeof ShortcutError.UnregisterAllFailed>;
```

For files that only export the namespace union (`type FooError = InferErrors<typeof FooError>`), no change needed: `InferErrors` picks up the new variants automatically.

## Scope

This is purely a refactor. No behavior changes:
- Same error messages (computed from the same logic, just in separate constructors)
- Same fields on each error instance (minus the now-unnecessary sub-discriminant fields)
- Same `Result` return types on service methods (the union type covers the same variants)

The only observable difference: error `.name` values change (e.g., `'InvalidAccelerator'` becomes `'InvalidFormat'` / `'NoKeyCode'` / etc.). No consumer in the codebase inspects `.name` on these errors. They're all handled as union types in `Result`.

## Implementation Order

Each file is independent. Suggested order (smallest to largest):

1. [x] `command.ts`: 2 call sites
2. [x] `autostart.ts`: 3 call sites
3. [x] `permissions.ts`: 4 call sites
4. [x] `global-shortcut-manager.ts`: 7 call sites (both InvalidAccelerator and Service)
5. [x] `device-stream.ts`: 6 call sites
6. [x] `transformer.ts`: 7 call sites

Verify after each file: `bun run typecheck` must pass.

## Review

**Completed**: 2026-03-02
**Branch**: braden-w/review-service-errors

### Summary

All 7 `defineErrors` variants across 6 files were split from sub-discriminant patterns into first-class variants. Each variant now has exactly the fields it needs, no optional fields, no switch/lookup tables in constructors. One consumer (`GlobalKeyboardShortcutRecorder.svelte`) was updated to match on the new variant names.

### Deviations from Spec

- None. Implementation matched the spec exactly.

### Follow-up Work

- **Optional key elimination pass** (completed): After splitting sub-discriminants, a second pass eliminated remaining optional keys:
  - `underlyingError?: string` → `cause: unknown` (required): all call sites already passed it
  - `hadPreferredDevice?: boolean` → split `NoDevicesAvailable` into `NoDevicesFound` + `PreferredDeviceUnavailable`
  - `ExtensionError.Operation` (all-optional grab bag) → split into `TableOperation`, `FileOperation`, `DirectoryOperation` with required fields
  - `HttpError.Response.bodyMessage?: string`: kept optional with JSDoc (genuine enrichment data)
