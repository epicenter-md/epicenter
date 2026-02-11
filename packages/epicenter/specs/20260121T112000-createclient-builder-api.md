# createClient Builder API

**Date**: 2026-01-21
**Status**: Planning

## Problem

TypeScript cannot properly infer generic parameters when `extensions` is passed in the same object literal as the definition:

```typescript
// BROKEN: ctx is typed as 'any' or 'never'
createClient(emailDefinition, {
	extensions: {
		persistence: (ctx) => persistence(ctx, { filePath }),
		//            ^^^ TypeScript can't infer ctx type
	},
});
```

This happens because TypeScript must infer `TTableDefinitionMap` and `TKvDefinitionMap` from the definition AND use them to type the extensions map simultaneously. When `kv: {}` becomes `Record<string, never>`, the extension factory type collapses.

## Solution: Sequential Builder API

Split client creation into sequential method calls so TypeScript can infer types step-by-step.

## API Design

### Core Requirements

Two things are always required:

1. **id** - Workspace identifier (for Y.Doc GUID)
2. **epoch** - Version number (defaults to 0)

### Two Paths

```
                    createClient(id, { epoch? })
                              │
                              ▼
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
     .withDefinition(def)              .withExtensions({})
              │                               │
              │                               │
              ▼                               ▼
     .withExtensions({})               WorkspaceClient
              │                        (dynamic schema)
              │
              ▼
       WorkspaceClient
       (static schema)
```

### Path 1: Static Schema (Code-Defined)

For apps like Whispering where schema is defined in code:

```typescript
const definition = defineWorkspace({
	id: 'epicenter.whispering',
	tables: {
		recordings: { id: id(), title: text(), transcript: text() },
	},
	kv: {},
});

// Step 1: Start with id (extracted from definition)
// Step 2: Attach definition (TypeScript infers table/kv types)
// Step 3: Attach extensions (ctx is now fully typed!)

const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		persistence: (ctx) => persistence(ctx, { filePath }),
		//            ^^^ ctx: ExtensionContext<typeof definition.tables, typeof definition.kv>
	});
```

**Shorthand** (since definition already has id):

```typescript
const client = createClient(definition).withExtensions({
	persistence: (ctx) => persistence(ctx, { filePath }),
});
```

### Path 2: Dynamic Schema (Y.Doc-Defined)

For the Epicenter app where schema lives in the Y.Doc:

```typescript
// No code-defined schema - just id and extensions
const client = createClient('my-workspace').withExtensions({
	persistence: (ctx) => persistence(ctx, { filePath }),
	//            ^^^ ctx: ExtensionContext<TableDefinitionMap, KvDefinitionMap> (generic)
});

// Schema is read from Y.Doc after persistence loads
// Tables/KV are dynamically typed based on Y.Doc content
```

### Epoch Parameter

Epoch can be passed in the initial call:

```typescript
// With epoch
const client = createClient(definition, { epoch: 2 })
  .withExtensions({ ... });

// Or for dynamic schema
const client = createClient('my-workspace', { epoch: 2 })
  .withExtensions({ ... });

// Epoch defaults to 0 if omitted
const client = createClient(definition)
  .withExtensions({ ... });
```

## Type Signatures

```typescript
// Entry point - accepts definition or just id
function createClient<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
>(
	definition: WorkspaceDefinition<TTableDefinitionMap, TKvDefinitionMap>,
	options?: { epoch?: number },
): ClientBuilder<TTableDefinitionMap, TKvDefinitionMap>;

function createClient(
	workspaceId: string,
	options?: { epoch?: number },
): ClientBuilder<TableDefinitionMap, KvDefinitionMap>;

// Builder type
type ClientBuilder<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
> = {
	// For dynamic schema path - attach definition later
	withDefinition<
		TDef extends WorkspaceDefinition<TTableDefinitionMap, TKvDefinitionMap>,
	>(
		definition: TDef,
	): ClientBuilder<TDef['tables'], TDef['kv']>;

	// Terminal - attach extensions and get client
	withExtensions<
		TExtensionFactories extends ExtensionFactoryMap<
			TTableDefinitionMap,
			TKvDefinitionMap
		>,
	>(
		extensions: TExtensionFactories,
	): WorkspaceClient<
		TTableDefinitionMap,
		TKvDefinitionMap,
		InferExtensionExports<TExtensionFactories>
	>;

	// Terminal - no extensions, just get client
	build(): WorkspaceClient<TTableDefinitionMap, TKvDefinitionMap, {}>;
};
```

