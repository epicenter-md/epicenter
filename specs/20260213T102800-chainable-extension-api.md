# Chainable Extension API

**Date**: 2026-02-13
**Status**: Implemented

## Overview

Replace `.withExtensions(map)` with a chainable `.withExtension(key, factory)` API on the workspace builder. Each call adds one extension and returns a new builder with the accumulated type information. Later extensions receive the client-so-far as their context, enabling progressive access to previously-declared extensions.

## Motivation

### The Map Pattern Obscures Dependencies

The current API passes all extensions as a flat object:

```typescript
createWorkspace(definition).withExtensions({
	persistence: indexeddbPersistence,
	sync: ySweetSync({
		auth: directAuth('...'),
		persistence: indexeddbPersistence,
	}),
	sqlite: sqliteExtension,
});
```

All extensions are initialized in iteration order, but the type system can't express that `sync` might depend on `persistence`. Dependencies are invisible: `ySweetSync` takes `persistence` as a config option and handles composition internally. This works but creates parallel composition mechanisms (extension map + internal config) when one would do.

### The Singular Pattern Mirrors How Builders Work

Every other builder method in the codebase is singular and chainable (`.withActions()`). Extensions should follow the same pattern:

```typescript
createWorkspace(definition)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('sync', ySweetSync({ auth: directAuth('...') }))
	.withExtension('sqlite', sqliteExtension);
```

Each call returns a usable client with progressive type narrowing. The chain reads top-to-bottom, dependencies are explicit, and TypeScript can enforce that a factory can only access extensions that precede it.

## Design Decisions

| Decision               | Choice                                  | Rationale                                              |
| ---------------------- | --------------------------------------- | ------------------------------------------------------ |
| API shape              | `.withExtension(key, factory)` singular | Matches builder convention, enables chaining           |
| Backward compat        | Clean break, remove `.withExtensions()` | Avoids two ways to do the same thing                   |
| Extension context      | Client-so-far (minus lifecycle)         | Simpler mental model, fewer special types              |
| `.withActions()`       | Available at every point, terminal      | Actions are always last, never followed by extensions  |
| Both APIs              | Static + Dynamic updated                | They share the same builder concept                    |
| ySweetSync composition | Keep internal persistence option        | Orchestration order (persistence-first) is intentional |

## Current API (Before)

### Static API

```typescript
// packages/epicenter/src/static/create-workspace.ts
const client = createWorkspace(definition).withExtensions({
	persistence: indexeddbPersistence,
	sync: ySweetSync({
		auth: directAuth('...'),
		persistence: indexeddbPersistence,
	}),
});

client.extensions.persistence.whenSynced;
client.extensions.sync.provider;
```

**Types:**

```typescript
type ExtensionMap = Record<string, (...args: any[]) => Lifecycle>;

type WorkspaceClientBuilder<TId, TTableDefs, TKvDefs> =
  WorkspaceClient<TId, TTableDefs, TKvDefs, Record<string, never>> & {
    withExtensions<TExtensions extends ExtensionMap>(
      extensions: TExtensions,
    ): WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions> & {
      withActions<TActions extends Actions>(
        factory: (client: WorkspaceClient<...>) => TActions,
      ): WorkspaceClientWithActions<...>;
    };
    withActions<TActions extends Actions>(...): WorkspaceClientWithActions<...>;
  };
```

### Dynamic API

```typescript
// packages/epicenter/src/dynamic/workspace/create-workspace.ts
const workspace = createWorkspace(definition).withExtensions({
	persistence: (ctx) => workspacePersistence(ctx),
});

await workspace.whenSynced;
```

**Types:**

```typescript
type ExtensionFactoryMap = Record<string, (...args: any[]) => Lifecycle>;

type WorkspaceClientBuilder<TTableDefs, TKvFields> = WorkspaceClient<
	TTableDefs,
	TKvFields,
	Record<string, never>
> & {
	withExtensions<TExtensions extends ExtensionFactoryMap>(
		extensions: TExtensions,
	): WorkspaceClient<TTableDefs, TKvFields, TExtensions>;
};
```

## New API (After)

### Usage

```typescript
// No extensions: works immediately
const client = createWorkspace(definition);
client.tables.posts.set({ id: '1', title: 'Hello' });

// Single extension
const client = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence);

// Multiple extensions (chained)
const client = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', ySweetSync({ auth: directAuth('...') }))
  .withExtension('sqlite', sqliteExtension);

// With actions (terminal)
const client = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)
  .withActions((client) => ({
    createPost: defineMutation({ ... }),
  }));
```

