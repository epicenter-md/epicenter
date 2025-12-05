# Epicenter Core Action Refactor

## Executive Summary

**Goal:** Make actions callable directly (`action(input)`) instead of requiring `.handler` property access (`action.handler(input)`).

**Scope:** Core actions only. Indexes and table helpers remain unchanged as they are infrastructure.

**Impact:** Breaking change requiring migration of all action calls, but the change is mechanical.

**Benefits:**
- Cleaner, more intuitive API
- Preserved metadata in dependencies (currently lost)
- Better composability and introspection
- Simplified type system

**Implementation:** Use `Object.assign` to attach metadata properties to handler functions, making them callable with metadata.

## Overview

This specification outlines a focused refactoring of Epicenter's action system. The goal is to make actions callable functions with metadata properties, replacing the current pattern of objects with separate `.handler` properties.

## Current State Analysis

### How Dependencies Work Now
```typescript
// In workspace client initialization (client.ts:296-336)
const workspaces: Record<string, any> = {};
for (const dep of ws.dependencies) {
  const depClient = clients.get(dep.id);
  workspaces[dep.name] = depClient; // Client is just extracted handlers
}

// Result: Dependencies are plain handler functions
deps.auth.login(credentials) // Just a function, no metadata
```

**Problem:** `ExtractHandlers<T>` (config.ts:356-358) strips away all action metadata when creating clients. Dependencies receive only the handler functions, losing input schemas and type information.

### How Indexes Work Now
```typescript
// Indexes return a "queries" object (indexes.ts:44-55)
type Index<TWorkspaceSchema, TQueries> = {
  init: (db: Db<TWorkspaceSchema>) => {
    destroy: () => void | Promise<void>;
    queries: TQueries; // ← This is what gets exposed
  }
}

// Example: SQLite index (sqlite/index.ts:137-152)
sqliteIndex(db, config?): Index<Schema, {
  db: LibSQLDatabase<...>;
} & WorkspaceSchemaToDrizzleTables<Schema>>

// Usage in actions
indexes.sqlite.db.select().from(indexes.sqlite.posts).where(...).all()
```

**Current structure:** Indexes expose Drizzle query builders and table objects. Not actions, but raw Drizzle ORM interfaces.

### How Table Helpers Work Now
```typescript
// Table helpers are exposed via db.tables (core.ts:54-180)
type TableHelper<TRow> = {
  insert(row: TRow): void;
  update(partial: PartialRow<TRow>): void;
  get(id: string): GetRowResult<TRow>;
  delete(id: string): void;
  // ... etc
}

// Usage in actions
db.tables.posts.insert({ id: '123', title: 'Hello' })
db.tables.posts.update({ id: '123', title: 'Updated' })
```

**Current structure:** Table helpers are objects with CRUD methods, not callable actions.

### How Actions Work Now
```typescript
// Actions are objects with handler + metadata (actions.ts:24-52)
type QueryAction<TInput, TOutput> = {
  type: 'query';
  input?: TInput;
  handler: (input) => Result<TOutput, Error> | Promise<...>;
  description?: string;
}

// Created via defineQuery/defineMutation (actions.ts:59-91)
const action = defineQuery({
  input: Type.Object({ id: Type.String() }),
  handler: async ({ id }) => { ... },
  description: 'Get a post by ID'
})

// Usage: Call the handler
action.handler({ id: '123' })
// Access metadata
action.input // Type.Object(...)
action.type  // 'query'
```

**Current structure:** Actions are objects with a separate `handler` property. You call `action.handler(input)`, not `action(input)`.

## The Core Problem

We have four different patterns:
1. **Dependencies**: Plain functions (metadata stripped)
2. **Indexes**: Raw Drizzle ORM interfaces (not actions at all)
3. **Table helpers**: Object with methods (not callable)
4. **Actions**: Objects with `.handler` property (not callable)

This inconsistency creates several issues:
- Can't compose actions easily (no shared interface)
- Lost metadata in dependencies (no input schemas)
- No way to inspect what operations are available
- Manual composition required for every workspace

## Proposed Solution

### Core Principle: Everything is an Action

**The Big Idea:** Make actions callable directly while preserving metadata. Instead of `action.handler(input)`, we want `action(input)`.

**Key Insight:** In JavaScript, functions are objects. We can attach properties to them.

