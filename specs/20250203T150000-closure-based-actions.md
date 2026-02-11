# Closure-Based Actions: Remove Context Parameter

## Status

**Completed**: 2026-02-03

All phases implemented successfully. 485 tests pass.

## Executive Summary

**Goal:** Simplify the action system by removing the `ctx` parameter entirely. Actions close over the client directly instead of receiving it as a parameter.

**Breaking Change:** Yes. No backwards compatibility. Remove all `ctx`-related code.

**Before:**
```typescript
const client = createWorkspace({ ... }).withActions({
  getPosts: defineQuery({
    handler: (ctx) => ctx.tables.posts.getAllValid(),
  }),
});
```

**After:**
```typescript
const client = createWorkspace({ ... });

const actions = {
  getPosts: defineQuery({
    handler: () => client.tables.posts.getAllValid(),  // closes over client
  }),
};

createServer({ client, actions });
createCLI({ client, actions });
```

## Motivation

### The Problem with `ctx`

The current design passes context as a runtime parameter:

```typescript
type ActionConfig<TInput, TOutput> = {
  handler: (ctx: unknown, input?: TInput) => TOutput;  // ctx is always `unknown`
};
```

This creates several issues:

1. **`ctx` is always `unknown`**: The type system cannot infer the workspace client type because actions are defined before knowing what workspace they'll attach to.

2. **Type annotation ceremony**: To get typed `ctx`, users must write verbose annotations:
   ```typescript
   const actions: Actions<AppClient> = { ... };
   // or
   defineQuery<AppClient>({ ... });
   ```

3. **Extra complexity**: The `attachActions` function exists solely to capture `ctx` in a closure and return a new callable. Why not just use closures directly?

4. **Testing friction**: Tests use `const actions: Actions = {...}` which loses all type inference for `ctx`.

### The Closure Solution

JavaScript closures naturally capture variables from their enclosing scope. Since actions are defined after the client, they can simply reference it:

```typescript
const client = createWorkspace({ ... });

const actions = {
  getPosts: defineQuery({
    handler: () => client.tables.posts.getAllValid(),
    //             ^^^^^^ TypeScript fully infers this!
  }),
};
```

**Benefits:**
- **Zero annotation ceremony**: TypeScript infers everything naturally
- **Cleaner handler signatures**: `(input?) => output` instead of `(ctx, input?) => output`
- **Simpler internals**: No `attachActions`, no context passing
- **Actions still introspectable**: Plain object with metadata

## Design

### 1. Updated Action Types

```typescript
// BEFORE: Handler receives ctx
type ActionConfig<
  TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
  TOutput = unknown,
> = {
  description?: string;
  input?: TInput;
  output?: StandardSchemaWithJSONSchema;
  handler: TInput extends StandardSchemaWithJSONSchema
    ? (ctx: unknown, input: StandardSchemaV1.InferOutput<TInput>) => TOutput | Promise<TOutput>
    : (ctx: unknown) => TOutput | Promise<TOutput>;
};

// AFTER: Handler just receives input (or nothing)
type ActionConfig<
  TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
  TOutput = unknown,
> = {
  description?: string;
  input?: TInput;
  output?: StandardSchemaWithJSONSchema;
  handler: TInput extends StandardSchemaWithJSONSchema
    ? (input: StandardSchemaV1.InferOutput<TInput>) => TOutput | Promise<TOutput>
    : () => TOutput | Promise<TOutput>;
};
```

### 2. Adapter API Changes

```typescript
// BEFORE: Single argument with attached actions
const client = createWorkspace({ ... }).withActions(actions);
createActionsRouter({ actions: client.actions });
buildActionCommands(client.actions);

// AFTER: Client and actions passed separately
const client = createWorkspace({ ... });
const actions = { ... };
createActionsRouter({ client, actions });
createCLI({ client, actions });
```

The adapter:
1. Takes both `client` and `actions` separately
2. Handles iteration/introspection over actions (for routes/commands)
3. Directly invokes handlers (they already have access to client via closure)

### 3. Remove `.withActions()` from Client Builder

The `withActions` method on workspace clients is removed. Actions are a separate concern from client creation.

```typescript
// BEFORE
export function createWorkspace<...>(...): WorkspaceClientBuilder<...> {
  return {
    ...baseClient,
    withActions<TActions>(actions: TActions) {
      return createClientWithActions(baseClient, actions);
    },
    withExtensions(...) { ... },
  };
}

// AFTER
export function createWorkspace<...>(...): WorkspaceClient<...> {
  return {
    ...baseClient,
    withExtensions(...) { ... },
    // No withActions - actions are passed to adapters directly
  };
}
```

### 4. Remove Attachment Infrastructure

Delete entirely:
- `attachActions()` function
- `createClientWithActions()` function
- `AttachedAction` type
- `AttachedActions` type
- `isAttachedAction()` type guard
- `iterateAttachedActions()` iterator

Replace with simpler iteration:
```typescript
// New: Iterate over action definitions directly
export function* iterateActions(
  actions: Actions,
  path: string[] = [],
): Generator<[Action<any, any>, string[]]> {
  for (const [key, value] of Object.entries(actions)) {
    const currentPath = [...path, key];
    if (isAction(value)) {
      yield [value, currentPath];
    } else {
      yield* iterateActions(value as Actions, currentPath);
    }
  }
}
```

