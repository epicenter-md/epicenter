# Action System v2: Context-Passing Handlers

**Status:** Implemented
**Created:** 2026-02-03
**Author:** Braden Wong
**Supersedes:** 20260107T194104-action-system-redesign.md

## Overview

Redesign the action system so handlers receive the client as a parameter instead of closing over it. This enables:

1. **Single export** - `export default client.withActions(actions)` instead of separate exports
2. **Introspection without initialization** - Action metadata (schemas, descriptions) is static
3. **Auto-discovery** - CLI/Server/MCP adapters read `client.actions` directly
4. **Cleaner mental model** - Actions are attached to the client, not floating alongside it

## The Problem with Current Design

The current action system requires handlers to close over the client:

```typescript
// Current: Awkward two-export pattern
const client = createWorkspaceClient({ ... });

const actions = {
  posts: {
    create: defineMutation({
      input: type({ title: 'string' }),
      handler: ({ title }) => {
        client.tables.posts.upsert({ ... });  // Closes over `client`
      }
    })
  }
};

export default client;
export { actions };  // Feels disconnected
```

**Problems:**
1. Two exports feel disjointed
2. Discovery code must look for both `default` and `actions` exports
3. Actions aren't introspectable from the client object
4. Handler's dependency on client is implicit (closure), not explicit (parameter)

## Proposed Design

### The Call Site

```typescript
// epicenter.config.ts
import { createWorkspaceClient, defineQuery, defineMutation } from '@epicenter/hq';
import { type } from 'arktype';

export default createWorkspaceClient({
  id: 'blog',
  tables: {
    posts: { id: id(), title: text(), content: text() },
  },
})
.withActions({
  posts: {
    getAll: defineQuery({
      description: 'Get all posts',
      handler: (ctx) => ctx.tables.posts.getAllValid(),
    }),

    get: defineQuery({
      input: type({ id: 'string' }),
      handler: (ctx, { id }) => ctx.tables.posts.get(id),
    }),

    create: defineMutation({
      input: type({ title: 'string', content: 'string' }),
      handler: (ctx, { title, content }) => {
        const id = generateId();
        ctx.tables.posts.upsert({ id, title, content });
        return { id };
      },
    }),
  },

  sync: {
    markdown: defineMutation({
      description: 'Pull changes from markdown files',
      handler: (ctx) => ctx.extensions.markdown.pullFromMarkdown(),
    }),
  },
});
```

**Key change:** Handler signature is `(ctx, input?)` instead of `(input)`. The `ctx` parameter IS the workspace client.

### What `.withActions()` Returns

The client with an `actions` property attached:

```typescript
const client = createWorkspaceClient({ ... }).withActions(actions);

// client.actions is the attached action tree
client.actions.posts.create({ title: 'Hello' });  // Executes handler with client as ctx

// client.actions is also introspectable
for (const [action, path] of iterateAttachedActions(client.actions)) {
  console.log(path.join('.'));      // 'posts.create'
  console.log(action.type);         // 'mutation'
  console.log(action.description);  // 'Create a post'
  console.log(action.input);        // StandardSchema object
}
```

### How Adapters Discover Actions

CLI, Server, and MCP adapters receive the client and read `client.actions`:

```typescript
// CLI automatically uses client.actions
const cli = createCLI(client);  // No second argument needed

// Server automatically uses client.actions
const server = createServer(client);  // No second argument needed

// Both can still accept explicit actions for override/extension
const cli = createCLI(client, { actions: customActions });
```

**Discovery priority:**
1. Explicit `options.actions` if provided
2. `client.actions` if available
3. No actions (built-in commands only)

## Type Definitions

### Action Types (unchanged from v1)

```typescript
type ActionConfig<
  TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
  TOutput = unknown,
> = {
  description?: string;
  input?: TInput;
  output?: StandardSchemaWithJSONSchema;
  handler: TInput extends StandardSchemaWithJSONSchema
    ? (ctx: WorkspaceClient, input: InferOutput<TInput>) => TOutput | Promise<TOutput>
    : (ctx: WorkspaceClient) => TOutput | Promise<TOutput>;
};

type Query<TInput, TOutput> = ActionConfig<TInput, TOutput> & { type: 'query' };
type Mutation<TInput, TOutput> = ActionConfig<TInput, TOutput> & { type: 'mutation' };
type Action = Query | Mutation;
type Actions = { [key: string]: Action | Actions };
```

### Attached Action Types

After `.withActions()`, actions are "attached" - calling them executes the handler with the client context:

