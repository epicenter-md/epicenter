# Improve Actions Introspection

## Problem

Currently, when we need to get action names from a workspace (e.g., for displaying available tools or generating REST endpoints), we have to call the `actions` factory with fake dependencies:

```typescript
const actionKeys = Object.keys(workspace.actions({ db: {} as any, indexes: {} as any, workspaces: {} as any }));
```

This is hacky and error-prone. The pattern appears in multiple places:
- `packages/epicenter/examples/content-hub/server-http.ts:61`
- `packages/epicenter/src/cli/commands/serve.ts:44`
- `packages/epicenter/src/cli/commands/serve.ts:63`

## Root Cause

The `actions` field in `WorkspaceConfig` is a factory function:

```typescript
exports: (context: {
  db: Db<TWorkspaceSchema>;
  workspaces: WorkspacesToActionMaps<TDeps>;
  indexes: TIndexResults;
}) => TActionMap;
```

This design requires dependencies to execute, but sometimes we only need the action shape/names without actual execution.

## Solution Options

### Option 1: Add a separate `actionNames` property (❌ Rejected)
- Requires manual duplication
- Can get out of sync with actual actions
- Adds maintenance burden

### Option 2: Use TypeScript's `ReturnType` for types only (⚠️ Partial)
- Works for type-level needs
- Doesn't help with runtime introspection
- Still need fake dependencies for runtime

### Option 3: Add a static metadata property to workspace (✅ Recommended)
- Add `actionNames` as a computed property during workspace initialization
- Cache the action keys when the workspace is first created
- No fake dependencies needed at usage sites

### Option 4: Create a utility helper (✅ Recommended - Simpler)
- Create a `getActionNames()` helper that safely extracts action names
- Centralize the "fake dependencies" pattern in one place
- Easy to find and maintain

## Proposed Solution (UPDATED)

After reviewing the code, the real issue is that we're logging action names BEFORE creating the client. The `createHttpServer` function already creates a real client with real dependencies and extracts action names from it (line 48-50 in http.ts).

**Better approach:**
1. Change `createHttpServer` to return `{ app, client }` instead of just `app`
2. Move logging in `serve.ts` and `server-http.ts` to AFTER server creation
3. Use the real client to get action names (just like http.ts does internally)
4. Remove all fake dependency calls

This eliminates the hacky pattern entirely by using real, initialized clients.

### Why This is Better

**Current approach (bad):**
```typescript
// BEFORE server creation - need fake dependencies
const actionKeys = Object.keys(workspace.actions({ db: {} as any, ... }));
```

**New approach (good):**
```typescript
// AFTER server creation - use real client
const { app, client } = await createHttpServer(config);
const workspaceClient = client[workspace.name];
const actionKeys = Object.keys(workspaceClient).filter(key =>
  typeof workspaceClient[key] === 'function' && key !== 'destroy'
);
```

### No Downsides

The only "cost" is that we initialize the client (which we were going to do anyway) before logging. The logging happens a few milliseconds later but with real data instead of fake dependencies.

## Implementation Plan

- [x] Update `createHttpServer` return type to `{ app, client }` instead of just `Hono`
- [x] Move logging in `serve.ts` to after server creation, use real client
- [x] Move logging in `server-http.ts` example to after server creation, use real client
- [x] Update any other code that calls `createHttpServer` to handle new return shape

## Review

### Changes Made

1. **Updated `createHttpServer` signature** (packages/epicenter/src/server/http.ts):
   - Changed return type from `Promise<Hono>` to `Promise<{ app: Hono; client: EpicenterClient<TWorkspaces> }>`
   - Added JSDoc comments on the returned object properties
   - Updated example in JSDoc to show destructured usage

2. **Updated serve command** (packages/epicenter/src/cli/commands/serve.ts):
   - Destructured `{ app, client }` from `createHttpServer`
   - Removed all fake dependency calls: `workspace.actions({ db: {} as any, ... })`
   - Used real client to get action names: `Object.keys(client[workspace.name])`
   - Applied proper filtering: `typeof workspaceClient[key] === 'function' && key !== 'destroy'`

3. **Updated server-http.ts example** (packages/epicenter/examples/content-hub/server-http.ts):
   - Destructured `{ app, client }` from `createHttpServer`
   - Removed fake dependency calls
   - Used real client for logging available tools and REST endpoints

4. **Updated all test files**:
   - packages/epicenter/tests/integration/server.test.ts (2 occurrences)
   - packages/epicenter/examples/e2e-tests/server.test.ts
   - packages/epicenter/examples/content-hub/server.test.ts
   - packages/epicenter/examples/content-hub/mcp.test.ts

### Result

**Before:**
```typescript
// Hacky pattern with fake dependencies
const actionKeys = Object.keys(
  workspace.actions({ db: {} as any, indexes: {} as any, workspaces: {} as any })
);
```

**After:**
```typescript
// Clean pattern using real, initialized client
const { app, client } = await createHttpServer(config);
const workspaceClient = client[workspace.name as keyof typeof client];
const actionKeys = Object.keys(workspaceClient as any).filter(
  (key) => typeof workspaceClient[key] === 'function' && key !== 'destroy'
);
```

### Benefits

1. **No more fake dependencies**: Completely eliminated the `{ db: {} as any, ... }` pattern
2. **Uses real data**: Action names come from the actual initialized client
3. **Single source of truth**: Same pattern used throughout (http.ts, serve.ts, examples)
4. **Better API**: Explicit return structure makes it clear what you get
5. **Type-safe**: Full TypeScript support with JSDoc annotations

### Breaking Change

This is a breaking change for any code calling `createHttpServer`. The migration is straightforward:

```typescript
// Old
const app = await createHttpServer(config);

// New
const { app } = await createHttpServer(config);
// or if you need the client
const { app, client } = await createHttpServer(config);
```
