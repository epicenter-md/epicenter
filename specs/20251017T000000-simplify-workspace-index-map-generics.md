# Simplify Workspace Index Map Generics

**Created**: 2025-10-17
**Status**: Planning

## Context

Currently, the workspace configuration system uses a generic `TIndexMap` parameter throughout the type system. This generic is passed down through multiple layers (`WorkspaceConfig`, `ImmediateDependencyWorkspaceConfig`, `createWorkspaceClient`, etc.), making the type signatures more complex than necessary.

The `indexes` property in `WorkspaceConfig` is a function that takes a `db` parameter and returns the index map. We want to encapsulate this function signature into its own type called `WorkspaceIndexMapConstructor`.

## Current State

```typescript
// packages/epicenter/src/core/indexes.ts
export type WorkspaceIndexMap = Record<string, Index>;

// packages/epicenter/src/core/workspace/config.ts
export type WorkspaceConfig<
  // ... other generics
  TIndexMap extends WorkspaceIndexMap = WorkspaceIndexMap,
  // ... other generics
> = {
  indexes: (context: { db: Db<NoInfer<TWorkspaceSchema>> }) => TIndexMap;
  // ... other properties
};
```

## Proposed Changes

### 1. Create `WorkspaceIndexMapConstructor` Type

Create a new type that encapsulates the function signature for creating index maps:

```typescript
// packages/epicenter/src/core/indexes.ts
export type WorkspaceIndexMap = Record<string, Index>;

export type WorkspaceIndexMapConstructor<TWorkspaceSchema extends WorkspaceSchema> =
  (context: { db: Db<NoInfer<TWorkspaceSchema>> }) => WorkspaceIndexMap;
```

### 2. Simplify `WorkspaceConfig`

Remove the `TIndexMap` generic parameter and use `WorkspaceIndexMapConstructor` directly:

```typescript
export type WorkspaceConfig<
  TDeps extends readonly ImmediateDependencyWorkspaceConfig[] = readonly ImmediateDependencyWorkspaceConfig[],
  TId extends string = string,
  TVersion extends number = number,
  TName extends string = string,
  TWorkspaceSchema extends WorkspaceSchema = WorkspaceSchema,
  // TIndexMap removed
  TActionMap extends WorkspaceActionMap = WorkspaceActionMap,
> = {
  // ... other properties
  indexes: WorkspaceIndexMapConstructor<TWorkspaceSchema>;
  // ... other properties
};
```

### 3. Simplify `ImmediateDependencyWorkspaceConfig`

Remove the `TIndexMap` generic and use `WorkspaceIndexMap` directly (note: this is the result type, not the function):

```typescript
export type ImmediateDependencyWorkspaceConfig<
  TDeps extends readonly DependencyWorkspaceConfig[] = readonly DependencyWorkspaceConfig[],
  TId extends string = string,
  TVersion extends number = number,
  TName extends string = string,
  TWorkspaceSchema extends WorkspaceSchema = WorkspaceSchema,
  // TIndexMap removed
  TActionMap extends WorkspaceActionMap = WorkspaceActionMap,
> = {
  // ... other properties
  indexes: WorkspaceIndexMap;
  // ... other properties
};
```

### 4. Update `defineWorkspace`

Remove the `TIndexMap` generic parameter:

```typescript
export function defineWorkspace<
  const TDeps extends readonly ImmediateDependencyWorkspaceConfig[],
  const TId extends string,
  const TVersion extends number,
  const TName extends string,
  TWorkspaceSchema extends WorkspaceSchema,
  // TIndexMap removed
  TActionMap extends WorkspaceActionMap,
>(
  workspace: WorkspaceConfig<
    TDeps,
    TId,
    TVersion,
    TName,
    TWorkspaceSchema,
    // TIndexMap removed
    TActionMap
  >,
): WorkspaceConfig<TDeps, TId, TVersion, TName, TWorkspaceSchema, TActionMap>
```

### 5. Update `createWorkspaceClient`

Remove the `TIndexMap` generic parameter:

```typescript
export function createWorkspaceClient<
  const TDeps extends readonly ImmediateDependencyWorkspaceConfig[],
  const TId extends string,
  const TVersion extends number,
  TWorkspaceSchema extends WorkspaceSchema,
  // TIndexMap removed
  TActionMap extends WorkspaceActionMap,
>(
  workspace: WorkspaceConfig<
    TDeps,
    TId,
    TVersion,
    string,
    TWorkspaceSchema,
    // TIndexMap removed
    TActionMap
  >,
): WorkspaceClient<TActionMap>
```

### 6. Keep `IndexesAPI` Generic

The `IndexesAPI` type should remain generic since it extracts query maps from indexes, but users won't need to specify it explicitly:

```typescript
export type IndexesAPI<TIndexMap extends WorkspaceIndexMap = WorkspaceIndexMap> = {
  [K in keyof TIndexMap]: TIndexMap[K] extends Index<infer TQueryMap>
    ? TQueryMap
    : never;
};
```

## Benefits

1. **Simpler Type Signatures**: Removes one generic parameter from the main workspace types
2. **Better Encapsulation**: The function signature is now a named type that can be documented and reused
3. **Clearer Intent**: `WorkspaceIndexMapConstructor` clearly indicates this is a factory function
4. **No Runtime Impact**: This is purely a type-level refactoring with no runtime changes

## Todo List

- [ ] Add `WorkspaceIndexMapConstructor` type to `packages/epicenter/src/core/indexes.ts`
- [ ] Update `WorkspaceConfig` type in `packages/epicenter/src/core/workspace/config.ts`
- [ ] Update `ImmediateDependencyWorkspaceConfig` type in `packages/epicenter/src/core/workspace/config.ts`
- [ ] Update `defineWorkspace` function in `packages/epicenter/src/core/workspace/config.ts`
- [ ] Update `createWorkspaceClient` function in `packages/epicenter/src/core/workspace/client.ts`
- [ ] Run tests to ensure no type errors
- [ ] Review the changes

## Review

(To be filled after implementation)