### Type Signatures: Static API

```typescript
/**
 * The base workspace client. Always usable.
 */
type WorkspaceClient<
	TId extends string,
	TTableDefs extends TableDefinitions,
	TKvDefs extends KvDefinitions,
	TExtensions extends Record<string, Lifecycle>,
> = {
	id: TId;
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefs>;
	kv: KvHelper<TKvDefs>;
	definitions: { tables: TTableDefs; kv: TKvDefs };
	extensions: TExtensions;
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Context passed to extension factories.
 * This IS the client-so-far, minus lifecycle methods.
 */
type ExtensionContext<
	TId extends string,
	TTableDefs extends TableDefinitions,
	TKvDefs extends KvDefinitions,
	TExtensions extends Record<string, Lifecycle>,
> = {
	id: TId;
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefs>;
	kv: KvHelper<TKvDefs>;
	extensions: TExtensions;
};

/**
 * Builder returned by createWorkspace() and by each .withExtension() call.
 * IS a usable client AND has .withExtension() + .withActions().
 */
type WorkspaceClientBuilder<
	TId extends string,
	TTableDefs extends TableDefinitions,
	TKvDefs extends KvDefinitions,
	TExtensions extends Record<string, Lifecycle>,
> = WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions> & {
	/**
	 * Add a single extension. Returns a new builder with the extension's
	 * exports accumulated into the extensions type.
	 */
	withExtension<TKey extends string, TExports extends Lifecycle>(
		key: TKey,
		factory: (
			context: ExtensionContext<TId, TTableDefs, TKvDefs, TExtensions>,
		) => TExports,
	): WorkspaceClientBuilder<
		TId,
		TTableDefs,
		TKvDefs,
		TExtensions & Record<TKey, TExports>
	>;

	/**
	 * Attach actions. Terminal: no more chaining after this.
	 */
	withActions<TActions extends Actions>(
		factory: (
			client: WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions>,
		) => TActions,
	): WorkspaceClientWithActions<
		TId,
		TTableDefs,
		TKvDefs,
		TExtensions,
		TActions
	>;
};
```

**Key type mechanic**: Each `.withExtension()` call returns `WorkspaceClientBuilder<..., TExtensions & Record<TKey, TExports>>`. TypeScript intersects the previous extensions with the new one. The next factory's context sees all accumulated extensions.

### Type Signatures: Dynamic API

```typescript
type WorkspaceClient<
	TTableDefs extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends Record<string, Lifecycle>,
> = {
	id: string;
	ydoc: Y.Doc;
	tables: Tables<TTableDefs>;
	kv: Kv<TKvFields>;
	extensions: TExtensions;
	whenSynced: Promise<void>;
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

type ExtensionContext<
	TTableDefs extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends Record<string, Lifecycle>,
> = {
	id: string;
	ydoc: Y.Doc;
	tables: Tables<TTableDefs>;
	kv: Kv<TKvFields>;
	extensions: TExtensions;
};

type WorkspaceClientBuilder<
	TTableDefs extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends Record<string, Lifecycle>,
> = WorkspaceClient<TTableDefs, TKvFields, TExtensions> & {
	withExtension<TKey extends string, TExports extends Lifecycle>(
		key: TKey,
		factory: (
			context: ExtensionContext<TTableDefs, TKvFields, TExtensions>,
		) => TExports,
	): WorkspaceClientBuilder<
		TTableDefs,
		TKvFields,
		TExtensions & Record<TKey, TExports>
	>;
};
```

Note: The dynamic API currently has no `.withActions()`. Adding it is out of scope for this refactor but the builder pattern makes it trivial to add later.

## Context Simplification

### Before (two different shapes)

**Static ExtensionContext:**

```typescript
{
	(ydoc, id, tables, kv);
}
```

**Dynamic ExtensionContext:**

```typescript
{
	(ydoc, id, definition, tables, kv, extensionId);
}
```

### After (client-so-far, unified shape)

**Both APIs:**

```typescript
{
	(id, ydoc, tables, kv, extensions);
}
```

**What's dropped and why:**

