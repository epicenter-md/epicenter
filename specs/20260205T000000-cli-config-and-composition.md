# CLI Config, Actions, and Multi-Workspace Composition

## Problem

The CLI discovers `epicenter.config.ts` and expects a raw `WorkspaceClient` as the default export. Adding actions (custom operations like import/export) creates a second top-level export that's disconnected from the client. When composing multiple workspaces (Reddit + Twitter + Google Takeout), there's no namespacing strategy and no way to bundle client + actions as a unit.

Three intertwined design questions:

1. **Config shape**: How does `epicenter.config.ts` export both a client and its actions?
2. **Command namespacing**: How do tables, actions, KV, and built-ins coexist without collision?
3. **Multi-workspace composition**: How do multiple workspace configs compose into a single CLI/server?

## Key Tension

Actions use closure-based dependency injection — they close over the client variable. This means the client and actions are separate variables. You can't just `export default createWorkspace(...)` anymore when you also have actions.

## Why Not `defineConfig({ client, actions })`

The original approach proposed a `defineConfig` wrapper that bundles `{ client, actions }` into a config object. This works but introduces unnecessary indirection:

- **New concept**: `defineConfig` is an identity function that exists solely for TypeScript. The codebase already has a builder pattern (`.withExtensions()`) that solves the same coupling problem.
- **Two objects**: The "config" is a bag containing a client. The client should BE the config — it already carries tables, kv, and capabilities.
- **Discovery complexity**: Duck-typing three shapes (raw client, config object, composed config) creates three code paths.
- **The code already wants this**: `cli.ts:59` has `options?.actions ?? (client as any).actions` — it tries to read actions from the client.

Actions have the same relationship to the client that extensions do: they depend on it, travel with it, share its lifecycle. Extensions are coupled via `.withExtensions()`. Actions should be coupled the same way.

## Solution: `.withActions()` Builder

### API Design

`.withActions()` chains after `createWorkspace()` or after `.withExtensions()`. It receives a factory function that gets the current client and returns an actions tree. The result is the same client with an `actions` property.

```typescript
// Without extensions — actions get base client
export default createWorkspace({
  id: 'blog',
  tables: { posts },
})
  .withActions((client) => ({
    getAll: defineQuery({
      handler: () => client.tables.posts.getAllValid(),
    }),
  }))

// With extensions — actions get client WITH capabilities
export default createWorkspace(redditWorkspace)
  .withExtensions({ persistence })
  .withActions((client) => ({
    import: defineMutation({
      description: 'Import Reddit GDPR export',
      input: type({ file: 'string' }),
      handler: async ({ file }) => {
        const data = await Bun.file(file).arrayBuffer();
        return importRedditExport(data, client);
      },
    }),
    preview: defineQuery({
      description: 'Preview export without importing',
      input: type({ file: 'string' }),
      handler: async ({ file }) => {
        const data = await Bun.file(file).arrayBuffer();
        return previewRedditExport(data);
      },
    }),
  }))
```

**Calling actions programmatically:**

```typescript
const reddit = createWorkspace(redditWorkspace)
  .withExtensions({ persistence })
  .withActions((client) => ({
    import: defineMutation({ ... }),
    preview: defineQuery({ ... }),
  }))

// Programmatic use — fully typed
await reddit.actions.import.handler({ file: './export.zip' })
const preview = await reddit.actions.preview.handler({ file: './export.zip' })
```

**Actions referencing other actions within the factory:**

```typescript
.withActions((client) => {
  const getAll = defineQuery({
    handler: () => client.tables.posts.getAllValid(),
  })

  const refresh = defineMutation({
    handler: async () => {
      await fetchFromAPI(client)
      return getAll.handler() // direct reference within factory scope
    },
  })

  return { getAll, refresh }
})
```

### Chain Positions

```
createWorkspace(def)                    → WorkspaceClientBuilder
  ├── .withExtensions({...})            → WorkspaceClientWithExtensions
  │     └── .withActions((client) => …) → WorkspaceClient & { actions }  (terminal)
  └── .withActions((client) => …)       → WorkspaceClient & { actions }  (terminal)
```