```typescript
/**
 * An action that has been attached to a workspace client.
 *
 * Attached actions are callable functions that execute the handler with the
 * client context pre-filled. They also expose metadata (type, description,
 * input/output schemas) for introspection by adapters.
 *
 * @remarks
 * We use "attached" rather than "bound" terminology because:
 * - "Attach" describes the relationship: actions are attached TO a client
 * - "Bound" has JavaScript baggage (Function.prototype.bind) that's technically
 *   accurate but less intuitive for the mental model we want
 * - Effect-TS uses "provide", Express uses "attach" - we follow the simpler term
 * - Matches our existing `.withExtensions()` pattern semantically
 *
 * @example
 * ```typescript
 * // After attachment, actions are callable with just the input
 * client.actions.posts.create({ title: 'Hello' });
 *
 * // Metadata is still accessible for introspection
 * client.actions.posts.create.type; // 'mutation'
 * client.actions.posts.create.input; // StandardSchema
 * ```
 */
type AttachedAction<TInput, TOutput> = {
  type: 'query' | 'mutation';
  description?: string;
  input?: StandardSchemaWithJSONSchema;
  output?: StandardSchemaWithJSONSchema;
  /** Executes the handler with the attached client context */
  (input?: TInput): TOutput | Promise<TOutput>;
};

type AttachedActions = { [key: string]: AttachedAction | AttachedActions };
```

### WorkspaceClient Type Extension

```typescript
interface WorkspaceClient<TTables, TKV, TExtensions> {
  id: string;
  tables: TableAccessors<TTables>;
  kv: KVAccessors<TKV>;
  extensions: TExtensions;
  ydoc: Y.Doc;

  // New: Actions attached via .withActions()
  actions?: AttachedActions;

  // New: Method to attach actions
  withActions<TActions extends Actions>(
    actions: TActions
  ): WorkspaceClient<TTables, TKV, TExtensions> & { actions: Attached<TActions> };
}
```

## Introspection

### Why Introspection Doesn't Need Yjs

Action metadata is **static data** attached to the action object:
- `type`: 'query' | 'mutation'
- `description`: string (optional)
- `input`: StandardSchema (converts to JSON Schema)
- `output`: StandardSchema (optional)

The handler function exists but doesn't need to execute for introspection. This means:

```typescript
// This works WITHOUT initializing Yjs or any async setup
const schemas = [];
for (const [action, path] of iterateAttachedActions(client.actions)) {
  schemas.push({
    path: path.join('.'),
    type: action.type,
    description: action.description,
    inputSchema: action.input ? toJSONSchema(action.input) : undefined,
  });
}
```

### Introspection API

```typescript
// Iterate attached actions (generator)
function* iterateAttachedActions(
  actions: AttachedActions,
  path: string[] = []
): Generator<[AttachedAction, string[]]>;

// Collect action paths (for logging/discovery)
function collectActionPaths(actions: AttachedActions): string[];

// Convert to OpenAPI operations
function toOpenAPIOperations(actions: AttachedActions): OpenAPIOperation[];

// Convert to MCP tools
function toMCPTools(actions: AttachedActions): MCPTool[];
```

## Adapter Integration

### CLI Adapter

```typescript
// packages/epicenter/src/cli/cli.ts
export function createCLI(client: AnyWorkspaceClient, options?: CLIOptions) {
  const actions = options?.actions ?? client.actions;

  let cli = yargs()
    .scriptName('epicenter')
    // ... built-in commands ...

  if (actions) {
    const commands = buildActionCommands(actions);
    for (const cmd of commands) {
      cli = cli.command(cmd);
    }
  }

  return { run: (argv) => cli.parse(argv) };
}
```

Generated CLI commands:

```bash
# From: posts.getAll (query, no input)
epicenter posts getAll

# From: posts.get (query, with input)
epicenter posts get --id abc123

# From: posts.create (mutation, with input)
epicenter posts create --title "Hello" --content "World"

# From: sync.markdown (mutation, no input)
epicenter sync markdown
```

### Server Adapter (HTTP)

```typescript
// packages/epicenter/src/server/server.ts
export function createServer(client: AnyWorkspaceClient, options?: ServerOptions) {
  const actions = options?.actions ?? client.actions;

  const app = new Elysia()
    .use(openapi({ ... }))
    .use(createTablesPlugin(client))
    .use(createSyncPlugin(client));

  if (actions) {
    app.use(createActionsRouter({ actions }));
  }

  return { app, start: () => Bun.serve({ fetch: app.fetch }) };
}
```

Generated HTTP routes:

```
GET  /actions/posts/getAll        → posts.getAll handler
GET  /actions/posts/get?id=abc    → posts.get handler
POST /actions/posts/create        → posts.create handler (body: { title, content })
POST /actions/sync/markdown       → sync.markdown handler
```