| Dropped field | API     | Reason                                                                                                                                      |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensionId` | Dynamic | Now the first argument to `.withExtension(key, ...)`: the factory knows its key from the call site                                         |
| `definition`  | Dynamic | Workspace definitions are available via the client. For extensions that need the full definition, they can close over it from the call site |
| `definitions` | Static  | Omitted from context to keep it lean. Available on the returned client. If an extension needs it, pass via closure                          |

**Tradeoff acknowledged:** Extensions that currently destructure `extensionId` or `definition` from context will need minor refactoring. `extensionId` is trivially replaced (it's the key string). `definition` requires either closing over it or adding it to the dynamic client type.

For the dynamic API, if extensions commonly need `definition`, it can be added to the context type:

```typescript
// Dynamic-only: include definition if extensions need it
type ExtensionContext<TTableDefs, TKvFields, TExtensions> = {
	id: string;
	ydoc: Y.Doc;
	definition: WorkspaceDefinition<TTableDefs, TKvFields>;
	tables: Tables<TTableDefs>;
	kv: Kv<TKvFields>;
	extensions: TExtensions;
};
```

This is an implementation decision. The implementer should check how many extensions actually use `definition` and decide.

## Progressive Type Safety: Worked Example

```typescript
const client = createWorkspace(definition)
	// Factory receives: { id, ydoc, tables, kv, extensions: {} }
	.withExtension('persistence', ({ ydoc }) => {
		const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
		return defineExports({
			whenSynced: idb.whenSynced,
			destroy: () => idb.destroy(),
			clearData: () => idb.clearData(),
		});
	})
	// Factory receives: { id, ydoc, tables, kv, extensions: { persistence: { clearData, ... } } }
	.withExtension('sync', ({ ydoc, extensions }) => {
		// extensions.persistence is fully typed here!
		// Could access extensions.persistence.clearData if needed
		const provider = createYjsProvider(ydoc, ydoc.guid, authEndpoint);
		return defineExports({
			provider,
			whenSynced: waitForFirstSync(provider),
			destroy: () => provider.destroy(),
		});
	});

// client.extensions.persistence.clearData: typed
// client.extensions.sync.provider: typed
```

## Implementation: Static `createWorkspace.ts`

The core change is replacing the single `withExtensions(map)` method with a recursive `buildClient` that returns a new builder each time.

```typescript
export function createWorkspace<
	TId extends string,
	TTableDefs extends TableDefinitions = Record<string, never>,
	TKvDefs extends KvDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<TId, TTableDefs, TKvDefs>,
): WorkspaceClientBuilder<TId, TTableDefs, TKvDefs, Record<string, never>> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (config.tables ?? {}) as TTableDefs;
	const kvDefs = (config.kv ?? {}) as TKvDefs;
	const tables = createTables(ydoc, tableDefs);
	const kv = createKv(ydoc, kvDefs);
	const definitions = { tables: tableDefs, kv: kvDefs };

	// Internal state: accumulated cleanup functions
	// Shared across the builder chain (same ydoc)
	const extensionCleanups: (() => MaybePromise<void>)[] = [];

	function buildClient<TExtensions extends Record<string, Lifecycle>>(
		extensions: TExtensions,
	): WorkspaceClientBuilder<TId, TTableDefs, TKvDefs, TExtensions> {
		const destroy = async (): Promise<void> => {
			// Destroy extensions in reverse order (last added = first destroyed)
			for (let i = extensionCleanups.length - 1; i >= 0; i--) {
				await extensionCleanups[i]!();
			}
			ydoc.destroy();
		};

		const client = {
			id,
			ydoc,
			tables,
			kv,
			definitions,
			extensions,
			destroy,
			[Symbol.asyncDispose]: destroy,
		};

		return Object.assign(client, {
			withExtension<TKey extends string, TExports extends Lifecycle>(
				key: TKey,
				factory: (
					context: ExtensionContext<TId, TTableDefs, TKvDefs, TExtensions>,
				) => TExports,
			) {
				const exports = factory({ id, ydoc, tables, kv, extensions });
				extensionCleanups.push(() => exports.destroy());

				const newExtensions = {
					...extensions,
					[key]: exports,
				} as TExtensions & Record<TKey, TExports>;

				return buildClient(newExtensions);
			},

			withActions<TActions extends Actions>(
				factory: (
					client: WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions>,
				) => TActions,
			) {
				const actions = factory(
					client as WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions>,
				);
				return { ...client, actions } as WorkspaceClientWithActions<
					TId,
					TTableDefs,
					TKvDefs,
					TExtensions,
					TActions
				>;
			},
		});
	}

	return buildClient({} as Record<string, never>);
}
```

**Key details:**

- `extensionCleanups` is shared mutable state across the chain. Each `.withExtension()` call pushes to it and returns a new typed view.
- Destroy runs cleanups in **reverse order** (LIFO). Extensions added last depend on earlier ones, so they should be torn down first.
- The `extensions` parameter to `buildClient` is the typed view used for the return type and context.

## Implementation: Dynamic `createWorkspace.ts`

Same pattern as static, but with the dynamic API's type parameters and `whenSynced` aggregation:

```typescript
export function createWorkspace<
	const TTableDefs extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefs, TKvFields>,
): WorkspaceClientBuilder<TTableDefs, TKvFields, Record<string, never>> {
	const id = definition.id;
	const ydoc = new Y.Doc({ guid: id, gc: true });
	const tables = createTables(ydoc, definition.tables ?? []);
	const kv = createKv(ydoc, definition.kv ?? []);

	const extensionCleanups: (() => MaybePromise<void>)[] = [];
	const whenSyncedPromises: Promise<unknown>[] = [];

	function buildClient<TExtensions extends Record<string, Lifecycle>>(
		extensions: TExtensions,
	): WorkspaceClientBuilder<TTableDefs, TKvFields, TExtensions> {
		const whenSynced = Promise.all(whenSyncedPromises).then(() => {});

		const destroy = async (): Promise<void> => {
			for (let i = extensionCleanups.length - 1; i >= 0; i--) {
				await extensionCleanups[i]!();
			}
			ydoc.destroy();
		};

		const client = {
			id,
			ydoc,
			tables,
			kv,
			extensions,
			whenSynced,
			destroy,
			[Symbol.asyncDispose]: destroy,
		};

		return Object.assign(client, {
			withExtension<TKey extends string, TExports extends Lifecycle>(
				key: TKey,
				factory: (
					context: ExtensionContext<TTableDefs, TKvFields, TExtensions>,
				) => TExports,
			) {
				const result = factory({ id, ydoc, tables, kv, extensions });
				const exports = defineExports(
					result as Record<string, unknown>,
				) as unknown as TExports;
				extensionCleanups.push(() => exports.destroy());
				whenSyncedPromises.push(exports.whenSynced);

				const newExtensions = {
					...extensions,
					[key]: exports,
				} as TExtensions & Record<TKey, TExports>;

				return buildClient(newExtensions);
			},
		});
	}

	return buildClient({} as Record<string, never>);
}
```

**Dynamic-specific notes:**

- `whenSynced` is recomputed at each builder step from the accumulated promises list.
- `defineExports()` normalization is preserved: factories can return bare objects and lifecycle defaults are filled in.

## How Existing Extensions Adapt

### `indexeddbPersistence`: No change needed

```typescript
// Before
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) { ... }

