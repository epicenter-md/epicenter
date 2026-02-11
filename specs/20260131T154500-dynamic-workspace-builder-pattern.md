# Dynamic Workspace Builder Pattern

**Status**: Implemented (2026-01-31) - BREAKING CHANGE

Standardize the dynamic workspace API to match the static workspace builder pattern, enabling optional extension chaining.

## Problem Statement

The dynamic workspace API (`src/dynamic/`) requires extensions to be passed upfront in the configuration object:

```typescript
// CURRENT: Extensions required at creation time
const workspace = createWorkspaceDoc({
  headDoc,
  tables: [...],
  kv: [...],
  extensionFactories: { sqlite, persistence }  // Cannot be omitted
});
```

This differs from the static workspace API (`src/static/`), which returns a **builder that IS a client**:

```typescript
// STATIC: Builder pattern - usable immediately OR chainable
const client = createWorkspace({ id: 'my-app', tables: { posts } });
client.tables.posts.set({...});  // Works immediately!

// OR chain to add extensions
const client = createWorkspace({ id: 'my-app', tables: { posts } })
  .withExtensions({ sqlite, persistence });
```

**Issues with current dynamic API:**

1. **No gradual adoption**: Must decide on all extensions upfront
2. **Inconsistent ergonomics**: Different patterns between static and dynamic
3. **Type complexity**: Extension types tightly coupled to creation function
4. **Testing friction**: Can't easily create a client without mocking extensions

## Goals

1. **Unified API pattern**: Dynamic follows the same builder pattern as static
2. **Optional extensions**: `withExtensions()` is chainable but not required
3. **Type safety preserved**: Full type inference for extensions
4. **Direct usability**: Returned builder IS a client (usable immediately)
5. **HeadDoc integration**: `headDoc` parameter extracts `workspaceId` and `epoch`

## Non-Goals

- Changing the underlying Y.Doc structure
- Modifying HeadDoc API
- Changing table/KV helper APIs
- Merging static and dynamic into one module

---

## API Design

### Current Dynamic API (Before)

```typescript
// Must pass all extensions upfront
const workspace = createWorkspaceDoc({
  headDoc,
  tables: [table({ id: 'posts', name: 'Posts', fields: [...] })],
  kv: [select({ id: 'theme', options: ['light', 'dark'] })],
  extensionFactories: {
    sqlite: (ctx) => sqliteExtension(ctx),
    persistence: (ctx) => persistenceExtension(ctx),
  },
});

// Returns WorkspaceDoc with extensions already initialized
workspace.tables.get('posts').upsert({...});
workspace.extensions.sqlite.db.select()...;
```

### Proposed Dynamic API (After)

```typescript
// Option 1: Direct use (no extensions)
const workspace = createWorkspace({
  headDoc,
  definition,  // WorkspaceDefinition { name, tables, kv }
});
workspace.tables.get('posts').upsert({...});  // Works!
workspace.extensions;  // {} empty object

// Option 2: With extensions (chained)
const workspace = createWorkspace({
  headDoc,
  definition,
}).withExtensions({
  sqlite: (ctx) => sqliteExtension(ctx),
  persistence: (ctx) => persistenceExtension(ctx),
});
workspace.extensions.sqlite;  // Typed!
```

### Key Design Decisions

| Aspect               | Decision                        | Rationale                                         |
| -------------------- | ------------------------------- | ------------------------------------------------- |
| **Function name**    | `createWorkspace`               | Matches static; shorter than `createWorkspaceDoc` |
| **Return type**      | Builder IS client               | Usable immediately; no "incomplete" state         |
| **Definition**       | Passed as `definition` property | Clear separation from headDoc                     |
| **HeadDoc**          | Required parameter              | Provides `workspaceId` and `epoch`                |
| **Extensions empty** | `extensions: {}` when none      | Not `undefined`; always safe to access            |
| **Chaining**         | Returns new client              | Immutable pattern; original unaffected            |

---

## Type Definitions

### Core Types

