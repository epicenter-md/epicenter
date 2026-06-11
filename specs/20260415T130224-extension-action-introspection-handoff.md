# Handoff: Extension Action Introspection

## Task

Implement three changes to `@epicenter/workspace` and `@epicenter/cli`:

1. **Add `Symbol.for('epicenter.action')` brand** to `defineQuery`/`defineMutation` and update `isAction()` to check the symbol
2. **Widen `MirrorDatabase`/`MirrorStatement` types** so `bun:sqlite`'s `Database` satisfies them structurally
3. **Rewrite the SQLite materializer's public API** from plain methods to `defineQuery`/`defineMutation` actions (generic, not per-table)
4. **Update `describeWorkspace()`** to also walk `client.extensions` and return extension actions
5. **Update `epicenter run`** to fall through to `client.extensions` when an action isn't found in `client.actions`

Read the full spec at `specs/20260415T130224-extension-action-introspection.md` for design rationale, resolved questions, and architecture diagrams.

## Skills to Load

Load these before starting: `monorepo`, `typescript`, `testing`, `workspace-api`, `error-handling`, `define-errors`

## Build & Test Commands

```bash
bun test packages/workspace/src/extensions/materializer/sqlite/   # materializer tests
bun test packages/workspace/src/shared/actions.ts                  # action system tests
bun test packages/workspace/src/workspace/describe-workspace.test.ts  # describe tests
bun test packages/workspace/src/workspace/create-workspace.test.ts    # builder tests
bun run typecheck                                                  # full monorepo typecheck (turbo)
```

## Context: What Exists Today

### Action System (`packages/workspace/src/shared/actions.ts`)

`defineQuery` and `defineMutation` return callable functions with metadata stamped via `Object.assign`. Detection is currently structural:

```typescript
// Current defineQuery implementation (line 285):
export function defineQuery({ handler, ...rest }: ActionConfig): Query {
  return Object.assign(handler, {
    type: 'query' as const,
    ...rest,
  }) as unknown as Query;
}

// Current defineMutation implementation (line 331):
export function defineMutation({ handler, ...rest }: ActionConfig): Mutation {
  return Object.assign(handler, {
    type: 'mutation' as const,
    ...rest,
  }) as unknown as Mutation;
}

// Current isAction guard (line 355):
export function isAction(value: unknown): value is Action {
  return (
    typeof value === 'function' &&
    'type' in value &&
    (value.type === 'query' || value.type === 'mutation')
  );
}

// iterateActions walks an action tree, yielding [action, path] tuples (line 408):
export function* iterateActions(
  actions: Actions,
  path: string[] = [],
): Generator<[Action, string[]]> {
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

`isAction` is the single chokepoint. All detection flows through it:
- `iterateActions()` in `actions.ts`
- `isQuery()` / `isMutation()` in `actions.ts` (delegate to `isAction()`)
- Sync RPC dispatch in `websocket.ts` line 358
- `describeWorkspace()` uses `iterateActions()`
- `epicenter run` in `run.ts` uses `iterateActions()`
- Tool bridge in `tool-bridge.ts` uses `iterateActions()`

34 files call `defineQuery`/`defineMutation`. All go through the factory functions. The symbol addition is purely additive.

### MirrorDatabase Types (`packages/workspace/src/extensions/materializer/sqlite/types.ts`)

Current types are too narrow for `bun:sqlite`:

```typescript
export type MirrorDatabase = {
  run(sql: string): MaybePromise<unknown>;
  prepare(sql: string): MirrorStatement;  // BUG: should be MaybePromise<MirrorStatement> for Turso
};

