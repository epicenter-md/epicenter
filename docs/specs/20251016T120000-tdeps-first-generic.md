# Reorganize WorkspaceConfig Generics: TDeps First

**Timestamp:** 20251016T120000
**Status:** Planning

## Summary

Reorganize the generic parameters in `WorkspaceConfig` and related types to move `TDeps` (dependencies) to be the first generic parameter. This change affects all type definitions and function signatures that use `WorkspaceConfig`.

## Current Generic Order

```typescript
WorkspaceConfig<
  TId,           // 1. string
  TVersion,      // 2. number
  TName,         // 3. string
  TWorkspaceSchema,  // 4. WorkspaceSchema
  TDeps,         // 5. readonly DependencyWorkspaceConfig[]
  TIndexes,      // 6. WorkspaceIndexMap
  TActionMap     // 7. WorkspaceActionMap
>
```

## New Generic Order

```typescript
WorkspaceConfig<
  TDeps,         // 1. readonly DependencyWorkspaceConfig[] (moved from position 5)
  TId,           // 2. string
  TVersion,      // 3. number
  TName,         // 4. string
  TWorkspaceSchema,  // 5. WorkspaceSchema
  TIndexes,      // 6. WorkspaceIndexMap
  TActionMap     // 7. WorkspaceActionMap
>
```

## Files to Update

### 1. `/packages/epicenter/src/core/workspace/config.ts`
- [ ] Update `defineWorkspace` function generic parameters
- [ ] Update `WorkspaceConfig` type generic parameters
- [ ] Update any default type parameter order

### 2. `/packages/epicenter/src/core/workspace/client.ts`
- [ ] Update `createWorkspaceClient` function generic parameters
- [ ] Update any type references to `WorkspaceConfig`

### 3. `/packages/epicenter/src/server/workspace.ts`
- [ ] Update `createWorkspaceServer` function generic parameters
- [ ] Update any type references to `WorkspaceConfig`

### 4. `/packages/epicenter/src/core/epicenter.ts`
- [ ] Update `WorkspaceToClientEntry` type helper
- [ ] Update any type references to `WorkspaceConfig`

### 5. Search for all other references
- [ ] Search for any test files or examples that might have explicit type annotations
- [ ] Update any inline type references

## Implementation Steps

1. Update core `WorkspaceConfig` type definition in `config.ts`
2. Update `defineWorkspace` function signature in `config.ts`
3. Update `createWorkspaceClient` in `client.ts`
4. Update `createWorkspaceServer` in `workspace.ts`
5. Update type helpers in `epicenter.ts`
6. Search for and update any remaining references
7. Run type checks to ensure no breaks
8. Run tests to verify functionality

## Testing Strategy

- Run TypeScript type checking: `bun run typecheck`
- Run all tests: `bun test`
- Check that no type errors are introduced

## Rationale

Dependencies (TDeps) are conceptually the most important generic parameter because they determine the structure of the dependency graph and affect the entire workspace initialization order. Making it the first generic parameter emphasizes its importance and makes the type signature more intuitive.