## Why This Works

1. **First call** (`createClient(definition)`):
   - TypeScript infers `TTableDefinitionMap` and `TKvDefinitionMap` from definition
   - Returns a `ClientBuilder` parameterized with those types

2. **Second call** (`.withExtensions({ ... })`):
   - Builder already has the table/kv types locked in
   - Extension factory context is properly typed
   - No simultaneous inference needed

## Migration

### Before

```typescript
// Broken inference
const client = await createClient(emailDefinition, {
	extensions: {
		persistence: (ctx) => persistence(ctx, { filePath }),
	},
});
```

### After

```typescript
// Working inference
const client = createClient(emailDefinition).withExtensions({
	persistence: (ctx) => persistence(ctx, { filePath }),
});
```

## Implementation Notes

### Async Considerations

The builder methods are synchronous; the actual Y.Doc creation happens when:

- `.withExtensions()` is called (returns the client)
- `.build()` is called (returns the client without extensions)

The returned client has a `whenSynced` promise for async initialization.

### Backward Compatibility

Keep the old API working but deprecated:

```typescript
// Old API (deprecated, type inference broken)
const client = createClient(definition, { extensions: { ... } });

// New API (recommended)
const client = createClient(definition).withExtensions({ ... });
```

## Examples

### Whispering App (Static Schema)

```typescript
import { defineWorkspace, createClient, id, text } from '@epicenter/hq/dynamic';
import { persistence } from '@epicenter/hq/extensions/persistence';

const whisperingDefinition = defineWorkspace({
  id: 'epicenter.whispering',
  tables: {
    recordings: {
      id: id(),
      title: text(),
      transcript: text({ nullable: true }),
    },
  },
  kv: {},
});

const client = createClient(whisperingDefinition)
  .withExtensions({
    persistence: (ctx) => persistence(ctx, {
      filePath: join(epicenterDir, 'persistence', `${ctx.id}.yjs`),
    }),
  });

await client.whenSynced;
client.tables.recordings.upsert({ ... });
```

### Epicenter App (Dynamic Schema)

```typescript
import { createClient } from '@epicenter/hq/dynamic';
import { persistence } from '@epicenter/hq/extensions/persistence';

// Schema comes from Y.Doc, not code
const client = createClient('user-workspace-123', { epoch: 2 }).withExtensions({
	persistence: (ctx) =>
		persistence(ctx, {
			filePath: join(dataDir, `${ctx.id}.yjs`),
		}),
});

await client.whenSynced;

// Tables are dynamically available based on Y.Doc schema
for (const table of client.tables.defined()) {
	console.log(table.name, table.count());
}
```

### Simulation Scripts

```typescript
const client = createClient(emailDefinition).withExtensions({
	persistence: (ctx) => persistence(ctx, { filePath: YJS_PATH }),
});
```

## Todo

- [x] Implement `ClientBuilder` type
- [x] Refactor `createClient` to return builder (only accepts workspaceId + epoch)
- [x] Implement `.withDefinition()` method
- [x] Implement `.withExtensions()` method (terminal operation, returns client)
- [x] ~~Implement `.build()` method~~ (removed - `.withExtensions({})` serves same purpose)
- [x] Update all usages in codebase (scripts, apps/epicenter)
- [x] Update JSDoc examples in source files (persistence, sqlite, websocket-sync, revision-history, head-doc, server)
- [x] Update internal READMEs (core/workspace/README.md, core/docs/README.md)
- [x] Update main README (packages/epicenter/README.md) - removed `withProviders`/`createWithHandlers` patterns
- [x] ~~Deprecate old API with JSDoc warning~~ (removed old API entirely)

## Status: Complete

All documentation and implementation updated to use the new builder API pattern.