### 5. Example: Full Usage Pattern

```typescript
// workspace.ts
import { createWorkspace, defineTable } from 'epicenter';

const postsTable = defineTable({
  columns: {
    id: { type: 'string' },
    title: { type: 'string' },
    publishedAt: { type: 'date', optional: true },
  },
});

export const client = createWorkspace({
  id: 'blog',
  tables: { posts: postsTable },
});
```

```typescript
// actions.ts
import { defineQuery, defineMutation } from 'epicenter';
import { type } from 'arktype';
import { client } from './workspace';

export const actions = {
  posts: {
    getAll: defineQuery({
      description: 'Get all published posts',
      handler: () => client.tables.posts.getAllValid(),
    }),

    getById: defineQuery({
      input: type({ id: 'string' }),
      handler: ({ id }) => client.tables.posts.get(id),
    }),

    create: defineMutation({
      input: type({ title: 'string' }),
      handler: ({ title }) => {
        const id = crypto.randomUUID();
        client.tables.posts.upsert({ id, title, publishedAt: null });
        return { id };
      },
    }),

    publish: defineMutation({
      input: type({ id: 'string' }),
      handler: ({ id }) => {
        client.tables.posts.update({ id, publishedAt: new Date() });
      },
    }),
  },
};
```

```typescript
// server.ts
import { createActionsRouter } from 'epicenter/server';
import { client } from './workspace';
import { actions } from './actions';

const app = createActionsRouter({ client, actions });
app.listen(3000);
```

```typescript
// cli.ts
import { createCLI } from 'epicenter/cli';
import { client } from './workspace';
import { actions } from './actions';

createCLI({ client, actions }).parse();
```

## Implementation Plan

### Phase 1: Update Core Action Types

**File:** `packages/epicenter/src/shared/actions.ts`

1. Remove `ctx` parameter from `ActionConfig` handler signature
2. Update `defineQuery` and `defineMutation` - handler no longer receives ctx
3. Remove:
   - `attachActions()` function
   - `createClientWithActions()` function
   - `AttachedAction` type
   - `AttachedActions` type
   - `isAttachedAction()` type guard
4. Update `iterateAttachedActions` → `iterateActions` (iterate over definitions, not attached)

### Phase 2: Update Server Adapter

**File:** `packages/epicenter/src/server/actions.ts`

1. Change `ActionsRouterOptions` from `{ actions: AttachedActions }` to `{ client: unknown, actions: Actions }`
2. Update `createActionsRouter` to:
   - Use `iterateActions` instead of `iterateAttachedActions`
   - Call `action.handler(input)` directly (no attachment step)
3. Update `collectActionPaths` similarly

### Phase 3: Update CLI Adapter

**File:** `packages/epicenter/src/cli/command-builder.ts`

1. Update `buildActionCommands` to accept `{ client, actions }` or just `actions`
2. Use `iterateActions` instead of `iterateAttachedActions`
3. Call `action.handler(input)` directly

### Phase 4: Remove `.withActions()` from Workspace Builders

**Files:**
- `packages/epicenter/src/static/create-workspace.ts`
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`
- `packages/epicenter/src/static/types.ts`
- `packages/epicenter/src/dynamic/workspace/types.ts`

1. Remove `withActions` method from builders
2. Remove `WorkspaceClientWithActions` type (if exists)
3. Update type exports

### Phase 5: Update Tests

**Files:**
- `packages/epicenter/src/cli/cli.test.ts`
- `packages/epicenter/src/server/actions.test.ts`
- `packages/epicenter/src/cli/command-builder.test.ts`

1. Replace `const actions: Actions = {...}` with `const actions = {...}`
2. Replace `attachActions(actions, mockClient)` with direct usage
3. If tests need a client, create a real workspace or a typed mock
4. Tests should now close over any client they need

### Phase 6: Update Exports and Documentation

**Files:**
- `packages/epicenter/src/index.ts`
- `packages/epicenter/src/shared/actions.ts` (JSDoc)

1. Remove exports for deleted types/functions
2. Update JSDoc examples in `actions.ts`
3. Update module-level documentation

## Files to Modify

### Core Changes
| File | Changes |
|------|---------|
| `src/shared/actions.ts` | Remove ctx from handlers, delete attachment code |
| `src/server/actions.ts` | Update to take `{ client, actions }` |
| `src/cli/command-builder.ts` | Update to use `iterateActions` |
| `src/static/create-workspace.ts` | Remove `withActions` method |
| `src/dynamic/workspace/create-workspace.ts` | Remove `withActions` method |
| `src/static/types.ts` | Remove `withActions` from builder types |
| `src/dynamic/workspace/types.ts` | Remove `withActions` from builder types |

### Tests
| File | Changes |
|------|---------|
| `src/cli/cli.test.ts` | Remove `attachActions`, use closures |
| `src/server/actions.test.ts` | Remove `attachActions`, update router calls |
| `src/cli/command-builder.test.ts` | Update test setup |

### Exports
| File | Changes |
|------|---------|
| `src/index.ts` | Remove `attachActions`, `createClientWithActions` exports |
| `src/static/index.ts` | Update exports if needed |
| `src/dynamic/index.ts` | Update exports if needed |

## Code to Delete

```typescript
// DELETE: All of this from actions.ts