```typescript
// packages/epicenter/src/dynamic/workspace/types.ts

import type * as Y from 'yjs';
import type { Lifecycle } from '../../core/lifecycle';
import type { WorkspaceDefinition } from '../../core/schema/workspace-definition';
import type { Tables, TablesFunction } from './tables/create-tables';
import type { Kv, KvFunction } from './kv/core';
import type { HeadDoc } from './head-doc';

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to extension factory functions.
 *
 * Extensions receive typed access to the workspace's Y.Doc, tables, kv,
 * and identity information.
 */
export type ExtensionContext<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (from headDoc.workspaceId) */
	workspaceId: string;
	/** Epoch number (from headDoc.getOwnEpoch()) */
	epoch: number;
	/** Typed table helpers */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvFields>;
	/** This extension's key from `.withExtensions({ key: ... })` */
	extensionId: string;
};

/**
 * Factory function that creates an extension with lifecycle hooks.
 *
 * All extensions MUST return an object satisfying the Lifecycle protocol:
 * - `whenSynced`: Promise that resolves when the extension is ready
 * - `destroy`: Cleanup function called when workspace is destroyed
 */
export type ExtensionFactory<
	TTableDefinitions extends readonly TableDefinition[] =
		readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
	TExports extends Lifecycle = Lifecycle,
> = (context: ExtensionContext<TTableDefinitions, TKvFields>) => TExports;

/**
 * Map of extension factory functions.
 */
export type ExtensionFactoryMap = Record<string, (...args: any[]) => Lifecycle>;

/**
 * Infer exports from an extension factory map.
 */
export type InferExtensionExports<TExtensions extends ExtensionFactoryMap> = {
	[K in keyof TExtensions]: ReturnType<TExtensions[K]>;
};

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE CLIENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The workspace client returned by createWorkspace().
 *
 * Contains all workspace resources plus extension exports.
 */
export type WorkspaceClient<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends ExtensionFactoryMap = Record<string, never>,
> = {
	/** Workspace identifier */
	workspaceId: string;
	/** Current epoch number */
	epoch: number;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Typed table helpers */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvFields>;
	/** Extension exports (empty object if no extensions) */
	extensions: InferExtensionExports<TExtensions>;
	/** Promise resolving when all extensions are synced */
	whenSynced: Promise<void>;
	/** Cleanup all resources */
	destroy(): Promise<void>;
	/** Async dispose support for `await using` */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Builder returned by createWorkspace() that IS a client AND has .withExtensions().
 *
 * This uses Object.assign pattern to merge the base client with the builder method,
 * allowing both direct use and chaining:
 * - Direct: `createWorkspace(...).tables.get('posts').upsert(...)`
 * - Chained: `createWorkspace(...).withExtensions({ sqlite })`
 */
export type WorkspaceClientBuilder<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = WorkspaceClient<TTableDefinitions, TKvFields, Record<string, never>> & {
	/**
	 * Add extensions to the workspace client.
	 *
	 * Extensions receive typed access to ydoc, tables, kv, and workspace identity.
	 * They must return a Lifecycle object (via defineExports).
	 *
	 * @param extensions - Map of extension factories
	 * @returns New workspace client with typed extensions
	 */
	withExtensions<TExtensions extends ExtensionFactoryMap>(
		extensions: TExtensions,
	): WorkspaceClient<TTableDefinitions, TKvFields, TExtensions>;
};

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for createWorkspace().
 */
export type CreateWorkspaceConfig<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = {
	/** HeadDoc instance (provides workspaceId and epoch) */
	headDoc: HeadDoc;
	/** Workspace definition (name, tables, kv) */
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>;
};
```

---

## Implementation

### createWorkspace Function

````typescript
// packages/epicenter/src/dynamic/workspace/create-workspace.ts

