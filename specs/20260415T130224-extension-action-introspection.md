# Extension Action Introspection

**Date**: 2026-04-15
**Status**: Draft
**Author**: AI-assisted
**Branch**: feat/fuji-bulk-add-modal

## Overview

Extensions export `defineQuery`/`defineMutation` as their primary API surface. No plain methods. A `Symbol.for('epicenter.action')` brand ensures reliable detection when walking extension exports. The CLI discovers and invokes them directly. Users spread extension exports into `.withActions()` if they want RPC/MCP exposure.

## Motivation

### Current State

The SQLite materializer returns plain methods on `client.extensions.sqlite`:

```typescript
client.extensions.sqlite.search('entries', 'hello')  // plain function, invisible to CLI
client.extensions.sqlite.count('entries')             // plain function, invisible to CLI
```

The CLI can't see any of these. `epicenter describe` only walks `client.actions`. To expose search, you manually wire a `defineQuery` into `.withActions()`:

```typescript
.withActions(({ extensions }) => ({
  searchEntries: defineQuery({
    input: Type.Object({ query: Type.String() }),
    handler: ({ query }) => extensions.sqlite.search('entries', query),
  }),
}))
```

Every config repeats this. The materializer already knows which tables have FTS. And `defineQuery` returns a callable function anyway. There's no reason to have separate plain methods and action wrappers.

### Problems

1. **Boilerplate**: Every config with FTS needs identical `.withActions()` wiring.
2. **Invisible to CLI**: Extensions are a black box to `epicenter describe` and `epicenter run`.
3. **No discoverability**: A user configures `fts: ['title', 'subtitle']` and has no way to invoke search without reading the programmatic API docs.

### Desired State

Extensions export `defineQuery`/`defineMutation` directly. These ARE the API. No plain methods, no separate `.actions` property. Since `defineQuery` returns a callable function with metadata attached, `client.extensions.sqlite.search({ table: 'entries', query: 'hello' })` works programmatically AND is discoverable by the CLI.

```typescript
// Config: this is all you write:
.withWorkspaceExtension('sqlite', (ctx) =>
  createSqliteMaterializer(ctx, { db })
    .table('entries', { fts: ['title', 'subtitle'] })
)

// Programmatic: call it like a function:
client.extensions.sqlite.search({ table: 'entries', query: 'hello' })

// CLI: works immediately:
// epicenter describe  →  shows search, count, rebuild under extensions.sqlite
// epicenter run sqlite.search --table entries --query "hello"

// Optional promotion to client.actions for RPC/MCP:
.withActions(({ extensions }) => extensions.sqlite)
```

## Research Findings

### Action Detection Mechanism

`defineQuery`/`defineMutation` stamp both a `Symbol.for('epicenter.action')` brand and a `.type` property on the handler function:

```typescript
const ACTION_BRAND = Symbol.for('epicenter.action');

// defineQuery returns:
Object.assign(handler, { [ACTION_BRAND]: true, type: 'query' as const, ...rest })

// defineMutation returns:
Object.assign(handler, { [ACTION_BRAND]: true, type: 'mutation' as const, ...rest })
```

Detection uses the symbol as the primary check:

```typescript
const ACTION_BRAND = Symbol.for('epicenter.action');

function isAction(value: unknown): value is Action {
  return typeof value === 'function' && ACTION_BRAND in value;
}
```

`iterateActions()` recursively walks an object tree, yielding `[action, path]` tuples for every leaf that passes `isAction()`. Non-action values are treated as namespace branches and recursed into.

**Why `Symbol.for()` instead of `Symbol()`**: `Symbol.for('epicenter.action')` is a global symbol. The same reference across package boundaries. If a consumer imports `defineQuery` from one copy of `@epicenter/workspace` and `isAction` from another, the check still works. `Symbol()` would create unique symbols per import, breaking cross-package detection.

**Why a symbol instead of structural checks**: We're expanding `iterateActions` from walking curated `client.actions` trees (where everything IS an action by construction) to walking arbitrary `client.extensions.*` (where extensions can have any shape). The symbol makes the contract explicit. Only `defineQuery`/`defineMutation` produce it. No false positives possible, regardless of what extensions export.

