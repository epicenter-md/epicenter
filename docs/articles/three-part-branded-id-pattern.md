# Three Parts, One ID: Type the Brand, Validate the Schema, Generate the Value

Every generated branded ID in the workspace codebase follows the same three-part pattern. The type brands the string, the validator slots into `defineTable()` schemas, and the generator wraps `generateId()` so the cast lives in one place. A `SavedTabId` with all three parts looks like this:

```typescript
export type SavedTabId = Id & Brand<'SavedTabId'>;
export const SavedTabId = type('string').as<SavedTabId>();
export const generateSavedTabId = (): SavedTabId =>
  generateId() as SavedTabId;
```

## Extend the base Id type to simplify the factory cast

The base type extends `Id` (which is `string & Brand<'Id'>`) rather than bare `string`. This means the factory only needs a single cast (`generateId() as SavedTabId`) instead of the double cast (`generateId() as string as SavedTabId`). Since `generateId()` returns `Id`, the types are compatible without stripping the brand first.

```typescript
// Good: compatible with generateId()
export type SavedTabId = Id & Brand<'SavedTabId'>;

// Bad: requires double cast
export type SavedTabId = string & Brand<'SavedTabId'>;
```

## Use .as<>() for zero-cost type assertions in Arktype

Both `.as<>()` and `.pipe()` create the same runtime validator, but `.as<>()` is a zero-cost type assertion. Arktype knows the output type without a pipe function, which keeps the schema definition clean. The pipe version is three lines of ceremony for the same result.

```typescript
// Good: concise and zero-cost
export const SavedTabId = type('string').as<SavedTabId>();

// Bad: unnecessary ceremony
export const SavedTabId = type('string').pipe((s): SavedTabId => s as SavedTabId);
```

## Distinguish generators from constructors with the generate prefix

The codebase distinguishes generators from constructors. `generate*` means a new ID from scratch that calls `generateId()` or nanoid. `create*` means assembling an ID from inputs, like `createTabCompositeId(deviceId, tabId)`. Both are factory functions, but the prefix signals the difference.

```typescript
// New ID from scratch
export const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId;

// Assembled from inputs
export const createTabCompositeId = (deviceId: DeviceId, tabId: TabId): TabCompositeId =>
  `${deviceId}:${tabId}` as TabCompositeId;
```

## Each part serves a specific purpose in the schema

| Part | When to use |
| --- | --- |
| Type | Always |
| Validator | When used in `defineTable()` or Arktype schemas |
| Generator | When IDs are created at runtime |

You can find the canonical implementation with 7 branded types and 4 generators in `apps/tab-manager/src/lib/workspace.ts`. Every ID in the system stays type-safe and validated at the boundary without leaking implementation details.
