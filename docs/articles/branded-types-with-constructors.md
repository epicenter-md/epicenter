# Branded Types with Constructor Functions

Branded types (also called nominal types or tagged types) add type safety to primitive values. A `UserId` is not interchangeable with a `PostId`, even though both are strings at runtime.

The problem: TypeScript's structural typing means you need type assertions (`as UserId`) to create branded values. These assertions scattered throughout a codebase become maintenance nightmares.

The solution: **Brand constructor functions** - a single function that creates branded values, containing the only type assertion in the codebase.

## The Pattern

```typescript
import type { Brand } from 'wellcrafted/brand';

// 1. Define the branded type
export type RowId = string & Brand<'RowId'>;

// 2. Create the brand constructor (PascalCase matches the type)
export function RowId(id: string): RowId {
  return id as RowId;
}
```

That's it. The `RowId()` function is the only place in the entire codebase that uses `as RowId`.

TypeScript allows a type and a value to share the same name - they live in different namespaces. This lets us use `RowId` for both.

## Why This Matters

### Before: Scattered Assertions

```typescript
// user-service.ts
const id = data.id as UserId;

// post-service.ts
function getPost(id: string) {
  return db.posts.get(id as PostId);
}

// api-handler.ts
const parsed = params.userId as UserId;

// component.ts
onClick={() => deleteUser(selectedId as UserId)}
```

Problems:
- **No single point of control** - assertions everywhere
- **Hard to add validation** - would need to change dozens of files
- **Invisible boundaries** - can't see where branding happens
- **Refactoring risk** - miss one spot and you have a bug

### After: Brand Constructors

```typescript
// user-service.ts
const id = UserId(data.id);

// post-service.ts
function getPost(id: string) {
  return db.posts.get(PostId(id));
}

// api-handler.ts
const parsed = UserId(params.userId);

// component.ts
onClick={() => deleteUser(UserId(selectedId))}
```

Benefits:
- **One assertion** - only in the constructor function
- **Easy to add validation** - change one function
- **Explicit boundaries** - `UserId()` calls mark branding points
- **Searchable** - find all branding with `UserId(`
- **No shadowing** - PascalCase constructor doesn't shadow camelCase parameters

## Adding Validation Later

The constructor is the perfect place to add runtime checks:

```typescript
export function RowId(id: string): RowId {
  if (id.includes(':')) {
    throw new Error(`RowId cannot contain ':' separator: "${id}"`);
  }
  if (id.length === 0) {
    throw new Error('RowId cannot be empty');
  }
  return id as RowId;
}
```

Every `RowId()` call in the codebase now validates automatically.

## Real Example: Cell Keys

In our cell workspace, we have `RowId` and `FieldId` branded types that combine into cell keys:

```typescript
// keys.ts
export type RowId = string & Brand<'RowId'>;
export type FieldId = string & Brand<'FieldId'>;
export type CellKey = `${RowId}:${FieldId}`;

// Brand constructors - only assertions in codebase
export function RowId(id: string): RowId {
  return id as RowId;
}

export function FieldId(id: string): FieldId {
  return id as FieldId;
}

// Functions require branded types
export function CellKey(rowId: RowId, fieldId: FieldId): CellKey {
  return `${rowId}:${fieldId}` as CellKey;
}

// Parsing returns branded types
export function parseCellKey(key: string): { rowId: RowId; fieldId: FieldId } {
  const [row, field] = key.split(':');
  return { rowId: RowId(row), fieldId: FieldId(field) };
}
```

Callers are explicit about branding:

```typescript
// Clear where strings become branded
const row = RowId(userInput);
const field = FieldId('title');
const key = CellKey(row, field);

// Or inline for simple cases
store.set(CellKey(RowId(id), FieldId('status')), 'active');
```

## Why PascalCase?

We use PascalCase for brand constructors (`RowId()` not `rowId()`) because:

1. **Matches the type name** - `RowId` the type and `RowId()` the constructor
2. **No parameter shadowing** - a `rowId` parameter doesn't shadow the `RowId()` function
3. **Familiar pattern** - similar to constructors in C#, Rust's `String::from`, etc.

```typescript
// With PascalCase: no shadowing, parameters keep natural names
function getRow(rowId: string) {
  return store.get(RowId(rowId));  // Works! Different cases
}

// With camelCase: forced to rename parameters
function getRow(row: string) {  // Can't use "rowId" - would shadow
  return store.get(rowId(row));
}
```

## Naming Convention

| Branded Type | Constructor |
|--------------|-------------|
| `RowId` | `RowId()` |
| `FieldId` | `FieldId()` |
| `UserId` | `UserId()` |
| `WorkspaceGuid` | `WorkspaceGuid()` |

The constructor uses **PascalCase matching the type name**.

## When to Use Branded Types

Good candidates:
- **IDs** - user IDs, post IDs, row IDs
- **Keys** - cache keys, storage keys
- **Paths** - file paths, URL paths
- **Tokens** - auth tokens, API keys

Not worth it for:
- Values only used in one place
- Types that already have rich structure (objects, classes)
- When the type system already distinguishes them

## The wellcrafted/brand Package

We use `Brand` from `wellcrafted/brand`:

```typescript
import type { Brand } from 'wellcrafted/brand';

type UserId = string & Brand<'UserId'>;
```

This creates a unique symbol-based brand that TypeScript tracks, preventing accidental mixing of branded types.

## Summary

1. **Define the type**: `type RowId = string & Brand<'RowId'>`
2. **Create the constructor**: `function RowId(s: string): RowId { return s as RowId }`
3. **Never use `as RowId` anywhere else**
4. **Call the constructor** at branding boundaries

The constructor is the gatekeeper. All strings must pass through it to become branded. This gives you one place to add validation, logging, or any other cross-cutting concern.
