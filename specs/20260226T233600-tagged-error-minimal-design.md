# Tagged Error Minimal Design: Epicenter Migration Reference

**Created**: 2026-02-26
**Updated**: 2026-02-27
**Status**: Accepted: canonical spec lives in wellcrafted
**Canonical spec**: `wellcrafted/specs/20260226T233600-tagged-error-minimal-design.md`
**Migration spec**: `20260226T000000-granular-error-migration.md` (this repo)

## Summary

The `TaggedError` type and `createTaggedError` builder are being redesigned in wellcrafted. This doc is a pointer to the canonical spec: all API design decisions live there.

## Key Changes for Epicenter Migration

These are the changes that affect epicenter call sites:

### 1. Flat fields replace nested `context`

```typescript
// Before (nested)
ResponseErr({ context: { status: 404 } })
const { context: { status }, message } = error;

// After (flat)
ResponseErr({ status: 404 })
const { status, message } = error;
```

### 2. `.withFields()` replaces `.withContext()`

```typescript
// Before
createTaggedError('ResponseError')
  .withContext<{ status: number }>()
  .withMessage(({ context }) => `HTTP ${context.status}`)

// After
createTaggedError('ResponseError')
  .withFields<{ status: number }>()
  .withMessage(({ status }) => `HTTP ${status}`)
```

### 3. `.withCause()` removed

If an error needs to carry a cause, it's just another typed field:

```typescript
createTaggedError('BackendError')
  .withFields<{ backend: string; cause: string }>()
  .withMessage(({ backend }) => `${backend} failed`)
```

### 4. `.withMessage()` seals the message: no override

This is the biggest change from the intermediate design. `.withMessage()` and call-site `message` are **mutually exclusive modes**, not a default-with-override:

- **Without `.withMessage()`**: `message` is **required** at the call site
- **With `.withMessage()`**: `message` is **not in the input type**: the template owns the message entirely

```typescript
// No .withMessage(): message required at call site
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError');
FsServiceErr({ message: `Failed to read '${path}': ${extractErrorMessage(error)}` })

// With .withMessage(): message sealed by template, no input
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');
RecorderBusyErr()  // message: "A recording is already in progress", that's it

// With fields + .withMessage(): message computed from fields, sealed
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withFields<{ status: number }>()
  .withMessage(({ status }) => `HTTP ${status}`);
ResponseErr({ status: 404 })  // message: "HTTP 404", no message input exists
```

**Why no override?** Analysis of all 321 call sites in the Epicenter codebase revealed that no error type uses `.withMessage()` as a default that some call sites use and others override. Every error falls cleanly into one of two buckets:

1. **Template handles all messages**: static or computed from fields. Call sites never need to override.
2. **Every call site writes its own message**: the messages are too diverse for any template. `.withMessage()` would be dead code.

The override feature (making `message` optional when `.withMessage()` exists) served no real use case. It added type complexity (`message?: string` conditional optionality) for a scenario that doesn't occur in practice.

**The deeper argument:** Allowing overrides is a code smell because it lets developers avoid thinking about their error's message structure. If a template can't produce a good message for a call site, that's a signal: either the template needs better fields, or the error should be a different type. The override is an escape hatch that masks both of those design problems.

### 5. No `reason` convention: call sites pass `message` directly

The intermediate design proposed `reason: string` as a reserved field convention. This is rejected. `reason` is just `message` laundered through a field. Errors with dynamic messages skip `.withMessage()` and require `message` at the call site.

### 6. Two questions replace three tiers

Instead of Tier 1/2/3, decide per error type:

1. **Does this error have useful typed fields for programmatic handling?** → `.withFields<...>()`
2. **Is the message predictable from those fields (or always static)?** → `.withMessage(fn)`

If both are no, the error is `createTaggedError('XError')` and call sites pass `{ message }`.

## Implementation Order

1. Implement new API in wellcrafted (see canonical spec)
2. Publish new wellcrafted version
3. Update wellcrafted dependency in epicenter monorepo
4. Migrate epicenter services (see `20260226T000000-granular-error-migration.md`)