// After: same signature, works as-is
.withExtension('persistence', indexeddbPersistence)
```

The function destructures `{ ydoc }` from the context. Since the new context is a superset (`{ id, ydoc, tables, kv, extensions }`), destructuring `{ ydoc }` still works.

### `ySweetSync`: No change needed

```typescript
// Before
createWorkspace(def).withExtensions({
	sync: ySweetSync({
		auth: directAuth('...'),
		persistence: indexeddbPersistence,
	}),
});

// After
createWorkspace(def).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('...'),
		persistence: indexeddbPersistence,
	}),
);
```

`ySweetSync(config)` returns a factory function `({ ydoc }) => Lifecycle`. The returned factory destructures `{ ydoc }` from context: works unchanged.

### `persistence` (desktop): No change needed

```typescript
// Before
.withExtensions({
  persistence: (ctx) => persistence(ctx, { filePath: '...' }),
})

// After
.withExtension('persistence', (ctx) => persistence(ctx, { filePath: '...' }))
```

### `workspacePersistence` (Tauri app): Minor fix

```typescript
// Before (has a bug: uses ctx.workspaceId but type has ctx.id)
// After: fix the bug, use ctx.id
.withExtension('persistence', (ctx) => workspacePersistence(ctx))
```

The `workspacePersistence` function currently destructures `{ ydoc, workspaceId, kv }` from `ExtensionContext`. The field is `id` not `workspaceId` (pre-existing bug). Fix by changing the destructure to `{ ydoc, id, kv }`.

### Extensions that use `extensionId`: Minor change

Any extension that uses `extensionId` from the dynamic context would need to get it from the key argument at the call site instead. In practice, `extensionId` is rarely used. Grep for it and update any occurrences.

## Migration Guide: Call Sites

### `apps/tab-manager/src/lib/workspace.ts`

```typescript
// Before
export const popupWorkspace = createWorkspace(definition).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
});

