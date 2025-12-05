# Remove Runtime Config

**Date**: 2025-10-17
**Status**: Proposed

## Context

RuntimeConfig was added to provide flexibility for future runtime configuration needs (YJS persistence strategies, custom asset storage locations, etc.). However, it's currently:

1. An empty type: `export type RuntimeConfig = {}`
2. Never actually used for anything
3. Passed around as an optional parameter throughout the codebase
4. Adding unnecessary complexity to the API

The original thinking was to have values that could change while the app is running. But in practice:
- Known at startup values should use environment variables or initialization config
- Values that change during runtime should use state management
- User preferences should live in the data layer (database, localStorage)

Runtime config objects make sense for:
- Plugin systems where plugins need to read/write shared settings
- Multi-tenant systems where config varies per tenant/request
- Values that actually change while the app is running

None of these apply to our use case.

## Decision

Remove RuntimeConfig entirely and simplify the API.

## Files to Modify

- `packages/epicenter/src/core/workspace/index.ts` - Remove RuntimeConfig export
- `packages/epicenter/src/core/workspace/client.ts` - Remove RuntimeConfig type and parameter
- `packages/epicenter/src/core/epicenter.ts` - Remove runtimeConfig parameter
- `packages/epicenter/src/server/workspace.ts` - Remove runtimeConfig parameter
- `packages/epicenter/src/server/epicenter.ts` - Remove runtimeConfig parameter
- `packages/epicenter/src/cli/generate.ts` - Remove runtimeConfig parameter
- `packages/epicenter/src/index.ts` - Remove RuntimeConfig export (if present)

## Changes

### 1. Remove RuntimeConfig type definition

In `packages/epicenter/src/core/workspace/client.ts`:
- Remove entire RuntimeConfig type and its documentation (lines 11-72)
- Remove RuntimeConfig from exports in `packages/epicenter/src/core/workspace/index.ts`
- Remove RuntimeConfig from exports in `packages/epicenter/src/index.ts` (if present)

### 2. Remove runtimeConfig parameter from initializeWorkspaces

In `packages/epicenter/src/core/workspace/client.ts`:
- Remove `config: RuntimeConfig = {}` parameter from `initializeWorkspaces()`
- Update function signature and JSDoc

### 3. Remove runtimeConfig parameter from createWorkspaceClient

In `packages/epicenter/src/core/workspace/client.ts`:
- Remove `config: RuntimeConfig = {}` parameter from `createWorkspaceClient()`
- Update function signature and JSDoc
- Remove the parameter from the `initializeWorkspaces()` call

### 4. Remove runtimeConfig parameter from createEpicenterClient

In `packages/epicenter/src/core/epicenter.ts`:
- Remove `runtimeConfig: RuntimeConfig = {}` parameter
- Update function signature and JSDoc
- Remove the parameter from the `initializeWorkspaces()` call

### 5. Remove runtimeConfig from server functions

In `packages/epicenter/src/server/workspace.ts`:
- Remove `runtimeConfig?: RuntimeConfig` parameter from `createWorkspaceRouter()`
- Update JSDoc
- Remove the parameter from the `createWorkspaceClient()` call

In `packages/epicenter/src/server/epicenter.ts`:
- Remove `runtimeConfig?: RuntimeConfig` parameter from `createEpicenterRouter()`
- Update JSDoc
- Remove the parameter from the `createEpicenterClient()` call

### 6. Remove runtimeConfig from CLI functions

In `packages/epicenter/src/cli/generate.ts`:
- Remove `runtimeConfig?: RuntimeConfig` parameter from both `generate()` functions
- Update JSDoc
- Remove the parameter from the `createWorkspaceClient()` call

## Implementation Checklist

- [ ] Remove RuntimeConfig type from `client.ts`
- [ ] Remove RuntimeConfig export from `workspace/index.ts`
- [ ] Remove RuntimeConfig export from `index.ts` (if present)
- [ ] Remove runtimeConfig parameter from `initializeWorkspaces()`
- [ ] Remove runtimeConfig parameter from `createWorkspaceClient()`
- [ ] Remove runtimeConfig parameter from `createEpicenterClient()`
- [ ] Remove runtimeConfig parameter from `createWorkspaceRouter()`
- [ ] Remove runtimeConfig parameter from `createEpicenterRouter()`
- [ ] Remove runtimeConfig parameter from CLI `generate()` functions
- [ ] Run tests to ensure nothing breaks
- [ ] Update any example code that uses these functions

## Testing

After changes:
1. Run `bun test` to ensure all tests pass
2. Check that no TypeScript errors are introduced
3. Verify that the API is simpler and easier to understand

## Rollback Plan

If needed, git revert the commit. The change is purely a removal, so rollback is straightforward.

## Review

All RuntimeConfig references have been successfully removed from the codebase:

### Files Modified
1. `packages/epicenter/src/core/workspace/client.ts` - Removed RuntimeConfig type definition (~60 lines)
2. `packages/epicenter/src/core/workspace/index.ts` - Removed RuntimeConfig export
3. `packages/epicenter/src/index.ts` - Removed RuntimeConfig export
4. `packages/epicenter/src/core/epicenter.ts` - Removed runtimeConfig parameter from createEpicenterClient()
5. `packages/epicenter/src/server/workspace.ts` - Removed runtimeConfig parameter from createWorkspaceServer()
6. `packages/epicenter/src/server/epicenter.ts` - Removed runtimeConfig parameter from createEpicenterServer()
7. `packages/epicenter/src/cli/generate.ts` - Removed runtimeConfig parameter from generateCLI() and executeAction()

### API Changes
All public functions now have one fewer parameter:

**Before:**
```typescript
createEpicenterClient(config, runtimeConfig)
createWorkspaceClient(workspace, runtimeConfig)
createWorkspaceServer(config, runtimeConfig)
createEpicenterServer(config, runtimeConfig)
generateCLI(config, runtimeConfig)
```

**After:**
```typescript
createEpicenterClient(config)
createWorkspaceClient(workspace)
createWorkspaceServer(config)
createEpicenterServer(config)
generateCLI(config)
```

### Test Status
Tests show failures unrelated to RuntimeConfig removal. The failures are due to a separate change where the API was converted from `destroy()` + `[Symbol.asyncDispose]()` to `[Symbol.dispose]()`. This was done automatically by the linter/formatter and is outside the scope of this RuntimeConfig removal task.

### Impact
- Simplified API with fewer parameters
- Removed ~100 lines of unused code
- No breaking changes to actual functionality (RuntimeConfig was empty and unused)