import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../../core/lifecycle';
import { createTables } from './tables/create-tables';
import { createKv } from './kv/core';
import type {
	CreateWorkspaceConfig,
	ExtensionContext,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './types';

/**
 * Create a workspace client with optional extension chaining.
 *
 * Returns a client that IS directly usable AND has `.withExtensions()`
 * for adding extensions like persistence, SQLite, or sync.
 *
 * ## HeadDoc Integration
 *
 * The workspace derives its identity from the HeadDoc:
 * - `workspaceId` from `headDoc.workspaceId`
 * - `epoch` from `headDoc.getOwnEpoch()` (this client's epoch, not global max)
 *
 * ## Y.Doc Structure
 *
 * ```
 * Y.Doc (guid = `${workspaceId}-${epoch}`)
 * +-- Y.Array('table:posts')  <- Table data (LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- KV settings (LWW entries)
 * ```
 *
 * @example Direct use (no extensions)
 * ```typescript
 * const workspace = createWorkspace({
 *   headDoc,
 *   definition: { name: 'Blog', tables: [...], kv: [...] },
 * });
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * ```
 *
 * @example With extensions
 * ```typescript
 * const workspace = createWorkspace({
 *   headDoc,
 *   definition,
 * }).withExtensions({
 *   sqlite: (ctx) => sqliteExtension(ctx),
 *   persistence: (ctx) => persistenceExtension(ctx),
 * });
 *
 * await workspace.whenSynced;
 * workspace.extensions.sqlite.db.select()...;
 * ```
 */
export function createWorkspace<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	config: CreateWorkspaceConfig<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields> {
	const { headDoc, definition } = config;

	// Extract identity from HeadDoc
	const workspaceId = headDoc.workspaceId;
	const epoch = headDoc.getOwnEpoch();

	// Create Y.Doc with guid = `${workspaceId}-${epoch}`
	// gc: false is required for revision history snapshots
	const docId = `${workspaceId}-${epoch}`;
	const ydoc = new Y.Doc({ guid: docId, gc: false });

	// Create table and KV helpers bound to Y.Doc
	const tables = createTables(ydoc, definition.tables ?? []);
	const kv = createKv(ydoc, definition.kv ?? []);

	// Base destroy (no extensions)
	const destroy = async (): Promise<void> => {
		ydoc.destroy();
	};

	// Build the base client (no extensions)
	const baseClient: WorkspaceClient<
		TTableDefinitions,
		TKvFields,
		Record<string, never>
	> = {
		workspaceId,
		epoch,
		ydoc,
		tables,
		kv,
		extensions: {} as InferExtensionExports<Record<string, never>>,
		whenSynced: Promise.resolve(), // No extensions = already synced
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	// Add withExtensions method to create builder
	return Object.assign(baseClient, {
		/**
		 * Add extensions to the workspace client.
		 *
		 * Each extension factory receives context and returns a Lifecycle object.
		 * The returned client has typed access to all extension exports.
		 */
		withExtensions<TExtensions extends ExtensionFactoryMap>(
			extensionFactories: TExtensions,
		): WorkspaceClient<TTableDefinitions, TKvFields, TExtensions> {
			// Initialize extensions synchronously; async work is in their whenSynced
			const extensions = {} as InferExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				// Build context for this extension
				const context: ExtensionContext<TTableDefinitions, TKvFields> = {
					ydoc,
					workspaceId,
					epoch,
					tables,
					kv,
					extensionId,
				};

				// Factory is sync; normalize exports at boundary
				const result = factory(context);
				const exports = defineExports(result as Record<string, unknown>);
				(extensions as Record<string, unknown>)[extensionId] = exports;
			}

			// Aggregate all extension whenSynced promises
			// Fail-fast: any rejection rejects the whole thing
			const whenSynced = Promise.all(
				Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
			).then(() => {});

			// Cleanup must destroy extensions first, then Y.Doc
			const destroyWithExtensions = async (): Promise<void> => {
				await Promise.allSettled(
					Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
				);
				ydoc.destroy();
			};

			return {
				workspaceId,
				epoch,
				ydoc,
				tables,
				kv,
				extensions,
				whenSynced,
				destroy: destroyWithExtensions,
				[Symbol.asyncDispose]: destroyWithExtensions,
			};
		},
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
````

---

## Usage Examples

### Basic Usage (No Extensions)

```typescript
import {
	createWorkspace,
	createHeadDoc,
	defineWorkspace,
	table,
	id,
	text,
} from '@epicenter/hq/dynamic';

// 1. Create HeadDoc for epoch management
const headDoc = createHeadDoc({
	workspaceId: 'blog-123',
	providers: { persistence: tauriPersistence },
});
await headDoc.whenSynced;

// 2. Define workspace schema
const definition = defineWorkspace({
	name: 'My Blog',
	tables: [
		table({
			id: 'posts',
			name: 'Posts',
			fields: [id(), text({ id: 'title' })],
		}),
	],
	kv: [],
});

// 3. Create workspace (usable immediately!)
const workspace = createWorkspace({ headDoc, definition });

// 4. Use tables directly
workspace.tables.get('posts').upsert({ id: '1', title: 'Hello World' });
const posts = workspace.tables.get('posts').getAllValid();

// 5. Cleanup
await workspace.destroy();
```

### With Extensions

```typescript
// Same setup...
const workspace = createWorkspace({ headDoc, definition }).withExtensions({
	persistence: (ctx) => tauriPersistence(ctx.ydoc, ['workspace']),
	sqlite: (ctx) => sqliteExtension(ctx),
});

// Wait for extensions to sync
await workspace.whenSynced;

// Use extensions
const results = workspace.extensions.sqlite.posts
	.select()
	.where(eq(posts.published, true));

// Cleanup (destroys extensions, then Y.Doc)
await workspace.destroy();
```

### With `await using` (Auto-Cleanup)

```typescript
{
	await using workspace = createWorkspace({
		headDoc,
		definition,
	}).withExtensions({ persistence, sqlite });

	await workspace.whenSynced;
	workspace.tables.get('posts').upsert({ id: '1', title: 'Test' });
	// Auto-destroyed when block exits
}
```

### Testing (No Extensions)

```typescript
import { test, expect } from 'bun:test';
import {
	createWorkspace,
	createHeadDoc,
	defineWorkspace,
} from '@epicenter/hq/dynamic';

test('table operations work without extensions', () => {
	// Minimal HeadDoc (in-memory, no persistence)
	const headDoc = createHeadDoc({
		workspaceId: 'test',
		providers: {},
	});

	const workspace = createWorkspace({
		headDoc,
		definition: defineWorkspace({
			name: 'Test',
			tables: [
				table({
					id: 'items',
					name: 'Items',
					fields: [id(), text({ id: 'name' })],
				}),
			],
			kv: [],
		}),
	});

	workspace.tables.get('items').upsert({ id: '1', name: 'Test Item' });

	const items = workspace.tables.get('items').getAllValid();
	expect(items).toHaveLength(1);
	expect(items[0].name).toBe('Test Item');
});
```

---

## Migration Guide

### From `createWorkspaceDoc` to `createWorkspace`

**Before:**

```typescript
const workspace = createWorkspaceDoc({
	headDoc,
	tables: tableDefinitions,
	kv: kvDefinitions,
	extensionFactories: { sqlite, persistence },
});
```

**After:**

```typescript
const definition = defineWorkspace({
	name: 'My Workspace',
	tables: tableDefinitions,
	kv: kvDefinitions,
});

const workspace = createWorkspace({ headDoc, definition }).withExtensions({
	sqlite,
	persistence,
});
```

### Key Changes

| Before                                 | After                                            |
| -------------------------------------- | ------------------------------------------------ |
| `createWorkspaceDoc()`                 | `createWorkspace()`                              |
| `tables: [...]` (inline)               | `definition: defineWorkspace({ tables: [...] })` |
| `extensionFactories: {...}` (required) | `.withExtensions({...})` (optional chain)        |
| Extensions always initialized          | Extensions only if chained                       |

### Breaking Change (Implemented)

The old `createWorkspaceDoc()` API has been **removed** entirely in favor of `createWorkspace()`:

1. `createWorkspaceDoc()` function removed from `workspace-doc.ts`
2. `WorkspaceDoc` type removed; replaced with `WorkspaceClient`
3. Old extension types moved to `workspace/types.ts`
4. All consumers (server, CLI) updated to use `WorkspaceClient`

---

## Implementation Checklist

- [x] Create `packages/epicenter/src/dynamic/workspace/types.ts` with type definitions
- [x] Create `packages/epicenter/src/dynamic/workspace/create-workspace.ts` with implementation
- [x] Update `packages/epicenter/src/dynamic/workspace/index.ts` exports
- [x] Update `packages/epicenter/src/dynamic/index.ts` exports
- [x] ~~Add deprecation notice to `createWorkspaceDoc()`~~ → Removed entirely (breaking change)
- [x] Write tests for new API (16 tests passing)
- [ ] Update README documentation
- [ ] Update inline JSDoc examples

---

## Open Questions

### 1. Should `definition` be optional?

**Options:**

- A) Required (current proposal) - explicit about what workspace contains
- B) Optional with defaults - allows minimal `createWorkspace({ headDoc })`

**Decision**: Required. Explicit is better than implicit; matches static API pattern.

### 2. Should we rename `extensions` to `capabilities`?

Static uses `capabilities`, dynamic uses `extensions`. Should we unify?

**Options:**

- A) Keep both names (static=capabilities, dynamic=extensions) - different semantics
- B) Unify to `extensions` - extensions extend functionality
- C) Unify to `capabilities` - capabilities provide capabilities

