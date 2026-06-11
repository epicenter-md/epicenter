# Workspace `.create()` Accepts Capabilities Directly

> **Status: Superseded**: This spec was a design document. The API evolved during implementation. The current API uses `createWorkspace(definition)` instead of `workspace.create()`. See `packages/epicenter/src/static/README.md` for the current API.

**Status:** Draft
**Created:** 2026-01-08
**Author:** Braden Wong

## Overview

Simplify the workspace API by removing `.withCapabilities()` and allowing `.create()` to accept capabilities directly. This reduces the API surface and eliminates unnecessary ceremony.

## Problem Statement

The current API requires a two-step chain:

```typescript
// Current: Always need withCapabilities(), even for empty capabilities
const client = await workspace.withCapabilities({}).create();

// Or with capabilities
const client = await workspace
	.withCapabilities({ sqlite, persistence })
	.create();
```

This creates unnecessary friction:

1. **Extra ceremony**: `.withCapabilities()` is just storing a value for `.create()` to use
2. **Intermediate type rarely used**: `WorkspaceWithCapabilities` is almost never stored standalone
3. **No real use case**: Every supposed use case for `.withCapabilities()` can be done at the `.create()` call site

### Why `.withCapabilities()` Adds No Value

**"Export pre-configured workspace"** - But capabilities take their own options, so consumers configure at the call site anyway:

```typescript
// Consumer just does this directly
const client = await blogWorkspace.create({
	sqlite: sqlite({ debounceMs: 50 }),
});
```

**"Conditional capabilities"** - Can be done directly:

```typescript
const caps = { persistence };
if (needsSql) caps.sqlite = sqlite();
const client = await workspace.create(caps); // No withCapabilities needed
```

### Ecosystem Comparison

Popular TypeScript libraries use simpler patterns:

| Library            | Pattern                                             |
| ------------------ | --------------------------------------------------- |
| **Drizzle**        | `drizzle(conn, { schema })` - single call           |
| **tRPC**           | `createTRPCClient<Router>({ links })` - single call |
| **Prisma**         | `new PrismaClient({ adapter })` - single call       |
| **TanStack Query** | `new QueryClient(config)` - single call             |

Our two-step chain is more verbose than all of these.

## Proposed Solution

Remove `.withCapabilities()` entirely. Allow `.create()` to accept capabilities directly:

```typescript
const workspace = defineWorkspace({
	id: 'blog',
	guid: 'abc-123',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

// With capabilities
const client = await workspace.create({ sqlite, persistence });

// No capabilities (ephemeral, in-memory only)
const client = await workspace.create();

// Capabilities handle their own options
const client = await workspace.create({
	sqlite: sqlite({ debounceMs: 50 }),
	persistence,
});
```

### What Gets Removed

1. **`.withCapabilities()` method** - No longer needed
2. **`WorkspaceWithCapabilities` type** - No longer needed
3. **`CreateOptions` with `projectDir`** - Capabilities handle their own paths via their options
4. **Overloaded signatures** - Single signature: `create(capabilities?: CapabilityMap)`

### What Stays

1. **`defineWorkspace()`** - Clear, explicit name for schema definition
2. **`.create()`** - Standard pattern for instantiation
3. **`WorkspaceClient`** - Return type name (matches ecosystem: PrismaClient, QueryClient)

## Type Definitions

### Current Types (to be removed/simplified)

```typescript
// REMOVE: WorkspaceWithCapabilities
type WorkspaceWithCapabilities<...> = WorkspaceSchema<...> & {
  $capabilities: TCapabilities;
  create(options?: CreateOptions): Promise<WorkspaceClient<...>>;
};

// REMOVE: CreateOptions
type CreateOptions = {
  projectDir?: string;
};
```

### Proposed Types

````typescript
/**
 * A workspace object returned by `defineWorkspace()`.
 *
 * Contains the schema (tables, kv, id, guid) and a `.create()` method
 * to instantiate a runtime client.
 */
export type Workspace<
	TId extends string = string,
	TTablesSchema extends TablesSchema = TablesSchema,
	TKvSchema extends KvSchema = KvSchema,
> = WorkspaceSchema<TId, TTablesSchema, TKvSchema> & {
	/**
	 * Create a workspace client.
	 *
	 * @param capabilities - Optional capability factories to attach.
	 *   Capabilities add functionality like persistence, sync, or SQL queries.
	 *   Each capability receives context and can return exports accessible
	 *   via `client.capabilities.{name}`.
	 *
	 * @example No capabilities (ephemeral, in-memory)
	 * ```typescript
	 * const client = await workspace.create();
	 * ```
	 *
	 * @example With capabilities
	 * ```typescript
	 * const client = await workspace.create({ sqlite, persistence });
	 * ```
	 *
	 * @example Capabilities with options
	 * ```typescript
	 * const client = await workspace.create({
	 *   sqlite: sqlite({ debounceMs: 50 }),
	 *   persistence,
	 * });
	 * ```
	 */
	create<TCapabilities extends CapabilityMap<TTablesSchema, TKvSchema> = {}>(
		capabilities?: TCapabilities,
	): Promise<WorkspaceClient<TId, TTablesSchema, TKvSchema, TCapabilities>>;
};

/**
 * A fully initialized workspace client.
 *
 * Access tables via `client.tables.tableName.*`
 * Access kv via `client.kv.key.*`
 * Access capability exports via `client.capabilities.capabilityName`
 */