### MCP Adapter (Future)

```typescript
// packages/epicenter/src/mcp/mcp.ts
export function createMCPServer(client: AnyWorkspaceClient) {
  const actions = client.actions;
  if (!actions) return null;

  const tools = toMCPTools(actions);

  return new MCPServer({
    tools,
    handleToolCall: async (name, args) => {
      const [action, path] = findActionByPath(actions, name.split('_'));
      if (!action) throw new Error(`Unknown tool: ${name}`);
      return action(args);
    },
  });
}
```

Generated MCP tools:

```json
{
  "name": "posts_create",
  "description": "Create a post",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["title", "content"]
  }
}
```

## Implementation Plan

### Phase 1: Core Types and `.withActions()`

1. **Update `shared/actions.ts`**
   - Change handler signature to `(ctx, input?)` instead of `(input)`
   - Add `AttachedAction` and `AttachedActions` types
   - Add `attachActions` helper function with JSDoc explaining terminology
   - Add `iterateAttachedActions` for adapters (removed `iterateActions` as dead code)
   - Add `createClientWithActions` helper to reduce duplication in `.withActions()` implementations

2. **Add `.withActions()` to WorkspaceClient**
   - In `static/create-workspace.ts` and `dynamic/workspace/create-workspace.ts`
   - Returns new client with `actions` property
   - Attaches handlers by wrapping: `(input) => handler(client, input)`

3. **Update `defineQuery` / `defineMutation`**
   - Handler type changes from `(input) => output` to `(ctx, input) => output`
   - Preserve backwards compatibility during migration (detect arity)

### Phase 2: Adapter Updates

4. **Update CLI adapter**
   - Check `client.actions` if no explicit actions passed
   - No changes to command generation logic

5. **Update Server adapter**
   - Check `client.actions` if no explicit actions passed
   - No changes to route generation logic

6. **Update discovery**
   - `resolveWorkspace` no longer needs to extract separate `actions` export
   - Single `export default` contains everything

### Phase 3: Migration and Cleanup

7. **Migrate existing tests**
   - Update handler signatures in test files
   - Verify introspection still works

8. **Update documentation**
   - New call site examples
   - Migration guide from v1

## Files to Change

| File | Changes |
|------|---------|
| `packages/epicenter/src/shared/actions.ts` | Handler signature, AttachedAction types, attachActions helper |
| `packages/epicenter/src/static/create-workspace.ts` | Add `.withActions()` method |
| `packages/epicenter/src/dynamic/workspace/create-workspace.ts` | Add `.withActions()` method |
| `packages/epicenter/src/cli/cli.ts` | Check `client.actions` |
| `packages/epicenter/src/server/server.ts` | Check `client.actions` |
| `packages/epicenter/src/cli/discovery.ts` | Simplify (no separate actions export) |
| `packages/epicenter/src/cli/command-builder.ts` | Work with AttachedActions |
| `packages/epicenter/src/server/actions.ts` | Work with AttachedActions |

## Design Decisions

### Why `(ctx, input)` instead of `(input, ctx)`?

1. **Context-first is standard** - Express (`req, res`), Koa (`ctx`), Hono (`c`), tRPC (`ctx`)
2. **Optional input is cleaner** - `(ctx)` vs `(undefined, ctx)`
3. **Mirrors method calls** - `this.handler(input)` where `this` is implicit first arg

### Why attach to client instead of returning `{ client, actions }`?

1. **Single value to pass around** - Adapters receive one thing
2. **Introspectable from client** - `client.actions` always available
3. **Fluent API** - Chainable with other methods if needed

### Why keep `defineQuery` / `defineMutation` separate?

1. **HTTP method mapping** - Query → GET, Mutation → POST
2. **MCP hints** - Queries are read-only, mutations have side effects
3. **Caching semantics** - Queries can be cached, mutations cannot
4. **Industry convention** - Matches tRPC, GraphQL, TanStack Query

### Why StandardSchema for input/output?

1. **JSON Schema generation** - Required for OpenAPI, MCP, CLI flags
2. **Runtime validation** - Validate at boundary before handler
3. **Type inference** - Full TypeScript inference from schema
4. **Library agnostic** - Works with ArkType, Zod, Valibot

### Why "attach" instead of "bind"?

We considered several alternatives for naming the operation that captures client context into action handlers:

| Term | Pros | Cons |
|------|------|------|
| **bind** | Technically precise (matches `Function.prototype.bind`) | JavaScript baggage; many devs don't use bind in modern code |
| **attach** | Clear physical metaphor; no framework conflicts | Less precise about the transformation |
| **provide** | Effect-TS precedent; mature DI terminology | Foreign to non-Effect users |
| **connect** | React-Redux precedent | Deprecated pattern; network connotations |
| **wire** | Spring Framework precedent | Less common in JS ecosystem |