// After
export const popupWorkspace = createWorkspace(definition).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);
```

### `apps/tab-manager/src/entrypoints/background.ts`

```typescript
// Before
const client = createWorkspace(definition).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
});

// After
const client = createWorkspace(definition).withExtension(
	'sync',
	ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);
```

### `apps/epicenter/src/lib/yjs/workspace.ts`

```typescript
// Before
return createWorkspace(definition).withExtensions({
	persistence: (ctx) => workspacePersistence(ctx),
});

// After
return createWorkspace(definition).withExtension('persistence', (ctx) =>
	workspacePersistence(ctx),
);
```

### Test files

All test files that use `.withExtensions({...})` need mechanical conversion:

```typescript
// Before
const client = createWorkspace({...}).withExtensions({
  mock: mockExtension,
  sync: syncExtension,
});

// After
const client = createWorkspace({...})
  .withExtension('mock', mockExtension)
  .withExtension('sync', syncExtension);
```

## Type Changes Summary

### Removed types

| Type                       | Location                     | Replacement                                               |
| -------------------------- | ---------------------------- | --------------------------------------------------------- |
| `ExtensionMap`             | `static/types.ts`            | No longer needed: extensions are added one at a time     |
| `ExtensionFactoryMap`      | `dynamic/workspace/types.ts` | No longer needed                                          |
| `InferExtensionExports<T>` | Both                         | No longer needed: extensions accumulate via intersection |

### Changed types

| Type                     | Change                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `WorkspaceClient`        | `TExtensions` constraint changes from `extends ExtensionMap` to `extends Record<string, Lifecycle>` |
| `WorkspaceClientBuilder` | Adds `TExtensions` generic param, replaces `withExtensions` with `withExtension`                    |
| `ExtensionContext`       | Simplified to client-so-far shape, gains `extensions` field, parameterized by `TExtensions`         |
| `ExtensionFactory`       | Removed as standalone type. Factory signature is inline in `withExtension`'s parameter              |

### New types

None. The refactor simplifies by removing types, not adding them.

## Related: ySweetSync Naming

The `ySweetSync` extension composes both persistence and sync into a single lifecycle. It's not purely "sync". It orchestrates:

1. Load from persistence (IndexedDB/filesystem)
2. Connect WebSocket in background
3. Coordinate `whenSynced` to resolve on persistence load (not network)
4. Destroy both on cleanup

The name `ySweetSync` undersells what it does. Consider renaming to something that reflects the composed nature:

- `ySweetProvider`: mirrors Yjs terminology ("provider" = thing that connects a Y.Doc to something)
- `ySweetConnection`: describes the full connection lifecycle
- `ySweet`: simplest, since it IS the Y-Sweet integration

Additionally, `persistence` being optional in `YSweetSyncConfig` is questionable. The entire design assumes a local-first pattern where persistence loads first. Without persistence, it degrades to a simple WebSocket provider, which `websocket-sync.ts` already covers.

**Recommendation for future work (out of scope for this spec):**

1. Rename `ySweetSync` to `ySweet` (or `ySweetProvider`)
2. Make `persistence` required in the config
3. For "sync only, no persistence" use cases, point users to `websocket-sync.ts`

## Implementation Plan

### Phase 1: Type changes

- [x] Update `WorkspaceClient` type to use `TExtensions extends Record<string, Lifecycle>` in both APIs
- [x] Replace `WorkspaceClientBuilder` type with `withExtension(key, factory)` signature in both APIs
- [x] Simplify `ExtensionContext` to client-so-far shape in both APIs
- [x] Remove `ExtensionMap`, `ExtensionFactoryMap`, `InferExtensionExports` types
- [x] Update `ExtensionFactory` type or remove it (check if extension authors import it)

### Phase 2: Implementation: Static API

- [x] Rewrite `createWorkspace()` in `packages/epicenter/src/static/create-workspace.ts` with the recursive `buildClient` pattern
- [x] Ensure `withActions()` is available on every builder step
- [x] Ensure `destroy()` runs cleanups in reverse order

### Phase 3: Implementation: Dynamic API

- [x] Rewrite `createWorkspace()` in `packages/epicenter/src/dynamic/workspace/create-workspace.ts` with the recursive `buildClient` pattern
- [x] Ensure `whenSynced` is correctly aggregated across the chain
- [x] Ensure `destroy()` runs cleanups in reverse order

### Phase 4: Update extension re-exports

- [x] Update `packages/epicenter/src/dynamic/extension.ts`: remove/update re-exported types
- [x] Update `packages/epicenter/src/static/index.ts`: update exports
- [x] Update any barrel files that re-export `ExtensionMap`, `ExtensionFactoryMap`, etc.

### Phase 5: Migrate call sites

- [x] `apps/tab-manager/src/lib/workspace.ts`
- [x] `apps/tab-manager/src/entrypoints/background.ts`
- [x] `apps/epicenter/src/lib/yjs/workspace.ts`
- [x] Fix `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: `workspaceId` to `id` (pre-existing bug)