export type AttachedAction<TInput = unknown, TOutput = unknown> = { ... };
export type AttachedActions = { ... };
export function isAttachedAction(value: unknown): value is AttachedAction<any, any> { ... }
export function attachActions<T extends Actions>(actions: T, ctx: unknown): AttachedActions { ... }
export function createClientWithActions<TClient, TActions>(client: TClient, actions: TActions) { ... }
export function* iterateAttachedActions(actions: AttachedActions, path: string[] = []) { ... }
```

## Migration Guide

### For Action Definitions

```typescript
// BEFORE
const actions = {
  getPosts: defineQuery({
    handler: (ctx) => ctx.tables.posts.getAllValid(),
  }),
};

// AFTER
const client = createWorkspace({ ... });
const actions = {
  getPosts: defineQuery({
    handler: () => client.tables.posts.getAllValid(),
  }),
};
```

### For Server Setup

```typescript
// BEFORE
const client = createWorkspace({ ... }).withActions(actions);
const router = createActionsRouter({ actions: client.actions });

// AFTER
const client = createWorkspace({ ... });
const actions = { ... };
const router = createActionsRouter({ client, actions });
```

### For CLI Setup

```typescript
// BEFORE
const client = createWorkspace({ ... }).withActions(actions);
const commands = buildActionCommands(client.actions);

// AFTER
const client = createWorkspace({ ... });
const actions = { ... };
const commands = buildActionCommands(actions);
// Or: createCLI({ client, actions })
```

### For Tests

```typescript
// BEFORE
const mockClient = { id: 'test' };
const actions: Actions = {
  ping: defineQuery({ handler: (_ctx) => 'pong' }),
};
const attached = attachActions(actions, mockClient);
// Use attached...

// AFTER
const actions = {
  ping: defineQuery({ handler: () => 'pong' }),
};
// Use actions directly...
// Or create a real client if the handler needs it
```

## Testing Strategy

### Unit Tests (No Real Client Needed)
For testing action metadata, routing, CLI parsing - actions don't need to do anything real:

```typescript
const actions = {
  ping: defineQuery({ handler: () => 'pong' }),
  create: defineMutation({
    input: type({ title: 'string' }),
    handler: ({ title }) => ({ id: '1', title }),
  }),
};

// Test that routes are created correctly
const router = createActionsRouter({ client: {}, actions });
```

### Integration Tests (Real Client)
For testing that handlers actually work:

```typescript
const client = createWorkspace({
  id: 'test',
  tables: { posts: postsTable },
});

const actions = {
  create: defineMutation({
    input: type({ title: 'string' }),
    handler: ({ title }) => {
      const id = crypto.randomUUID();
      client.tables.posts.upsert({ id, title });
      return { id };
    },
  }),
};

// Test the full flow
const router = createActionsRouter({ client, actions });
const response = await router.handle(new Request('http://test/actions/create', {
  method: 'POST',
  body: JSON.stringify({ title: 'Test' }),
}));

expect(await response.json()).toMatchObject({ data: { id: expect.any(String) } });
expect(client.tables.posts.getAllValid()).toHaveLength(1);
```

## Success Criteria

1. **No `ctx` parameter**: All action handlers take only `input?`, never `ctx`
2. **No `.withActions()`**: Removed from client builders
3. **Adapters take client + actions**: `createActionsRouter({ client, actions })`
4. **Actions introspectable**: Can still iterate, get metadata
5. **All tests pass**: After updating to new pattern
6. **TypeScript happy**: Full inference, no `unknown` ctx

## Why This Is The Right Design

1. **Natural JavaScript**: Closures are idiomatic, not a custom "attachment" mechanism
2. **Zero ceremony**: No type annotations needed for full inference
3. **Explicit dependencies**: Actions clearly import the client they use
4. **Simpler codebase**: Remove ~100 lines of attachment infrastructure
5. **Better testing**: Integration tests use real workspaces, unit tests don't need mocks

## Implementation Notes

**All phases completed (1-6):**
- Phase 1: Core action types updated - removed ctx parameter from handler signatures
- Phase 2: Server adapter refactored to accept client and actions separately
- Phase 3: CLI adapter updated to use iterateActions
- Phase 4: withActions() method removed from workspace builders
- Phase 5: All test files migrated to closure-based patterns
- Phase 6: Exports cleaned up, dead code removed

**Breaking change - no backwards compatibility maintained as intended:**
This refactor intentionally removes all backwards compatibility. The ctx parameter, attachment functions, and withActions methods have been completely removed. Consuming projects must migrate to the new closure-based pattern.

**Pre-existing TypeScript errors in test files (yargs typing, unused variables) are unrelated to this refactor:**
Some TypeScript strictness issues exist in test files related to yargs command configuration and unused variables, but these are orthogonal to the action system changes and do not affect the implementation's correctness.