**All existing detection paths go through `isAction()`** (verified):
- `iterateActions()` in `actions.ts`: calls `isAction()` for leaf detection
- `isQuery()` / `isMutation()` in `actions.ts`: delegate to `isAction()` first
- Sync RPC dispatch in `websocket.ts`: calls `isAction(target)` before invoking
- `describeWorkspace()`: uses `iterateActions()` which calls `isAction()`
- `epicenter run` in `run.ts`: uses `iterateActions()` which calls `isAction()`
- Tool bridge in `tool-bridge.ts`: uses `iterateActions()`

Single point of change. All 34 files that call `defineQuery`/`defineMutation` go through the factory functions which stamp the symbol. Purely additive. Existing actions gain a new property, nothing breaks.

### Current CLI Dispatch

- `epicenter describe` calls `describeWorkspace(client)`, which calls `iterateActions(client.actions)`.
- `epicenter run <action>` resolves a dot-path against `iterateActions(client.actions)`, validates input via TypeBox-to-yargs conversion, and invokes locally.
- `epicenter rpc <action>` dispatches through `sync.rpc()` to a remote peer. Inbound RPC uses `registeredActions` set by `sync.registerActions()`.
- Neither `epicenter describe` nor `epicenter run` read from `client.extensions`. Only `epicenter rpc` accesses `client.extensions.sync`.

**Implication**: `epicenter run` exists but only resolves against `client.actions`. Extension introspection means teaching it (and `describeWorkspace`) to also walk `client.extensions`.

### Extension Lifecycle

- `withWorkspaceExtension(key, factory)` calls `factory(ctx)` and stores the return value at `client.extensions[key]`.
- Extension returns can include lifecycle hooks: `whenReady`, `dispose`, `clearLocalData`.
- Extensions cannot currently contribute to `client.actions`: that's `.withActions()` only.
- `describeWorkspace()` only walks `client.actions`, not `client.extensions`.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where extension actions live | `client.extensions.<key>` only | No auto-registration into `client.actions`. User promotes via `.withActions(({ extensions }) => extensions.sqlite)`. |
| Extension API surface | `defineQuery`/`defineMutation` only, no plain methods | Actions are callable functions. One API, not two. Generic `search({ table, query })` not per-table. |
| How CLI discovers extension actions | Walk `client.extensions` with `iterateActions` | Same walker, now safe via symbol brand. |
| Detection mechanism | `Symbol.for('epicenter.action')` brand | Bulletproof for walking arbitrary extension exports. `isAction()` is the single chokepoint: one-line change. |
| RPC/MCP exposure | Explicit via `.withActions()` | Security boundary: user decides what's remotely callable. |
| Extension action generation | Materializer generates generic `defineQuery` with table union input | Table name validated via TypeBox `Type.Union([Type.Literal('entries'), ...])`. One action, not N. |
| Local action invocation | Extend existing `epicenter run` | Resolves `client.actions` first, falls through to `client.extensions.*`. No prefix. Clean break from old behavior. |

## Architecture

```
Extension Author (materializer)
─────────────────────────────────
createSqliteMaterializer(ctx, { db })
  .table('entries', { fts: ['title', 'subtitle'] })
  .table('posts')

Returns:
{
  search: defineQuery({                ← one generic action, table validated by input schema
    input: Type.Object({
      table: Type.Union([Type.Literal('entries')]),  // only FTS-configured tables
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    handler: ({ table, query, limit }) => …
  })

  count: defineQuery({                 ← one generic action, all tables
    input: Type.Object({
      table: Type.Union([Type.Literal('entries'), Type.Literal('posts')]),
    }),
    handler: ({ table }) => …
  })

  rebuild: defineMutation({            ← rebuild FTS indexes
    handler: () => …
  })

  dispose()                            ← lifecycle (no symbol, skipped by walker)
  whenReady: Promise<void>             ← lifecycle (skipped)
}


CLI Introspection
─────────────────
epicenter describe:
  walks client.actions        (existing)
  walks client.extensions.*   (NEW: same iterateActions, now symbol-safe)
  returns separate extensions field in WorkspaceDescriptor

epicenter run sqlite.search --table entries --query "hello":
  checks client.actions       (not found)
  walks client.extensions.*   (found at sqlite → search)
  validates input against action.input schema (table must be 'entries')
  calls action({ table: 'entries', query: 'hello' })
  prints result


User Promotion (optional)
──────────────────────────
.withActions(({ extensions }) => extensions.sqlite)

→ client.actions.search, client.actions.count, client.actions.rebuild
→ sync.registerActions() called automatically
```

