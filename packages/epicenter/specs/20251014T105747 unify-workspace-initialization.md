# Unify Workspace Initialization Logic

## Problem

Currently, `createWorkspaceClient` and `createEpicenterClient` have nearly identical initialization logic but are implemented separately:

- `createWorkspaceClient`: Does 4-phase initialization (registration, dependency graph, topological sort, initialize in order) for a single workspace and its dependencies. Returns a single workspace client.
- `createEpicenterClient`: Currently just naively calls `createWorkspaceClient` on each workspace independently, creating duplicate instances with separate YDocs.

This causes test failures where data written to `client.pages` isn't visible to `client.contentHub` because they have separate instances of the `pages` workspace.

## Goal

Unify the initialization logic so both functions use the same core algorithm, eliminating duplication and ensuring workspace instances are properly shared.

## Approach

### Phase 1: Extract Core Initialization Logic

Create a new internal function `initializeWorkspaces` that:
- Takes an array of "root" workspace configs
- Collects all workspace configs (roots + all transitive dependencies)
- Performs version resolution (highest version wins)
- Builds dependency graph and validates
- Performs topological sort
- Initializes workspaces in order, sharing already-initialized clients
- Returns a `Map<workspaceId, WorkspaceClient>`

### Phase 2: Refactor createWorkspaceClient

Update `createWorkspaceClient` to:
- Call `initializeWorkspaces([workspace])`
- Extract and return just the root workspace's client from the map

### Phase 3: Refactor createEpicenterClient

Update `createEpicenterClient` to:
- Call `initializeWorkspaces(config.workspaces)`
- Build the epicenter client object by mapping workspace names to their clients
- Add destroy and Symbol.asyncDispose methods

## Implementation Plan

### Step 1: Create `initializeWorkspaces` function
- [ ] Extract phases 1-4 from `createWorkspaceClient` into new function
- [ ] Modify to accept array of root workspaces instead of single workspace
- [ ] Return `Map<string, WorkspaceClient<any>>` with all initialized clients
- [ ] Keep the same logic for registration, dependency resolution, topological sort, and initialization

### Step 2: Update `createWorkspaceClient`
- [ ] Replace existing logic with call to `initializeWorkspaces([workspace])`
- [ ] Extract root workspace client from returned map
- [ ] Ensure return type remains `WorkspaceClient<TActionMap>`
- [ ] Verify existing behavior is preserved

### Step 3: Update `createEpicenterClient`
- [ ] Replace current naive implementation with call to `initializeWorkspaces(config.workspaces)`
- [ ] Build result object by mapping workspace names to clients from the map
- [ ] Create shared cleanup function that destroys all clients
- [ ] Ensure return type remains `EpicenterClient<TWorkspaces>`

### Step 4: Run tests and verify
- [ ] Run `bun test src/core/epicenter.test.ts` to verify tests pass
- [ ] Run all workspace tests to ensure no regressions
- [ ] Verify that workspaces properly share data across epicenter boundaries

## Key Design Decisions

### Input: Array of Root Workspaces
`initializeWorkspaces` accepts an array of root workspace configs. For `createWorkspaceClient`, this is a single-element array. For `createEpicenterClient`, this is the full workspace array from the epicenter config.

### Registration Phase
The function will register all root workspaces FIRST, then process their dependencies. This ensures that if multiple roots depend on the same workspace, version resolution picks the highest version across all roots.

### Output: Map of All Clients
Return all initialized workspace clients, not just the roots. This gives both functions flexibility in what they return to the user.

### Workspace Sharing
When contentHub depends on pages, and both are in the epicenter config, contentHub will receive the already-initialized pages client instead of creating a duplicate.

## Example

```typescript
// Before (broken):
const client = await createEpicenterClient({ workspaces: [pages, contentHub] });
// pages and contentHub.workspaces.pages are DIFFERENT instances

// After (fixed):
const client = await createEpicenterClient({ workspaces: [pages, contentHub] });
// pages and contentHub.workspaces.pages are THE SAME instance
```

## Files to Modify

1. `packages/epicenter/src/core/workspace/client.ts`
   - Extract `initializeWorkspaces` function
   - Refactor `createWorkspaceClient` to use it

2. `packages/epicenter/src/core/epicenter.ts`
   - Refactor `createEpicenterClient` to use `initializeWorkspaces`

## Testing Strategy

Run the existing test suite:
- `packages/epicenter/src/core/epicenter.test.ts` should pass completely
- `packages/epicenter/src/core/workspace.test.ts` should continue to pass
- Specific tests that should now pass:
  - "should chain workspaces: create page and distribute to social media"
  - "should chain workspaces: create multiple pages and posts"

## Review

### Implementation Summary

Successfully unified workspace initialization logic by extracting the core 4-phase algorithm into a shared `initializeWorkspaces` function.

### Changes Made

1. **Created `initializeWorkspaces` function** in `packages/epicenter/src/core/workspace/client.ts`:
   - Accepts an array of root workspace configs
   - Modified registration phase to loop through all roots and their dependencies
   - Returns `Map<string, WorkspaceClient<any>>` with all initialized clients
   - Exported for use by epicenter

2. **Refactored `createWorkspaceClient`**:
   - Now calls `initializeWorkspaces([workspace])`
   - Extracts and returns just the root workspace's client
   - Maintains exact same behavior and return type

3. **Refactored `createEpicenterClient`** in `packages/epicenter/src/core/epicenter.ts`:
   - Now calls `initializeWorkspaces(config.workspaces)`
   - Maps workspace names to their clients from the returned map
   - Updates cleanup function to destroy all clients from the map
   - Maintains exact same behavior and return type

### Test Results

All tests pass successfully:
- `src/core/epicenter.test.ts`: 8 tests pass (previously 2 failures)
- `src/core/workspace.test.ts`: 7 tests pass (no regressions)

Previously failing tests now pass:
- "should chain workspaces: create page and distribute to social media" ✅
- "should chain workspaces: create multiple pages and posts" ✅

### Key Outcomes

- [x] All tests pass
- [x] No code duplication between the two client creation functions
- [x] Workspace instances are properly shared across epicenter boundaries
- [x] Type safety is maintained
- [x] When `contentHub` depends on `pages`, both workspaces now share the same YDoc instance

### Impact

The bug where `client.pages` and `client.contentHub.workspaces.pages` were different instances is now fixed. All workspaces initialized within an epicenter client properly share state through the same YDoc instances.