export type WorkspaceClient<
	TId extends string = string,
	TTablesSchema extends TablesSchema = TablesSchema,
	TKvSchema extends KvSchema = KvSchema,
	TCapabilities extends CapabilityMap<TTablesSchema, TKvSchema> = {},
> = {
	guid: string;
	id: TId;
	tables: Tables<TTablesSchema>;
	kv: Kv<TKvSchema>;
	capabilities: InferCapabilityExports<TCapabilities>;
	paths: WorkspacePaths | undefined;
	ydoc: Y.Doc;
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};
````

## Implementation Plan

- [x] **Update `Workspace` type** in `contract.ts`
  - [x] Add `create()` method signature
  - [x] Remove `withCapabilities()` method signature
- [x] **Update `defineWorkspace()` implementation** in `contract.ts`
  - [x] Implement `create()` directly on returned object
  - [x] Remove `withCapabilities()` implementation
  - [x] Handle `capabilities` parameter (default to `{}`)
- [x] **Remove `WorkspaceWithCapabilities` type**
- [x] **Remove `CreateOptions` type** (or simplify if needed internally)
- [x] **Update `initializeWorkspace()` function**
  - [x] Remove `projectDir` parameter handling
  - [x] Capabilities determine their own paths
- [x] **Update capability path resolution**
  - [x] Ensure capabilities can resolve paths without `projectDir` being passed
  - [x] Use `process.cwd()` as default in Node.js environments
- [x] **Update all imports/exports** in index files
- [x] **Update documentation**
  - [ ] `packages/epicenter/README.md` (deferred - large file, separate PR)
  - [ ] `packages/epicenter/src/core/workspace/README.md` (deferred - separate PR)
  - [x] JSDoc comments
- [ ] **Update examples** (deferred - separate PR)

## Files to Change

| File                                                | Changes                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `packages/epicenter/src/core/workspace/contract.ts` | Main implementation changes                                     |
| `packages/epicenter/src/core/workspace/README.md`   | Update documentation                                            |
| `packages/epicenter/README.md`                      | Update quick start examples                                     |
| `packages/epicenter/src/index.ts`                   | Update exports (remove `WorkspaceWithCapabilities` if exported) |
| `packages/epicenter/src/index.shared.ts`            | Update exports                                                  |

## Migration Notes

This is a **breaking change** for code using `.withCapabilities()`.

### Migration Path

```typescript
// Before
const client = await workspace
	.withCapabilities({ sqlite, persistence })
	.create();

// After
const client = await workspace.create({ sqlite, persistence });
```

```typescript
// Before (with projectDir)
const client = await workspace
	.withCapabilities({ sqlite })
	.create({ projectDir: '/custom' });

// After (capabilities handle their own paths)
const client = await workspace.create({
	sqlite: sqlite({ directory: '/custom' }), // if sqlite needs custom path
});
```

```typescript
// Before (no capabilities)
const client = await workspace.withCapabilities({}).create();

// After
const client = await workspace.create();
```

## Design Decisions

### Why remove `.withCapabilities()` instead of keeping both?

Keeping both creates confusion: "When do I use `.withCapabilities().create()` vs `.create()`?"

The answer would always be "use `.create()`" because `.withCapabilities()` adds no value. Better to have one clear path.

### Why remove `projectDir`?

Each capability knows what paths it needs. Passing `projectDir` at the top level means:

- Every capability gets the same base path (inflexible)
- The workspace API needs to know about paths (leaky abstraction)

Instead, capabilities handle their own configuration:

```typescript
sqlite({ directory: '/custom/db' });
persistence({ directory: '/custom/yjs' });
```

If no directory is specified, capabilities use sensible defaults based on `process.cwd()`.

### What does "no capabilities" mean?

A workspace with no capabilities:

- Has a YJS document in memory
- Tables and KV work (reads/writes to YJS)
- No persistence (data lost on `destroy()`)
- No sync, no SQL queries

Useful for: testing, temporary workspaces, browser apps handling persistence elsewhere.

## Background Context

This specification emerged from analyzing the workspace API design. Key insights from ecosystem research:

1. **Drizzle, tRPC, Prisma, TanStack Query** all use single-call patterns
2. **Builder patterns** (like `.withCapabilities()`) are useful when building up complex state, but capabilities are just a simple map
3. **Progressive disclosure** works better with optional parameters than required method chains

The `.withCapabilities()` pattern was originally modeled after builder patterns, but capabilities don't benefit from incremental building - you typically know all your capabilities upfront.

## Review

**Status**: Implemented

### Changes Made

1. **`contract.ts`**: Updated `Workspace` type to include `create()` method directly with optional capabilities parameter. Removed `WorkspaceWithCapabilities` type and `CreateOptions` type. Updated `initializeWorkspace()` to use `process.cwd()` directly.

2. **Exports**: Removed `WorkspaceWithCapabilities` from `workspace/index.ts` and main `index.ts`.

3. **JSDoc Updates**: Updated all examples in:
   - `contract.ts` (Workspace type, defineWorkspace function)
   - `capability.ts` (CapabilityContext type)
   - `sqlite/sqlite.ts`
   - `persistence/web.ts`
   - `persistence/desktop.ts`
   - `websocket-sync.ts`

### Commits

1. `feat(workspace): allow create() to accept capabilities directly` - Core API change
2. `refactor(workspace): remove WorkspaceWithCapabilities from exports` - Export cleanup
3. `docs(capabilities): update JSDoc examples to use new create() API` - Documentation updates

### Breaking Change

This is a breaking change. Migration path documented in spec above.