```typescript
// The unified Action type - callable with metadata
type Action<
  TType extends 'query' | 'mutation',
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = {
  // Callable signature
  (input: TInput extends TSchema ? Static<TInput> : undefined):
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;

  // Metadata properties attached to the function
  type: TType;
  input?: TInput;
  description?: string;
};

// Specializations
type QueryAction<TInput, TOutput> = Action<'query', TInput, TOutput>;
type MutationAction<TInput, TOutput> = Action<'mutation', TInput, TOutput>;
```

**Usage becomes beautifully simple:**
```typescript
// Call it directly
const result = await action({ id: '123' })

// Access metadata
action.input        // TSchema
action.type         // 'query' or 'mutation'
action.description  // Optional description

// Actions without input
const listAction = defineQuery({
  handler: async () => { /* ... */ }
});
await listAction(undefined); // TypeScript enforces undefined parameter
```

**Why This Matters:**

1. **Consistency**: All actions (dependencies, indexes, tables) have the same interface
2. **Composability**: Can pass actions around as first-class values with metadata intact
3. **Type Safety**: TypeScript infers input/output types from schemas
4. **Discoverability**: IDE autocomplete shows both calling signature and metadata
5. **Clean API**: `action(input)` is more intuitive than `action.handler(input)`

### Changes by Component

#### 1. Dependencies (Core Actions)

**Current Behavior:**
```typescript
// Client creation extracts handlers (client.ts:406-412)
const client: WorkspaceClient<any> = {
  ...extractHandlers(actionMap), // Strips metadata!
  destroy: cleanup,
  [Symbol.asyncDispose]: cleanup,
};

// Dependencies get plain functions
deps.auth.login(credentials) // No metadata access
```

**Problem:** `extractHandlers()` maps `action → action.handler`, losing all metadata.

**Proposed Behavior:**
```typescript
// Keep full action objects
const client: WorkspaceClient<any> = {
  ...actionMap, // Actions are already callable, no extraction needed!
  destroy: cleanup,
  [Symbol.asyncDispose]: cleanup,
};

// Dependencies are callable actions with metadata
await deps.auth.login(credentials)
deps.auth.login.input       // Type.Object({ ... })
deps.auth.login.type        // 'mutation'
deps.auth.login.description // 'Authenticate user'
```

**Implementation Change:**
- **Remove** `extractHandlers()` function entirely
- **Update** `WorkspaceClient` type to use `TActionMap` directly instead of `ExtractHandlers<TActionMap>`
- **Update** `DependencyActionsMap` to not extract handlers

#### 2. Indexes

**Current Behavior:**
```typescript
// Indexes expose raw Drizzle ORM (sqlite/index.ts:140-152)
indexes: ({ db }) => ({
  sqlite: sqliteIndex(db),
})

// Returns: { db: LibSQLDatabase, posts: DrizzleTable, comments: DrizzleTable, ... }
// Usage: Direct Drizzle queries
indexes.sqlite.db.select().from(indexes.sqlite.posts).where(...).all()
```

**Problem:** Indexes don't follow the Action pattern at all. They expose raw Drizzle interfaces.

**Decision:** **Keep indexes as-is for now.** Here's why:

1. **Indexes are fundamentally different**: They provide low-level query builders, not high-level operations
2. **Wrapping would be restrictive**: Every Drizzle query would need an action wrapper
3. **Indexes are infrastructure**: They're used inside actions, not exposed to clients directly
4. **No metadata needed**: Drizzle already has full type inference

**Proposed Behavior:**
```typescript
// No change to index structure
indexes.sqlite.db.select().from(indexes.sqlite.posts).where(...).all()

// Indexes remain as flexible query builders
// Actions wrap them with business logic:
const getPublishedPosts = defineQuery({
  input: Type.Object({ limit: Type.Number() }),
  handler: async ({ limit }) => {
    const posts = indexes.sqlite.db
      .select()
      .from(indexes.sqlite.posts)
      .where(isNotNull(indexes.sqlite.posts.publishedAt))
      .limit(limit)
      .all();
    return Ok(posts);
  }
})
```

**Implementation Change:** None. Indexes stay as flexible query builders.

#### 3. Table Helpers

**Current Behavior:**
```typescript
// Table helpers are objects with methods (core.ts:54-180)
db.tables.posts.insert({ id: '123', title: 'Hello' })
db.tables.posts.update({ id: '123', title: 'Updated' })
db.tables.posts.get('123')
db.tables.posts.delete('123')
```

**Problem:** Table helpers are objects with methods, not callable actions.

**Decision:** **Keep table helpers as-is for now.** Here's why:

1. **Methods are ergonomic**: `db.tables.posts.insert(row)` is clear and concise
2. **No metadata needed**: These are low-level CRUD operations used inside actions
3. **Type safety exists**: TypeScript infers row types from schema
4. **Not exposed to clients**: Table helpers are only used inside the actions callback

**Proposed Behavior:**
```typescript
// No change to table helper structure
db.tables.posts.insert({ id: '123', title: 'Hello' })
db.tables.posts.update({ id: '123', title: 'Updated' })

// Table helpers remain as method objects
// Actions wrap them with validation and business logic:
const createPost = defineMutation({
  input: Type.Object({ title: Type.String() }),
  handler: async ({ title }) => {
    const post = {
      id: generateId(),
      title,
      publishedAt: null,
    };
    db.tables.posts.insert(post);
    return Ok(post);
  }
})
```

**Implementation Change:** None. Table helpers stay as method objects.

## Revised Solution Scope

After analyzing the current codebase, this refactor should focus **only on making actions callable**:

### What Changes: Core Actions Only

**The Single Change:**
- Make actions callable functions instead of objects with `.handler` property
- Remove `extractHandlers()` since actions will already be callable
- Update type definitions to reflect callable actions

**What Stays The Same:**
- Indexes remain as Drizzle query builders
- Table helpers remain as method objects
- Both are used **inside** actions, not exposed to clients

### Why This Focused Approach?

1. **Indexes and tables are infrastructure**: They're low-level tools used to build actions, not client-facing APIs
2. **Actions are the public interface**: Only actions are exposed to workspace clients and dependencies
3. **Simpler migration**: Smaller change surface means less risk
4. **Clear boundaries**: Actions wrap infrastructure with business logic and validation

### The New Mental Model

```
┌─────────────────────────────────────────────────┐
│ Client-Facing (Callable Actions with Metadata)  │
│  - Workspace actions: defineQuery/defineMutation│
│  - Dependency actions: Other workspace actions  │
└─────────────────────────────────────────────────┘
                      ↑
                 wraps/uses
                      ↓
┌─────────────────────────────────────────────────┐
│ Infrastructure (Method Objects, No Metadata)    │
│  - Indexes: Drizzle query builders              │
│  - Tables: CRUD methods (insert/update/delete)  │
└─────────────────────────────────────────────────┘
```

## Implementation Details

### Callable Action Pattern (Object.assign)

The key insight is that JavaScript functions are objects, so we can attach properties to them. We unify query and mutation actions into a single base type:

```typescript
/**
 * Base action type - callable function with metadata properties
 * Unified for both queries and mutations
 */
export type Action<
  TType extends 'query' | 'mutation',
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = {
  // Callable signature - properly infers input based on whether TInput is TSchema or undefined
  (input: TInput extends TSchema ? Static<TInput> : undefined):
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;
  // Metadata properties
  type: TType;
  input?: TInput;  // Optional - can be undefined for parameterless actions
  description?: string;
};

/**
 * Query action - specialization of Action with type='query'
 */
export type QueryAction<
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = Action<'query', TInput, TOutput>;

/**
 * Mutation action - specialization of Action with type='mutation'
 */
export type MutationAction<
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = Action<'mutation', TInput, TOutput>;

/**
 * Union type for all workspace actions
 */
export type WorkspaceAction<
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = QueryAction<TInput, TOutput> | MutationAction<TInput, TOutput>;
```

**Key Design Decisions:**
- **Unified base**: `Action<TType, TInput, TOutput>` eliminates duplication between query and mutation
- **Type discrimination**: `TType extends 'query' | 'mutation'` allows specialization while sharing structure
- **Type aliases**: `QueryAction` and `MutationAction` maintain API compatibility and enable type guards
- `TInput extends TSchema | undefined` - allows actions with no input parameters
- `input: TInput extends TSchema ? Static<TInput> : undefined` - conditional type that:
  - When `TInput` is a `TSchema`, the parameter type is `Static<TInput>` (inferred from schema)
  - When `TInput` is `undefined`, the parameter type is `undefined` (no input needed)
- `input?: TInput` - the schema property is optional on the action object
- Return type is always `Result<TOutput, EpicenterOperationError>` for consistent error handling

### Implementation using Object.assign

The cleanest way to create these callable actions:

```typescript
export function defineQuery<
  TOutput,
  TInput extends TSchema | undefined = undefined,
>(config: {
  input?: TInput;
  handler: (
    input: TInput extends TSchema ? Static<TInput> : undefined,
  ) =>
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;
  description?: string;
}): QueryAction<TInput, TOutput> {
  return Object.assign(config.handler, {
    type: 'query' as const,
    input: config.input,
    description: config.description,
  });
}

export function defineMutation<
  TOutput,
  TInput extends TSchema | undefined = undefined,
>(config: {
  input?: TInput;
  handler: (
    input: TInput extends TSchema ? Static<TInput> : undefined,
  ) =>
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;
  description?: string;
}): MutationAction<TInput, TOutput> {
  return Object.assign(config.handler, {
    type: 'mutation' as const,
    input: config.input,
    description: config.description,
  });
}
```

**Why Object.assign?**
- Single line, no intermediate variables
- Attaches metadata properties to the function
- Returns the enriched function (callable + properties)
- Clean and idiomatic JavaScript

**Usage:**
```typescript
const getUserById = defineQuery({
  input: Type.Object({ id: Type.String() }),
  handler: async ({ id }) => {
    // ... implementation
  },
  description: 'Get a user by ID'
});

// Call it directly
getUserById({ id: '123' })

// Access metadata
getUserById.input       // Type.Object(...)
getUserById.type        // 'query'
getUserById.description // 'Get a user by ID'
```

## Implementation Plan

This is a focused refactor with minimal scope. Only actions change; indexes and tables stay the same.

### Phase 1: Update Action Types (Core Changes)
**Files:** `src/core/actions.ts`

- [ ] Update `QueryAction` type: Change from object with `handler` property to callable signature
- [ ] Update `MutationAction` type: Same change as QueryAction
- [ ] Update `defineQuery`: Use `Object.assign(handler, { type, input, description })`
- [ ] Update `defineMutation`: Use `Object.assign(handler, { type, input, description })`
- [ ] Remove/update helper types (`InferActionHandler`, etc.) that assume `.handler` property

**Validation:**
```typescript
// Test that both work
const action = defineQuery({
  input: Type.Object({ id: Type.String() }),
  handler: async ({ id }) => Ok(id)
});

// Callable
await action({ id: '123' }); // Should work

// Metadata accessible
action.input; // Should be Type.Object(...)
action.type;  // Should be 'query'
```

### Phase 2: Update Client Types (Remove Extraction)
**Files:** `src/core/workspace/config.ts`, `src/core/workspace/client.ts`

- [ ] Remove `extractHandlers` function from `client.ts`
- [ ] Remove `ExtractHandlers` type from `config.ts`
- [ ] Update `WorkspaceClient` type: Change from `ExtractHandlers<TActionMap>` to `TActionMap`
- [ ] Update `DependencyActionsMap` type: Remove handler extraction

**Changes:**
```typescript
// Before
export type WorkspaceClient<TActionMap> = ExtractHandlers<TActionMap> & { ... }

// After
export type WorkspaceClient<TActionMap> = TActionMap & { ... }

// Before
export type DependencyActionsMap<TDeps> = {
  [W in TDeps[number] as W['name']]: ExtractHandlers<ReturnType<W['actions']>>
}

// After
export type DependencyActionsMap<TDeps> = {
  [W in TDeps[number] as W['name']]: ReturnType<W['actions']>
}
```

### Phase 3: Update Client Implementation (Remove Extraction)
**Files:** `src/core/workspace/client.ts`

- [ ] Update `initializeWorkspace` function: Remove call to `extractHandlers(actionMap)`
- [ ] Directly spread `actionMap` into client object
- [ ] Remove import of `extractHandlers` if no longer used

**Changes:**
```typescript
// Before (line 406-412)
const client: WorkspaceClient<any> = {
  ...extractHandlers(actionMap),
  destroy: cleanup,
  [Symbol.asyncDispose]: cleanup,
};

// After
const client: WorkspaceClient<any> = {
  ...actionMap, // Actions are already callable!
  destroy: cleanup,
  [Symbol.asyncDispose]: cleanup,
};
```

### Phase 4: Update All Action Calls (Breaking Change)
**Files:** All workspace configs, examples, tests

- [ ] Find all calls to `action.handler(input)`
- [ ] Replace with `action(input)`
- [ ] Run tests to verify everything works
- [ ] Update examples in documentation

**Migration Pattern:**
```typescript
// Before
await client.createPost.handler({ title: 'Hello' })
await workspaces.auth.login.handler(credentials)

// After
await client.createPost({ title: 'Hello' })
await workspaces.auth.login(credentials)
```