**Decision**: Keep current names for now. Both work semantically. Can unify later if needed.

### 3. Should `withExtensions` return the same instance or a new one?

**Options:**

- A) Same instance (mutates) - simpler, less allocation
- B) New instance (immutable) - safer, allows reuse of base client

**Decision**: New instance (immutable). Aligns with functional patterns and prevents accidental mutation.

---

## Success Criteria

- [x] `createWorkspace()` returns a usable client without calling `withExtensions()`
- [x] `withExtensions()` is chainable and returns typed extensions
- [x] All existing tests pass with new API
- [x] New tests cover builder pattern scenarios (16 tests)
- [x] JSDoc examples are accurate and compile
- [x] TypeScript inference works for extension exports

---

## Implementation Notes (2026-01-31)

**Note (2026-01-31)**: After this implementation, the `dynamic/docs/` folder was flattened. Files like `head-doc.ts` and `workspace-doc.ts` were moved directly into `dynamic/`, so imports in this spec that reference `../docs/head-doc` should be updated to `./head-doc`. The workspace builder pattern itself remains unchanged.

### Files Created

1. **`packages/epicenter/src/dynamic/workspace/types.ts`** - Type definitions:
   - `ExtensionContext` - context passed to extension factories
   - `ExtensionFactory` - factory function type
   - `ExtensionFactoryMap` - map of factories
   - `InferExtensionExports` - infer return types
   - `WorkspaceClient` - the client type with typed extensions
   - `WorkspaceClientBuilder` - client + `.withExtensions()` method
   - `CreateWorkspaceConfig` - config with `headDoc` and `definition`