- `.withActions()` is available on both `WorkspaceClientBuilder` and the return of `.withExtensions()`.
- `.withActions()` is terminal — no more builder methods after it.
- The factory receives the client at that point in the chain (with or without capabilities).
- Without `.withActions()`, the client works exactly as before (backwards compatible).

### Type Design

```typescript
// Base WorkspaceClient now includes optional actions property
// (both in static WorkspaceClient and dynamic WorkspaceClient types)
type WorkspaceClient<TId, TTableDefs, TKvDefs, TCapabilities> = {
  id: TId;
  tables: /* ... */;
  kv: /* ... */;
  capabilities: TCapabilities;
  actions?: Actions; // optional on base type
};

// WorkspaceClientWithActions narrows the optional actions to required with a specific TActions type
type WorkspaceClientWithActions<
  TId extends string,
  TTableDefs extends TableDefinitions,
  TKvDefs extends KvDefinitions,
  TCapabilities extends CapabilityMap,
  TActions extends Actions,
> = WorkspaceClient<TId, TTableDefs, TKvDefs, TCapabilities> & {
  actions: TActions; // narrows optional to required with specific type
};

// Updated: WorkspaceClientBuilder now has .withActions()
type WorkspaceClientBuilder<TId, TTableDefs, TKvDefs> =
  WorkspaceClient<TId, TTableDefs, TKvDefs, Record<string, never>> & {
    withExtensions<TCap extends CapabilityMap>(
      extensions: TCap,
    ): WorkspaceClient<TId, TTableDefs, TKvDefs, TCap> & {
      withActions<TActions extends Actions>(
        factory: (client: WorkspaceClient<TId, TTableDefs, TKvDefs, TCap>) => TActions,
      ): WorkspaceClientWithActions<TId, TTableDefs, TKvDefs, TCap, TActions>;
    };

    withActions<TActions extends Actions>(
      factory: (
        client: WorkspaceClient<TId, TTableDefs, TKvDefs, Record<string, never>>,
      ) => TActions,
    ): WorkspaceClientWithActions<TId, TTableDefs, TKvDefs, Record<string, never>, TActions>;
  };

// AnyWorkspaceClient no longer needs intersection — actions are on the base type
type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;
```

### Discovery — No Changes Needed

`discovery.ts` already duck-types with `isWorkspaceClient(value)` checking `id` + `tables`. A client with `.withActions()` still has `id` and `tables`. Discovery just returns it. Actions are available on the client if they exist.

The only change: update the `AnyWorkspaceClient` type alias to include `actions?: Actions`.

### CLI — Simplified

Remove the `CLIOptions` type. `createCLI` just reads `client.actions`:

```typescript
// Before
export function createCLI(client: AnyWorkspaceClient, options?: CLIOptions) {
  const actions = options?.actions ?? (client as any).actions;
  ...
}

// After
export function createCLI(client: AnyWorkspaceClient) {
  if (client.actions) {
    const commands = buildActionCommands(client.actions);
    for (const cmd of commands) {
      cli = cli.command(cmd);
    }
  }
  ...
}
```

### Server — Same Simplification

```typescript
// Before
export type ServerOptions = {
  port?: number;
  actions?: Actions;
};

// After
export type ServerOptions = {
  port?: number;
};
// Server reads client.actions directly
```

## Flat Commands with Collision Detection

Single workspace — everything is flat, no prefixes:

```
epicenter posts list              ← table (auto-generated)
epicenter posts get <id>          ← table (auto-generated)
epicenter import --file export.zip ← action
epicenter preview --file export.zip ← action
epicenter kv get statistics       ← built-in
epicenter tables                  ← built-in meta
epicenter serve                   ← built-in
```

Reserved command names: `serve`, `tables`, `kv`. Actions and tables share the top-level namespace. Collisions detected at startup with a clear error:

```
Error: Action "posts" collides with table "posts".
Rename the action or table to avoid ambiguity.
```

No `epicenter actions import` prefix — actions are first-class peers of table commands.

## Multi-Workspace Composition (Phase 2)

A `composeWorkspaces` utility namespaces multiple workspace clients under keys:

```typescript
// epicenter.config.ts (root)
import reddit from './reddit/epicenter.config';
import twitter from './twitter/epicenter.config';

export default composeWorkspaces({ reddit, twitter });
```

