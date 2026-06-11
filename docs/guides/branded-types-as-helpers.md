# `as*` Helpers Are the Third Part of the Branded-ID Pattern

When a branded ID flows through an arktype schema and into trusted internal call sites, the canonical shape is three exports: the validator, the inferred type, and an `as*` helper that is syntactic sugar for the assertion.

```typescript
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// 1. VALIDATOR: declared first, single source of truth.
export const UserId = type('string').as<string & Brand<'UserId'>>();

// 2. TYPE: derived from the validator.
export type UserId = typeof UserId.infer;

// 3. AS HELPER: syntactic sugar for `value as UserId`.
export const asUserId = (value: string): UserId => value as UserId;
```

That is it. The helper is optional: generators like `generateSavedTabId()` cover the "minted fresh" case, and the validator's `.assert(unknown)` covers the network-boundary case. Reach for the `as*` helper when external typed strings flow in (Better Auth user ids, URL params, DB columns) and you want a single named cast site.

## What the Helper Earns

The arktype validator is callable, but its signature is `(value: unknown) => T | ArkErrors`. At a trusted call site that already holds a `string`, you do not want to thread an error result through. The `as*` helper does one thing:

```typescript
export const asUserId = (value: string): UserId => value as UserId;
```

- **Constrained input**: `value: string` rejects accidental `unknown` widenings at compile time.
- **One assertion**: the function body is the only `as UserId` in the codebase.
- **Grep-friendly**: `asUserId(` finds every brand-cast site.
- **Cheap rename**: change the brand or the underlying primitive in the validator and the helper signature follows.

## Where the Helper Fits

```typescript
// Trusted string from another typed source
const userId = asUserId(c.var.user.id);
const ownerId = asOwnerId(c.req.param('ownerId')!);

// Test fixture
const cell = {
  userId: asUserId('user-1'),
  ownerId: asOwnerId('user-1'),
  // ...
} satisfies PersistedAuth;

// Schema validation throws: use the validator, not the helper
const parsed = PersistedAuth.assert(JSON.parse(rawCellJson));
```

## What Not to Do

```typescript
// Bad: scattered raw casts
const userId = c.var.user.id as UserId;
const another = processString(data as UserId);

// Bad: calling the validator at a trusted site (returns UserId | ArkErrors)
const userId = UserId(c.var.user.id); // type is `UserId | type.errors`
```

## JSDoc Convention

Always include a JSDoc above the helper that calls it out as syntactic sugar. The reader should know at a glance that this is a typed cast, not a runtime validator:

```typescript
/**
 * Syntactic sugar for `value as UserId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as UserId` appears.
 */
export const asUserId = (value: string): UserId => value as UserId;
```

## When You Do Not Need the Helper

Skip it when:

- The ID is minted fresh in this code: use `generateXxxId()` instead. See [Three Parts, One ID](../articles/three-part-branded-id-pattern.md).
- The branded type is only ever consumed from an arktype-validated schema: `id: UserId` in the schema body already produces a branded value.
- Path-style types that flow through a single `path.resolve()` choke point: cast there once. See [Absolute Path Type Safety](../articles/absolute-path-type-safety.md).

## Naming

`as` + the type name, camelCased: `asUserId`, `asOwnerId`, `asFileId`. The `as` prefix mirrors the runtime assertion and reads naturally: `asUserId(str)` says "treat this string as a UserId."

## Summary

1. **Declare the validator first**: `export const UserId = type('string').as<string & Brand<'UserId'>>()`
2. **Derive the type**: `export type UserId = typeof UserId.infer`
3. **Add `asXxx` if external strings flow in**: `export const asUserId = (value: string): UserId => value as UserId`
4. **Document it as syntactic sugar** in the JSDoc

The `as*` helper is the third optional part of the canonical branded-ID pattern. It is the only place `as UserId` appears in the codebase; everywhere else is the helper, the validator, or `.assert(...)`.