### Phase 5: Testing & Validation
- [ ] Run existing test suite
- [ ] Add new tests for callable actions with metadata
- [ ] Verify TypeScript inference works correctly
- [ ] Test that dependency metadata is preserved
- [ ] Update any failing tests

### Phase 6: Documentation
- [ ] Update API documentation to reflect callable actions
- [ ] Add migration guide for breaking changes
- [ ] Update examples in README
- [ ] Update inline code examples in type definitions

## Resolved Decisions

### 1. Indexes and Table Helpers
**Decision:** Keep as-is. They are infrastructure used inside actions, not client-facing APIs.
- Indexes remain as Drizzle query builders
- Table helpers remain as method objects
- Both are only exposed to the `actions` callback, not to workspace clients

### 2. Action Terminology
**Decision:** Keep `handler` in the configuration, but make the action itself callable.
- Config: `handler: async (input) => { ... }` (familiar, clear intent)
- Implementation: `defineQuery` returns a callable function (no `.handler` property)
- Usage: `action(input)` not `action.handler(input)`

### 3. Dependency Metadata
**Decision:** Remove `extractHandlers()` and keep full action objects in clients.
- Dependencies will have callable actions with metadata
- No need to extract handlers since actions are already callable
- Update `DependencyWorkspacesAPI` type to not extract handlers

## Open Questions (Non-Blocking)

### 1. Backward Compatibility Strategy
- This is a breaking change (API changes from `action.handler(input)` to `action(input)`)
- Migration path: Find-and-replace `.handler(` with `(` in action calls
- Should we provide a codemod or migration script?
- Timeline: Can this be a major version bump?

### 2. TypeScript Inference Edge Cases
- Does attaching properties to functions affect TypeScript inference?
- Are there any edge cases with conditional types and callable signatures?
- Do we need additional type tests to verify inference works correctly?

### 3. Runtime Performance
- Is there any performance difference between `action.handler()` and `action()`?
- Does Object.assign add overhead compared to returning an object?
- Should we benchmark before/after?

## Example: Before and After

### Before: Actions Have `.handler` Property

```typescript
// Define workspace actions
const blogWorkspace = defineWorkspace({
  id: 'blog',
  version: 1,
  name: 'blog',
  schema: { posts: { /* ... */ } },

  actions: ({ db, indexes }) => ({
    getPost: defineQuery({
      input: Type.Object({ id: Type.String() }),
      handler: async ({ id }) => { // ← handler is a separate property
        const post = await indexes.sqlite.db
          .select()
          .from(indexes.sqlite.posts)
          .where(eq(indexes.sqlite.posts.id, id))
          .get();
        return Ok(post);
      },
    }),
  }),
});

// Usage: Must call .handler
const client = await createWorkspaceClient(blogWorkspace);
await client.getPost.handler({ id: '123' }); // ❌ Verbose, unintuitive

// Can access metadata
client.getPost.input; // Type.Object({ id: Type.String() })
client.getPost.type;  // 'query'

// Dependencies get handlers extracted, losing metadata
// In client.ts:406-412, extractHandlers() strips metadata
const userWorkspace = defineWorkspace({
  dependencies: [authWorkspace],
  actions: ({ workspaces }) => ({
    createUser: defineMutation({
      handler: async (data) => {
        // Dependencies are plain functions (extractHandlers() was called)
        await workspaces.auth.login.handler(credentials); // ❌ Verbose
        // Cannot access: workspaces.auth.login.input ❌ (metadata lost!)
      }
    })
  })
});
```

### After: Actions Are Callable

```typescript
// Define workspace actions (same definition, different implementation)
const blogWorkspace = defineWorkspace({
  id: 'blog',
  version: 1,
  name: 'blog',
  schema: { posts: { /* ... */ } },

  actions: ({ db, indexes }) => ({
    getPost: defineQuery({
      input: Type.Object({ id: Type.String() }),
      handler: async ({ id }) => { // ← Still use handler in config
        const post = await indexes.sqlite.db
          .select()
          .from(indexes.sqlite.posts)
          .where(eq(indexes.sqlite.posts.id, id))
          .get();
        return Ok(post);
      },
    }), // ← defineQuery returns callable function with metadata
  }),
});

// Usage: Direct invocation (clean!)
const client = await createWorkspaceClient(blogWorkspace);
await client.getPost({ id: '123' }); // ✅ Clean, intuitive

// Metadata still accessible
client.getPost.input; // Type.Object({ id: Type.String() })
client.getPost.type;  // 'query'

// Dependencies preserve metadata (no extraction!)
const userWorkspace = defineWorkspace({
  dependencies: [authWorkspace],
  actions: ({ workspaces }) => ({
    createUser: defineMutation({
      handler: async (data) => {
        // Dependencies are callable with metadata preserved
        await workspaces.auth.login(credentials); // ✅ Clean
        // Can access: workspaces.auth.login.input ✅ (metadata preserved!)
      }
    })
  })
});
```