export type MirrorStatement = {
  run(...params: unknown[]): MaybePromise<unknown>;
  all(...params: unknown[]): MaybePromise<Record<string, unknown>[]>;  // BUG: bun:sqlite returns unknown[]
  get(...params: unknown[]): MaybePromise<Record<string, unknown> | null>;  // BUG: same issue
};
```

`bun:sqlite`'s `Statement<ReturnType=unknown>.all()` returns `unknown[]`, not `Record<string, unknown>[]`. Fix: widen `all()` to `MaybePromise<unknown[]>` and `get()` to `MaybePromise<unknown>`. Widen `prepare()` to `MaybePromise<MirrorStatement>` for async drivers.

### SQLite Materializer (`packages/workspace/src/extensions/materializer/sqlite/sqlite.ts`)

Currently returns plain methods. The builder pattern at the bottom:

```typescript
type MaterializerBuilder = {
  table<TName extends keyof TTables & string>(
    name: TName,
    tableConfig?: TableMaterializerConfig,
  ): MaterializerBuilder;
  whenReady: Promise<void>;
  dispose(): void;
  search(table: keyof TTables & string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  count(table: keyof TTables & string): Promise<number>;
  rebuild(table?: keyof TTables & string): Promise<void>;
  db: MirrorDatabase;
};

const builder: MaterializerBuilder = {
  table(name, tableConfig) { tableConfigs.set(name, tableConfig ?? {}); return builder; },
  whenReady: initialize(),
  dispose,
  search,
  count,
  rebuild,
  db,
};

return builder;
```

Replace `search`, `count`, `rebuild` with `defineQuery`/`defineMutation` wrappers. The table name parameter becomes a TypeBox-validated input field with a union of configured table names.

### describeWorkspace (`packages/workspace/src/workspace/describe-workspace.ts`)

Currently only walks `client.actions`:

```typescript
export type WorkspaceDescriptor = {
  id: string;
  tables: Record<string, SchemaDescriptor>;
  kv: Record<string, SchemaDescriptor>;
  awareness: Record<string, SchemaDescriptor>;
  actions: ActionDescriptor[];
};

// In describeWorkspace():
if (client.actions) {
  for (const [action, path] of iterateActions(client.actions)) {
    actions.push({ path, type: action.type, ... });
  }
}
```

Add `extensions: Record<string, ActionDescriptor[]>` field. Walk each `client.extensions[key]` with `iterateActions`, collect action descriptors grouped by extension key.

### epicenter run (`packages/cli/src/commands/run.ts`)

Currently resolves only against `client.actions`:

```typescript
// Current lookup:
for (const [action, path] of iterateActions(client.actions)) {
  if (path.join('.') === actionPath.join('.')) { found = action; break; }
}
```

Add extension fallback: if not found in `client.actions`, walk each `client.extensions[key]` and check if `extensionKey + '.' + path.join('.')` matches. This is a clean break. No backward compat concerns.

## What to Change

### Change 1: Symbol brand in `actions.ts`

```typescript
// Add at top of file:
export const ACTION_BRAND = Symbol.for('epicenter.action');

// Update defineQuery:
export function defineQuery({ handler, ...rest }: ActionConfig): Query {
  return Object.assign(handler, {
    [ACTION_BRAND]: true,
    type: 'query' as const,
    ...rest,
  }) as unknown as Query;
}

// Update defineMutation:
export function defineMutation({ handler, ...rest }: ActionConfig): Mutation {
  return Object.assign(handler, {
    [ACTION_BRAND]: true,
    type: 'mutation' as const,
    ...rest,
  }) as unknown as Mutation;
}

// Update isAction:
export function isAction(value: unknown): value is Action {
  return typeof value === 'function' && ACTION_BRAND in value;
}
```

Keep `.type` property: `isQuery`/`isMutation` still discriminate on `.type === 'query' | 'mutation'`.

Also update the `ActionMeta` type to include the brand:

```typescript
type ActionMeta<TInput extends TSchema | undefined = TSchema | undefined> = {
  [ACTION_BRAND]: true;
  type: 'query' | 'mutation';
  title?: string;
  description?: string;
  input?: TInput;
};
```

And export `ACTION_BRAND` from the barrel files (`packages/workspace/src/index.ts`, `packages/workspace/src/workspace/index.ts`).

### Change 2: Widen MirrorDatabase types in `types.ts`

```typescript
export type MirrorDatabase = {
  run(sql: string): MaybePromise<unknown>;
  prepare(sql: string): MaybePromise<MirrorStatement>;
};

export type MirrorStatement = {
  run(...params: unknown[]): MaybePromise<unknown>;
  all(...params: unknown[]): MaybePromise<unknown[]>;
  get(...params: unknown[]): MaybePromise<unknown>;
};
```

Then in `sqlite.ts`, add casts where the materializer reads rows: `(row as Record<string, unknown>)`. Safe because SQLite always returns row objects.

Also: every call to `db.prepare(...)` must now be awaited, since it returns `MaybePromise<MirrorStatement>`. Update internal usages in `sqlite.ts`:
- `const stmt = await db.prepare(...)` (previously no await needed)
- The `fullLoadTable` and `insertRow`/`deleteRow` functions already await `.run()` on the statement, so the pattern is `(await db.prepare(...)).run(...)`.

### Change 3: Materializer returns `defineQuery`/`defineMutation`

Replace the `MaterializerBuilder` return type. The builder still chains `.table()`, but the final returned object exports actions instead of plain methods:

```typescript
import { defineQuery, defineMutation } from '../../../shared/actions.js';
import Type from 'typebox';

// Inside createSqliteMaterializer, after builder finishes collecting tables:
// Generate TypeBox union of FTS-configured table names
const ftsTableNames = [...tableConfigs.entries()]
  .filter(([, config]) => config.fts && config.fts.length > 0)
  .map(([name]) => name);

const allTableNames = [...tableConfigs.keys()];

// Build the return object with defineQuery/defineMutation:
return {
  table: builder.table,  // keep builder chainable

  search: ftsTableNames.length > 0
    ? defineQuery({
        title: 'Full-text search',
        description: 'FTS5 search across materialized table rows',
        input: Type.Object({
          table: Type.Union(ftsTableNames.map(n => Type.Literal(n))),
          query: Type.String(),
          limit: Type.Optional(Type.Number()),
        }),
        handler: ({ table, query, limit }) => search(table, query, { limit }),
      })
    : undefined,

  count: defineQuery({
    title: 'Row count',
    description: 'Count rows in a materialized table',
    input: Type.Object({
      table: Type.Union(allTableNames.map(n => Type.Literal(n))),
    }),
    handler: ({ table }) => count(table),
  }),

  rebuild: defineMutation({
    title: 'Rebuild materializer',
    description: 'Drop and rebuild all materialized tables from Yjs source',
    handler: () => rebuild(),
  }),

  // Lifecycle (not actions: no symbol, skipped by walker)
  whenReady: initialize(),
  dispose,
  db,
};
```

Note: this is a breaking API change. The materializer has zero external consumers calling `.search()` programmatically (configs just register the extension, they don't call methods on it). Safe to break.

### Change 4: Update `describeWorkspace()` in `describe-workspace.ts`

```typescript
export type WorkspaceDescriptor = {
  id: string;
  tables: Record<string, SchemaDescriptor>;
  kv: Record<string, SchemaDescriptor>;
  awareness: Record<string, SchemaDescriptor>;
  actions: ActionDescriptor[];
  extensions: Record<string, ActionDescriptor[]>;  // NEW
};

// In describeWorkspace():
const extensionActions: Record<string, ActionDescriptor[]> = {};
if (client.extensions) {
  for (const [extKey, extValue] of Object.entries(client.extensions)) {
    if (extValue == null || typeof extValue !== 'object') continue;
    const extActions: ActionDescriptor[] = [];
    for (const [action, path] of iterateActions(extValue as Actions)) {
      extActions.push({
        path,
        type: action.type,
        ...(action.title !== undefined && { title: action.title }),
        ...(action.description !== undefined && { description: action.description }),
        ...(action.input !== undefined && { input: action.input }),
      });
    }
    if (extActions.length > 0) {
      extensionActions[extKey] = extActions;
    }
  }
}

return { id: client.id, tables: ..., kv: ..., awareness: ..., actions, extensions: extensionActions };
```

### Change 5: Update `epicenter run` in `run.ts`

After the existing `iterateActions(client.actions)` lookup fails, add extension fallback:

```typescript
// Existing: search client.actions
let found: Action | undefined;
if (client.actions) {
  for (const [action, path] of iterateActions(client.actions)) {
    if (path.join('.') === actionPath.join('.')) { found = action; break; }
  }
}

// NEW: fall through to client.extensions
if (!found && client.extensions) {
  for (const [extKey, extValue] of Object.entries(client.extensions)) {
    if (extValue == null || typeof extValue !== 'object') continue;
    for (const [action, path] of iterateActions(extValue as Actions)) {
      const extPath = [extKey, ...path].join('.');
      if (extPath === actionPath.join('.')) { found = action; break; }
    }
    if (found) break;
  }
}
```

## MUST DO

- Load skills: `monorepo`, `typescript`, `testing`, `workspace-api` before implementing
- Use `type` instead of `interface` everywhere
- Use `Symbol.for('epicenter.action')`: NOT `Symbol('epicenter.action')` (must work cross-package)
- Keep `.type` property on actions alongside the symbol (used by `isQuery`/`isMutation`)
- Export `ACTION_BRAND` from barrel files
- Cast row results in materializer internals where types were widened (`as Record<string, unknown>`)
- Await `db.prepare(...)` in all materializer internal usages
- Run `bun test packages/workspace` and `bun run typecheck` after each phase
- Update `describe-workspace.test.ts` with test for new `extensions` field
- Update materializer tests for new API shape

## MUST NOT DO

- Do not suppress type errors with `as any` or `@ts-ignore`
- Do not delete or skip existing tests
- Do not modify files outside `packages/workspace/` and `packages/cli/` (except barrel re-exports)
- Do not auto-register extension actions into `client.actions`: they stay in `client.extensions`
- Do not remove the `.type` property from actions: only add the symbol alongside it
- Do not change the `iterateActions` walker logic: only change what `isAction` checks
- Do not commit unless explicitly asked