### Phase 6: Migrate tests

- [x] `packages/epicenter/src/static/define-workspace.test.ts`: update all `.withExtensions()` calls
- [x] `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`: update all `.withExtensions()` calls
- [x] `packages/epicenter/src/extensions/y-sweet-sync.test.ts`: verify factory still works with new context shape
- [ ] Add new test: progressive type access (extension N+1 can access extension N's exports)
- [ ] Add new test: `.withActions()` works after `.withExtension()` chain (static API)
- [ ] Add new test: destroy runs in reverse order

### Phase 7: Verify

- [ ] Run `bun test` across affected packages
- [ ] Run `bun run typecheck` to verify no type errors
- [x] Grep for any remaining `.withExtensions(` references and update them

## Files Changed

| File                                                                | Change                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/epicenter/src/static/types.ts`                            | Remove `ExtensionMap`, `InferExtensionExports`; update `WorkspaceClient`, `WorkspaceClientBuilder`, `ExtensionContext`, `ExtensionFactory`        |
| `packages/epicenter/src/static/create-workspace.ts`                 | Rewrite builder with recursive `buildClient` + `withExtension`                                                                                    |
| `packages/epicenter/src/dynamic/workspace/types.ts`                 | Remove `ExtensionFactoryMap`, `InferExtensionExports`; update `WorkspaceClient`, `WorkspaceClientBuilder`, `ExtensionContext`, `ExtensionFactory` |
| `packages/epicenter/src/dynamic/workspace/create-workspace.ts`      | Rewrite builder with recursive `buildClient` + `withExtension`                                                                                    |
| `packages/epicenter/src/dynamic/extension.ts`                       | Update re-exports                                                                                                                                 |
| `packages/epicenter/src/static/index.ts`                            | Update exports                                                                                                                                    |
| `packages/epicenter/src/extensions/y-sweet-sync.ts`                 | No change (factory signature compatible)                                                                                                          |
| `packages/epicenter/src/extensions/persistence/web.ts`              | No change                                                                                                                                         |
| `packages/epicenter/src/extensions/persistence/desktop.ts`          | No change                                                                                                                                         |
| `apps/tab-manager/src/lib/workspace.ts`                             | Migrate call site                                                                                                                                 |
| `apps/tab-manager/src/entrypoints/background.ts`                    | Migrate call site                                                                                                                                 |
| `apps/epicenter/src/lib/yjs/workspace.ts`                           | Migrate call site                                                                                                                                 |
| `apps/epicenter/src/lib/yjs/workspace-persistence.ts`               | Fix `workspaceId` to `id` bug                                                                                                                     |
| `packages/epicenter/src/static/define-workspace.test.ts`            | Migrate tests                                                                                                                                     |
| `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts` | Migrate tests                                                                                                                                     |
| `packages/epicenter/src/extensions/y-sweet-sync.test.ts`            | Verify compatibility                                                                                                                              |

## Edge Cases

### Empty extensions

```typescript
const client = createWorkspace(definition);
client.extensions; // {}: typed as Record<string, never>
```

### Extension key collision

If someone chains `.withExtension('x', f1).withExtension('x', f2)`, the intersection type becomes `Record<'x', T1> & Record<'x', T2>`. TypeScript intersects the two export types, which may produce `never` fields if they conflict. This is a user error and TypeScript's type narrowing signals it. No runtime guard needed.

### Builder reuse (forking)

```typescript
const base = createWorkspace(definition).withExtension(
	'persistence',
	indexeddbPersistence,
);

const withSync = base.withExtension('sync', syncFactory);
const withSqlite = base.withExtension('sqlite', sqliteFactory);
```

**Warning:** This creates a shared mutation hazard: `extensionCleanups` is shared. Both branches accumulate into the same array. **Document that the builder is consumed linearly. Forking is not supported.**
