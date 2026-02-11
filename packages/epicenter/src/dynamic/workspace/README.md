# Workspace

A workspace is a self-contained domain module with its own definition and typed tables.

## Quick Start

```typescript
import {
	createWorkspace,
	defineWorkspace,
	id,
	text,
	table,
} from '@epicenter/hq/dynamic';

const definition = defineWorkspace({
	id: 'my-workspace',
	name: 'My Workspace',
	description: '',
	icon: null,
	tables: [
		table({
			id: 'posts',
			name: 'Posts',
			fields: [id(), text({ id: 'title' })],
		}),
	],
	kv: [],
});

const workspace = createWorkspace(definition).withExtensions({
	persistence: (ctx) => myPersistence(ctx),
});

await workspace.whenSynced;
workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
```

## API

### `defineWorkspace(definition)`

Creates a workspace definition. Pure function, no I/O.

```typescript
const definition = defineWorkspace({
	id: 'epicenter.blog', // Locally-scoped identifier
	name: 'Blog', // Display name
	description: 'Blog posts', // Optional description
	icon: 'emoji:📝', // Optional icon (emoji:, lucide:, or url:)
	tables: [
		table({
			id: 'posts',
			name: 'Posts',
			fields: [id(), text({ id: 'title' }), text({ id: 'content' })],
		}),
	],
	kv: [], // Key-value definitions
});
```

### `createWorkspace(definition)`

Creates a workspace from a definition. Returns a builder for adding extensions.

```typescript
const workspace = createWorkspace(definition).withExtensions({
	sqlite: (ctx) => sqliteExtension(ctx),
	persistence: (ctx) => persistenceExtension(ctx),
});
```

**Key details:**

- Y.Doc created with `gc: true` for efficient YKeyValueLww storage
- No HeadDoc needed

### Extension Context

Extensions receive an `ExtensionContext` with:

```typescript
interface ExtensionContext {
	ydoc: Y.Doc; // The underlying Y.Doc
	id: string; // Workspace ID
	definition: WorkspaceDefinition;
	tables: Tables; // Table operations
	kv: KeyValueStore; // Key-value store
	extensionId: string; // The extension's key name
}
```

## Workspace Properties

```typescript
workspace.id;            // Workspace ID (e.g., 'epicenter.blog')
workspace.name;          // Display name (e.g., 'Blog')
workspace.tables;        // Table operations
workspace.kv;            // Key-value store
workspace.extensions;    // Extension exports
workspace.ydoc;          // Underlying Y.Doc
workspace.whenSynced;    // Promise that resolves when extensions are ready

await workspace.destroy();        // Cleanup resources
await using workspace = ...;      // Auto-cleanup with dispose
```

## Usage Examples

### Basic CRUD

```typescript
const workspace = createWorkspace(definition).withExtensions({});

// Create
workspace.tables
	.get('posts')
	.upsert({ id: '1', title: 'Hello', content: '...' });

// Read
const post = workspace.tables.get('posts').get({ id: '1' });
const allPosts = workspace.tables.get('posts').getAllValid();

// Update
workspace.tables.get('posts').update({ id: '1', title: 'Updated' });

// Delete (soft delete)
workspace.tables.get('posts').delete({ id: '1' });
```

### With Persistence Extension

```typescript
const workspace = createWorkspace(definition)
  .withExtensions({
    persistence: (ctx) => {
      // Load from storage, sync changes back
      return { save: () => {...}, load: () => {...} };
    },
  });

await workspace.whenSynced;
```

### Sequential Script Execution

```typescript
{
	await using workspace = createWorkspace(definition).withExtensions({
		persistence,
	});
	workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
	// Auto-disposed when block exits
}

{
	await using workspace = createWorkspace(definition).withExtensions({
		persistence,
	});
	const posts = workspace.tables.get('posts').getAllValid();
	// Auto-disposed when block exits
}
```