### Key Differences

| Aspect | Before | After |
|--------|--------|-------|
| **Invocation** | `action.handler(input)` | `action(input)` |
| **Definition** | `handler: async () => {...}` | Same (no change) |
| **Implementation** | Returns object with `handler` property | Returns function with metadata attached |
| **Dependency metadata** | Lost (extracted handlers) | Preserved (no extraction) |
| **Type safety** | Full (TypeScript infers from schema) | Same |
| **API feel** | Verbose, object-oriented | Clean, functional |

## Benefits of This Refactor

### 1. Cleaner API
- **Before:** `client.createPost.handler({ title: 'Hello' })`
- **After:** `client.createPost({ title: 'Hello' })`
- More intuitive, functional style

### 2. Preserved Dependency Metadata
- **Before:** Dependencies lose metadata (extractHandlers strips it)
- **After:** Dependencies keep full action objects with schemas
- Enables introspection, validation, and composition

### 3. Consistent Mental Model
- Actions are callable functions with metadata
- No need to remember `.handler` suffix
- Aligns with how functions work in JavaScript

### 4. Better Composability
```typescript
// Can now inspect and wrap actions
function withLogging<T extends WorkspaceAction>(action: T): T {
  return Object.assign(
    async (input) => {
      console.log(`Calling ${action.type}:`, action.input);
      return action(input);
    },
    { type: action.type, input: action.input }
  );
}
```

### 5. Simpler Type System
- Remove `ExtractHandlers` type utility
- Remove `extractHandlers` runtime function
- Less indirection in type definitions

## Risks & Considerations

### 1. Breaking Change
- **Impact:** ALL action calls must change
- **Migration:** Find-and-replace `.handler(` with `(`
- **Timeline:** Requires major version bump
- **Mitigation:** Provide codemod script for automatic migration

### 2. Function Properties Are Unusual
- **Risk:** Developers might not expect functions to have properties
- **Mitigation:** Good documentation and TypeScript support
- **Precedent:** Common pattern (Express, React, etc. use it)

### 3. Migration Effort
- **Scope:** ~20-30 action calls across examples and tests
- **Complexity:** Mechanical find-and-replace, low risk
- **Automation:** Can write codemod to automate

### 4. TypeScript Complexity
- **Risk:** Callable signature with properties might challenge TypeScript
- **Mitigation:** Test extensively, verify inference works
- **Fallback:** Can add explicit type annotations if needed

## Next Steps

1. **Approve Specification**: Review and approve this spec
2. **Phase 1: Update Action Types**: Modify `defineQuery`/`defineMutation` to return callable functions
3. **Phase 2-3: Remove Handler Extraction**: Update client types and implementation
4. **Phase 4: Migrate Action Calls**: Update all `.handler(` to `(` in codebase
5. **Phase 5-6: Test & Document**: Verify everything works and update docs

## Files to Modify

### Core Changes (Phases 1-3)
- `src/core/actions.ts` - Update action types and define functions
- `src/core/workspace/config.ts` - Remove `ExtractHandlers` type
- `src/core/workspace/client.ts` - Remove `extractHandlers` function

### Migration (Phase 4)
- `examples/*/epicenter.config.ts` - Update action calls
- `src/**/*.test.ts` - Update test action calls
- Any other files with `.handler(` calls

### Documentation (Phase 6)
- `README.md` - Update examples
- Inline JSDoc comments - Update code examples
- Migration guide - Create new document

## Estimated Effort

- **Phase 1-3 (Core changes):** 2-3 hours
- **Phase 4 (Migration):** 1-2 hours
- **Phase 5-6 (Testing & docs):** 2-3 hours
- **Total:** 1 day of focused work

## Success Criteria

1. All actions are callable without `.handler` suffix
2. Dependencies preserve metadata (can access `.input`, `.type`)
3. All tests pass
4. TypeScript infers types correctly
5. Documentation updated with new patterns