CLI auto-namespaces by key:

```
epicenter reddit posts list              ← reddit table
epicenter reddit import --file ...       ← reddit action
epicenter twitter tweets list            ← twitter table
epicenter twitter import --file ...      ← twitter action
epicenter serve                          ← serves ALL workspaces
```

The input to `composeWorkspaces` is workspace clients (which carry their actions via `.withActions()`), not config bags. The type:

```typescript
function composeWorkspaces(
  workspaces: Record<string, AnyWorkspaceClient>,
): ComposedWorkspace;

type ComposedWorkspace = {
  workspaces: Record<string, AnyWorkspaceClient>;
};
```

Discovery detects the shape:
- Has `id` + `tables` → single workspace client
- Has `workspaces` record → composed workspace

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `.withActions()` builder over `defineConfig` wrapper | Consistent with existing `.withExtensions()` pattern. One coupling mechanism, not two. |
| Factory function `(client) => actions` | Explicit DI. Client is a parameter, not an implicit closure. Works with chaining. |
| `.withActions()` is terminal | Prevents confusion about ordering. Extensions must come before actions. |
| Actions on `client.actions` | Optional property on the base `WorkspaceClient` type, narrowed to required by `WorkspaceClientWithActions`. Same pattern as `client.capabilities`. Namespace separation, no collision with client methods. |
| `AnyWorkspaceClient` includes `actions?` | Discovery doesn't need to change its detection logic. |
| No backwards compatibility shims | Clean break. Existing configs just add `.withActions()` if they have actions. Configs without actions work unchanged. |
| Flat namespace for single workspace | Minimal ceremony for the common case. |
| Auto-namespace for multi-workspace | Collision-free by construction. |
| No `actions` command prefix | Actions are first-class, not second-class citizens behind a prefix. |
| Collision detection at startup | Fail fast, clear error. |

## Implementation Order

### Phase 1: `.withActions()` (minimum viable)

1. **Types** (`packages/epicenter/src/static/types.ts`)
   - Add `WorkspaceClientWithActions` intersection type
   - Update `WorkspaceClientBuilder` to include `.withActions()` method signature
   - Note: `WorkspaceClient` now includes an optional `actions?: Actions` property on the base type, narrowed to required by `WorkspaceClientWithActions`

2. **Builder** (`packages/epicenter/src/static/create-workspace.ts`)
   - Add `.withActions()` method to the object returned by `createWorkspace()`
   - Add `.withActions()` method to the object returned by `.withExtensions()`
   - Implementation: call factory with current client, spread client + `{ actions }` into new object

3. **Discovery** (`packages/epicenter/src/cli/discovery.ts`)
   - Update `AnyWorkspaceClient` type to `WorkspaceClient<any, any, any, any> & { actions?: Actions }`
   - No logic changes — duck-typing still works

4. **CLI** (`packages/epicenter/src/cli/cli.ts`)
   - Remove `CLIOptions` type
   - Remove `options` parameter from `createCLI`
   - Read actions from `client.actions` directly
   - Remove the `(client as any).actions` hack

5. **Bin** (`packages/epicenter/src/cli/bin.ts`)
   - Simplify: `createCLI(resolution.client)` — already correct, just remove any actions passing

6. **Server** (`packages/epicenter/src/server/server.ts`)
   - Remove `actions` from `ServerOptions`
   - Read actions from client directly (the server currently takes a dynamic `WorkspaceClient`, so update that type alias too)

7. **Exports** (`packages/epicenter/src/static/index.ts`)
   - Export `WorkspaceClientWithActions` type

### Phase 2: Multi-workspace composition (later)

8. **`composeWorkspaces`** — Takes `Record<string, AnyWorkspaceClient>`, returns `ComposedWorkspace`
9. **Namespaced CLI** — Detect composed workspace in discovery, prefix commands
10. **Namespaced server routes** — `/reddit/posts/list`, `/twitter/tweets/list`

## Open Questions

- Should `composeWorkspaces` also support an array with auto-naming from `client.id`?
- Should composed workspaces support shared actions at the root level?
- For the server in composed mode: one WebSocket per workspace or multiplexed?