**We chose "attach" because:**

1. **Intuitive mental model** - Actions are "attached to" a client. You can visualize it.
2. **Matches existing patterns** - Our `.withExtensions()` semantically "attaches" extensions to the client
3. **No baggage** - Unlike "bind" (JS method), "hydrate" (React SSR), or "connect" (deprecated Redux)
4. **Framework research** - Express uses "attach" for middleware context (`req.context`), which is familiar

**The transformation is still partial application** - we're capturing the `ctx` parameter. But "attached" describes the *relationship* (actions belong to a client) rather than the *mechanism* (closure capture). Users care about the relationship; implementers care about the mechanism.

**JSDoc will explain both:**

```typescript
/**
 * Attaches action handlers to a workspace client, enabling them to be called
 * with just the input parameter.
 *
 * @remarks
 * This performs partial application: handlers defined as `(ctx, input) => output`
 * become callable as `(input) => output` because `ctx` is captured in a closure.
 * We call this "attaching" rather than "binding" to emphasize the relationship
 * (actions belong to a client) over the mechanism (closure capture).
 */
function attachActions<T extends Actions>(
  actions: T,
  client: WorkspaceClient
): Attached<T>;
```

## Breaking Change

This is a **breaking change**. No backwards compatibility with v1 closure-based handlers.

All handlers must use the new signature: `(ctx, input?) => output`

## Open Questions

1. **Should `client.actions` be readonly?** - Prevents mutation but adds complexity
2. **Should we support async `.withActions()`?** - For actions that need async setup

## Summary

This redesign keeps the core action concepts (queries, mutations, schemas, introspection) while fixing the ergonomic issues:

| Aspect | v1 (Current) | v2 (Proposed) |
|--------|--------------|---------------|
| Export pattern | Two exports | Single export |
| Handler dependency | Implicit (closure) | Explicit (parameter) |
| Adapter discovery | Manual lookup | `client.actions` |
| Introspection source | Separate `actions` object | `client.actions` |
| Handler signature | `(input) => output` | `(ctx, input) => output` |
| Action state | Raw definitions | `AttachedAction` (callable with context captured) |
| Transformation function | N/A | `attachActions(actions, client)` |

## Implementation Notes

This section documents the actual implementation details.

### Files Changed

| File | Changes |
|------|---------|
| `packages/epicenter/src/shared/actions.ts` | Handler signature changed to `(ctx, input?)`. Added `AttachedAction` types. Added `attachActions` helper. Added `iterateAttachedActions` for adapters. |
| `packages/epicenter/src/static/create-workspace.ts` | Added `.withActions()` method to the workspace client. |
| `packages/epicenter/src/dynamic/workspace/create-workspace.ts` | Added `.withActions()` method to the workspace client. |
| `packages/epicenter/src/shared/actions.test.ts` | New test file for action system using minimal mock clients. |

### Key Implementation Details

**`iterateAttachedActions` function**

A new generator function was added specifically for adapters to iterate over attached actions:

```typescript
function* iterateAttachedActions(
  actions: AttachedActions,
  path: string[] = []
): Generator<[AttachedAction, string[]]>;
```

**Note:** The original design included both `iterateActions` (for unattached definitions) and `iterateAttachedActions` (for attached actions). During implementation cleanup, `iterateActions` was removed as dead code since adapters only ever work with attached actions. Only `iterateAttachedActions` remains in the final implementation.

A `createClientWithActions` helper was also added to reduce duplication in the `.withActions()` implementations across static and dynamic workspace APIs.

**Test Pattern**

Tests use minimal mock clients that only implement the interface needed by the action system:

```typescript
const mockClient = {
  tables: { posts: { getAllValid: () => mockPosts } },
} as unknown as AnyWorkspaceClient;
```

This allows testing action attachment and execution without requiring full Yjs/CRDT infrastructure.

### Breaking Change

This is a **breaking change with no backwards compatibility**. All existing action handlers must be migrated from the closure-based pattern to the context-passing pattern:

```typescript
// Before (v1 - no longer supported)
handler: ({ title }) => {
  client.tables.posts.upsert({ ... });  // Closes over `client`
}

// After (v2)
handler: (ctx, { title }) => {
  ctx.tables.posts.upsert({ ... });  // Receives `ctx` as parameter
}
```

The adapters (CLI, Server) were not updated in this implementation phase as they require additional work to integrate with the new `client.actions` discovery pattern.
