# Branded Types with an Arktype Validator and an `as*` Helper

Branded types (also called nominal types or tagged types) add type safety to primitive values. A `UserId` is not interchangeable with a `PostId`, even though both are strings at runtime.

The problem: TypeScript's structural typing means you need type assertions (`as UserId`) to create branded values. These assertions scattered throughout a codebase become maintenance nightmares.

The solution: **declare the type first, annotate the arktype validator to it, and (optionally) expose an `as*` helper that is the single place `as UserId` appears in the codebase.**

## The Canonical Three-Part Pattern

```typescript
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// 1. TYPE: declared first, the single place the brand is written.
//    TypeScript keeps value space and type space separate, so the
//    same identifier `UserId` is the branded type in type positions
//    and the validator in value positions.
export type UserId = string & Brand<'UserId'>;

// 2. VALIDATOR: annotated to the type, so the schema conforms to
//    the brand. Use inside arktype schemas (`id: UserId`) and to
//    validate `unknown` boundary values.
export const UserId = type('string').as<UserId>();

// 3. AS HELPER (optional): syntactic sugar for `value as UserId`.
//    The constrained `string` parameter is what earns it over a raw
//    `as`: callers can't accidentally widen to `unknown`. The only
//    place in the codebase where `as UserId` appears.
export const asUserId = (value: string): UserId => value as UserId;
```

That is it. `UserId` is the validator and the type. `asUserId` is the only spot the `as UserId` assertion lives.

## Why Type First

The brand is written once, in the declaration a reader looks at, and the name survives into every hover and error message downstream. Deriving with `typeof UserId.infer` resolves through arktype's distillation and prints the expanded intersection instead of the alias. [Same Name for Type and Value](./same-name-for-type-and-value.md) has the measured comparison.

Object schemas are the other case. Their types are genuinely computed, so they keep `typeof X.infer`: you cannot state a twelve-field shape without writing it twice. A branded primitive has nothing to derive.

## Why an `as*` Helper

The arktype validator is callable, but its signature is `(value: unknown) => T | ArkErrors`. At a trusted call site that already holds a `string`, you do not want to thread an error result through.

`asUserId(value: string): UserId` is a typed cast in one place: the input is constrained to `string` at compile time, the body is the only `as UserId` in the codebase, and it is grep-friendly when auditing brand boundaries.

```typescript
// Good: syntactic sugar, intent obvious
const userId = asUserId(c.var.user.id);
const ownerId = asOwnerId(params.ownerId);

// Bad: scattered raw casts, hard to grep
const userId = c.var.user.id as UserId;
```

For genuinely untyped boundaries (parsing `unknown` JSON, network input) use the validator's `.assert(value)` or a schema-level validator like `PersistedAuth.assert(...)`. Those throw on shape mismatch; the `as*` helper trusts the compiler.

## Schemas Use the Same Name

Because the validator and the type share `UserId`, schema bodies read with no `Schema` suffix anywhere:

```typescript
export const ApiSessionResponse = type({
  '+': 'delete',
  user: { id: UserId, email: 'string' },
  ownerId: OwnerId,
  keyring: Keyring,
  mode: OwnershipMode,
});
export type ApiSessionResponse = typeof ApiSessionResponse.infer;
```

A separate `UserIdSchema` export is rejected: it contradicts the shared-name idiom and forces every schema body to read `id: UserIdSchema` instead of `id: UserId`. See [Let Arktype Values and Types Share the Name](./arktype-values-and-types-should-share-the-name.md).

## Variants by ID Origin

The three-part pattern flexes by what kind of value the third part needs to produce.

| Origin of the value                         | Third part                                      |
| ------------------------------------------- | ----------------------------------------------- |
| Minted fresh by this code                   | `generateXxx()` wrapping `generateId() as Xxx`  |
| Received as a typed string (auth, URL, DB)  | `asXxx(value: string)` syntactic-sugar helper   |
| Received as `unknown` at a network boundary | None: use the validator or `.assert(unknown)`  |
| Set from an external source, never minted   | `asXxx` helper                                  |

Examples in the repo:

- **Workspace IDs minted fresh** (`SavedTabId`, `ConversationId`, `FileId`): type + validator + `generateSavedTabId`. See [Three Parts, One ID](./three-part-branded-id-pattern.md).
- **Auth and owner IDs from typed strings** (`UserId`, `OwnerId`): type + validator + `asUserId` or `asOwnerId`. See `packages/auth/src/auth-types.ts` and `packages/identity/src/identity.ts`.
- **Path types** (`AbsolutePath`): often just the type alias, because callers resolve through a `path.resolve()` choke point. See [Absolute Path Type Safety](./absolute-path-type-safety.md).

## Why PascalCase

The validator and the type share PascalCase because:

1. **Matches the type name**: `UserId` the type and `UserId` the validator are visually one concept.
2. **No parameter shadowing**: a `userId` parameter does not shadow the `UserId` validator.
3. **Hover docs flow through**: TypeScript merges JSDoc from the type and the const, so consumers get the same tooltip from a function parameter, a schema field, or an import.

## Adding Validation Later

The validator is already the place to add runtime checks. If you want `UserId` to reject `':'` characters everywhere, narrow the validator:

```typescript
export const UserId = type('string > 0').narrow((s, ctx) =>
  s.includes(':') ? ctx.mustBe('a colon-free user id') : true,
).as<UserId>();
```

Every schema that composes `UserId` and every `UserId.assert(...)` call inherits the check. The `asUserId` helper stays a typed cast because its inputs are already trusted strings, and it must: `as*` means free and unchecked. A helper that grows a runtime check has stopped being an `as*` and needs a different name.

## When to Use Branded Types

Good candidates:

- **IDs**: user ids, post ids, row ids
- **Keys**: cache keys, storage keys
- **Paths**: absolute paths, URL paths
- **Tokens**: auth tokens, API keys

Not worth it for:

- Values used in exactly one place
- Types that already have rich structure (objects, classes)
- Values where the type system already distinguishes them

## Summary

1. **Declare the type first**: `export type UserId = string & Brand<'UserId'>`
2. **Annotate the validator to it**: `export const UserId = type('string').as<UserId>()`
3. **Add an `asXxx` helper if external strings flow in**: `export const asUserId = (value: string): UserId => value as UserId`
4. **Never write `as UserId` anywhere else**: the helper (or a `generate*` wrapper) is the only place.

The validator is the gatekeeper. All boundary strings pass through `.assert()` or the named schema; all trusted strings pass through `asXxx`. One place to change the brand, one place to add validation, one place to grep when auditing.