## Implementation Plan

### Phase 1: Action Brand Symbol + MirrorDatabase Type Fix

- [ ] **1.1** Add `ACTION_BRAND = Symbol.for('epicenter.action')` to `actions.ts`, export it
- [ ] **1.2** Stamp `[ACTION_BRAND]: true` in `defineQuery` and `defineMutation` factory functions
- [ ] **1.3** Update `isAction()` to check `ACTION_BRAND in value` instead of structural `.type` check
- [ ] **1.4** Keep `.type` property on actions (used by `isQuery`/`isMutation` and consumers): symbol is for detection only
- [ ] **1.5** Verify all existing tests pass (34 files use defineQuery/defineMutation: all go through factory)
- [ ] **1.6** Widen `MirrorStatement.all()` return from `MaybePromise<Record<string, unknown>[]>` to `MaybePromise<unknown[]>`
- [ ] **1.7** Widen `MirrorStatement.get()` return from `MaybePromise<Record<string, unknown> | null>` to `MaybePromise<unknown>`
- [ ] **1.8** Widen `MirrorDatabase.prepare()` return from `MirrorStatement` to `MaybePromise<MirrorStatement>`
- [ ] **1.9** Update materializer internals to cast where needed (safe: SQLite always returns row objects)
- [ ] **1.10** Verify `bun:sqlite` Database satisfies `MirrorDatabase` structurally
- [ ] **1.11** Run tests: `bun test packages/workspace/src/extensions/materializer/sqlite/`

### Phase 2: Materializer Exports Generic Actions

- [ ] **2.1** Replace `search(table, query)` with `search: defineQuery({ input: { table: Union<configured FTS tables>, query: String }, handler })`
- [ ] **2.2** Replace `count(table)` with `count: defineQuery({ input: { table: Union<all tables> }, handler })`
- [ ] **2.3** Wrap `rebuild(table?)` as `rebuild: defineMutation({ handler })`
- [ ] **2.4** Keep `dispose()` and `whenReady` as plain lifecycle hooks (no symbol, walker skips them)
- [ ] **2.5** Builder generates TypeBox `Type.Union([Type.Literal('entries'), ...])` from configured table names for input validation
- [ ] **2.6** Ensure return type is generic over `TTables` so TypeScript narrows the table union correctly
- [ ] **2.7** Add tests: `isAction(materializer.search)` returns true, `materializer.search({ table: 'entries', query: 'hello' })` returns results
- [ ] **2.8** Update vault and opensidian configs if needed

### Phase 3: CLI Extension Introspection

- [ ] **3.1** Update `describeWorkspace()` to walk `client.extensions` with `iterateActions`, adding `extensions: Record<string, ActionDescriptor[]>` to `WorkspaceDescriptor`
- [ ] **3.2** Update `epicenter run`: resolve `client.actions` first, then walk `client.extensions.*`. Clean break. No backward compat with old bare-path-to-actions behavior
- [ ] **3.3** Add `epicenter search` as sugar for `epicenter run sqlite.search --table <table> --query "…"` (optional convenience command)
- [ ] **3.4** Test: `epicenter describe` on opensidian-e2e shows extension actions under `extensions.sqlite`
- [ ] **3.5** Test: `epicenter run sqlite.search --table files --query "hello"` invokes search via extension fallback

### Phase 4: Documentation

- [ ] **4.1** Update materializer JSDoc with examples showing the defineQuery-as-API pattern
- [ ] **4.2** Document the convention: extension authors export `defineQuery`/`defineMutation` for user-facing operations, plain functions for lifecycle only