2. **`packages/epicenter/src/dynamic/workspace/create-workspace.ts`** - Implementation

3. **`packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`** - 16 tests (all passing)

### Files Modified

1. **`packages/epicenter/src/dynamic/docs/workspace-doc.ts`** - Trimmed to only Y.Map type aliases and `WORKSPACE_DOC_MAPS` constant
2. **`packages/epicenter/src/dynamic/docs/index.ts`** - Removed `createWorkspaceDoc` and `WorkspaceDoc` exports
3. **`packages/epicenter/src/dynamic/extension.ts`** - Now exports from `workspace/types.ts`
4. **`packages/epicenter/src/dynamic/workspace/index.ts`** - Exports new API, removed `WorkspaceDoc` re-export
5. **`packages/epicenter/src/server/server.ts`** - Uses `WorkspaceClient` instead of `WorkspaceDoc`
6. **`packages/epicenter/src/server/tables.ts`** - Uses `WorkspaceClient` instead of `WorkspaceDoc`
7. **`packages/epicenter/src/cli/cli.ts`** - Uses `WorkspaceClient` instead of `WorkspaceDoc`
8. **`packages/epicenter/src/cli/discovery.ts`** - Uses `WorkspaceClient` instead of `WorkspaceDoc`
9. **`packages/epicenter/src/index.ts`** - Exports `WorkspaceClient`, `WorkspaceClientBuilder`; removed `createWorkspaceDoc`, `WorkspaceDoc`

### Migration for Consumers

```typescript
// Before
import { createWorkspaceDoc, WorkspaceDoc } from '@epicenter/hq';
const workspace: WorkspaceDoc = createWorkspaceDoc({
  headDoc,
  tables: [...],
  kv: [...],
  extensionFactories: { sqlite, persistence },
});

// After
import { createWorkspace, WorkspaceClient } from '@epicenter/hq';
const workspace: WorkspaceClient = createWorkspace({
  headDoc,
  definition: { name: 'Blog', tables: [...], kv: [...] },
}).withExtensions({ sqlite, persistence });
```