## Edge Cases

### ~~Extension exports a plain function with `.type` property~~

No longer an issue. Detection uses `Symbol.for('epicenter.action')`: only `defineQuery`/`defineMutation` produce it. A plain function with `.type = 'query'` won't have the symbol and is correctly skipped.

### Multiple extensions export actions with the same dot-path

Two extensions both export `search.entries`. When resolving via `epicenter run search.entries`, the CLI walks extensions in registration order and picks the first match. This is unlikely. Extension actions are naturally namespaced under their extension key (`sqlite.search.entries` vs `elastic.search.entries`). If the user spreads both into `.withActions()`, standard JS object spread applies (last wins).

### Extension action references disposed resources

A materializer's `defineQuery` handler closes over the materializer instance. If `dispose()` is called, the handler may fail. This is the same lifecycle contract as any extension method. Callers shouldn't use an extension after disposing it. No special handling needed.

## Resolved Questions

1. **Action naming**: **Decided: Generic with table input, not per-table.** `search: defineQuery({ input: { table, query } })`. One action per operation. Table validated via TypeBox union of configured names. Keeps `epicenter describe` clean.

2. **Path resolution in `epicenter run`**: **Decided: No prefix. Actions first, extension fallback.** Clean break from old behavior. Collisions practically impossible; if one occurs, actions wins (explicitly promoted).

3. **`describeWorkspace()` shape**: **Decided: Separate `extensions` field.** `describeWorkspace` just describes. New `extensions: Record<string, ActionDescriptor[]>` alongside existing `actions`.

4. **Symbols vs `isAction()`**: **Decided: Symbol brand.** `Symbol.for('epicenter.action')` stamped by `defineQuery`/`defineMutation`. Bulletproof for walking arbitrary extension exports. `Symbol.for()` ensures cross-package compatibility. Structural `.type` check stays for `isQuery`/`isMutation` discrimination.

5. **Plain methods vs defineQuery**: **Decided: defineQuery only.** Actions are callable functions. One API surface, not two. The extension return IS the action tree (plus lifecycle hooks that the walker skips).

## Success Criteria

- [ ] `Symbol.for('epicenter.action')` stamped on all `defineQuery`/`defineMutation` return values
- [ ] `isAction()` checks symbol, not structural `.type`
- [ ] All existing action tests pass (34 files)
- [ ] `new Database(':memory:')` from `bun:sqlite` satisfies `MirrorDatabase` with no cast
- [ ] SQLite materializer returns generic `defineQuery` actions: `materializer.search`, `materializer.count`, `materializer.rebuild`
- [ ] `isAction(materializer.search)` returns `true`
- [ ] `materializer.search({ table: 'entries', query: 'hello' })` returns search results
- [ ] `describeWorkspace()` returns `extensions` field with discovered action descriptors
- [ ] `epicenter describe` on opensidian-e2e shows extension actions under `extensions.sqlite`
- [ ] `epicenter run sqlite.search --table files --query "test"` resolves via extension fallback
- [ ] Existing tests pass, no regressions
- [ ] `.withActions(({ extensions }) => extensions.sqlite)` promotes all extension actions to `client.actions`

## References

- `packages/workspace/src/shared/actions.ts`: `defineQuery`, `defineMutation`, `isAction`, `iterateActions`
- `packages/workspace/src/workspace/describe-workspace.ts`: `describeWorkspace()` implementation
- `packages/workspace/src/workspace/create-workspace.ts`: builder, `withWorkspaceExtension`, `withActions`
- `packages/workspace/src/extensions/materializer/sqlite/sqlite.ts`: materializer builder
- `packages/workspace/src/extensions/materializer/sqlite/types.ts`: `MirrorDatabase`, `MirrorStatement`
- `packages/cli/src/commands/describe.ts`: CLI describe command
- `packages/cli/src/commands/rpc.ts`: CLI rpc command (remote action invocation)
- `playground/opensidian-e2e/epicenter.config.ts`: first consumer config
- `packages/cli/src/commands/run.ts`: CLI run command (local action invocation, needs extension resolution)
