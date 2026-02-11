# Epicenter: YJS-First Collaborative Workspace System

A unified workspace architecture built on YJS for real-time collaboration with optional persistence and query layers.

## Core Philosophy

**YJS Document as Source of Truth**

Epicenter uses YJS documents as the single source of truth for all data. YJS provides:

- CRDT-based conflict-free merging
- Real-time collaborative editing
- Built-in undo/redo
- Efficient binary encoding

**Unified Providers for Querying and Persistence**

Providers are a unified map of capabilities that can mirror YJS data:

- **SQLite Provider**: Enables SQL queries via Drizzle ORM
- **Markdown Provider**: Persists data as human-readable markdown files
- **Custom Providers**: Build your own (vector search, full-text search, etc.)

Providers auto-sync bidirectionally with YJS. They're completely optional—you can use just YJS, just SQLite, both, or build custom providers.

**Pure JSON Column Schemas**

Column definitions are plain JSON objects, not builder functions. This enables:

- Serialization for MCP/OpenAPI
- Runtime introspection
- Type-safe conversions to validation schemas

## Architecture Overview

### The Y.Doc: Heart of Every Workspace

Every piece of data lives in a `Y.Doc`, which provides conflict-free merging, real-time collaboration, and offline-first operation:

```
┌─────────────────────────────────────────────────────────────┐
│                      Y.Doc (CRDT)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Y.Array('table:posts')  <- LWW entries per table      │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('table:users')  <- Another table              │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('kv')  <- Settings as LWW entries             │  │
│  │   └── { key: name, val: value, ts: number }           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Note: Schema definitions are stored in static JSON files, NOT in Y.Doc.
This keeps Y.Docs lean and focused on data only.
```

### Three-Layer Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  WRITE FLOW                                                         │
│                                                                     │
│  Action Called → Y.Doc Updated → Auto-sync to Providers             │
│                       │                                             │
│              ┌────────┼────────┐                                    │
│              ▼        ▼        ▼                                    │
│         IndexedDB  SQLite   Markdown                                │
│         (or .yjs)   (.db)   (files)                                 │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  READ FLOW                                                          │
│                                                                     │
│  Query Called → Read from Provider (SQLite for complex queries)     │
│                 or directly from Y.Doc (simple lookups)             │
└────────────────────────────────────────────────────────────────────┘
```

### Multi-Device Sync Topology

Epicenter supports distributed sync where Y.Doc instances replicate across devices via y-websocket:

```
   PHONE                   LAPTOP                    DESKTOP
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │ Browser  │           │ Browser  │              │ Browser  │
   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │
   └────┬─────┘           └────┬─────┘              └────┬─────┘
        │                      │                         │
   (no server)            ┌────▼─────┐              ┌────▼─────┐
        │                 │ Elysia   │◄────────────►│ Elysia   │
        │                 │ :3913    │  server-to-  │ :3913    │
        │                 └────┬─────┘    server    └────┬─────┘
        │                      │                         │
        └──────────────────────┴─────────────────────────┘
                           Connect to multiple nodes
```

Yjs supports multiple providers simultaneously. Phone can connect to desktop, laptop, AND cloud—changes merge automatically via CRDTs.

### How It All Fits Together

1. **Define workspace** with `defineWorkspace({ id, tables, kv })`
2. **Create client builder** with `createClient(workspace.id)`
3. **Chain definition** with `.withDefinition(workspace)`
4. **Attach extensions** with `.withExtensions({ persistence, sqlite })`
5. **Y.Doc created** with workspace ID + epoch as GUID
6. **Extensions initialize** in parallel (persistence, SQLite, markdown, sync)
7. **Tables API** wraps Y.Doc with type-safe CRUD
8. **Server** exposes REST/MCP/WebSocket endpoints for actions and tables
9. **Multi-device sync** via y-websocket to any number of nodes
10. **CRDTs ensure** eventual consistency across all clients

The architecture is **local-first**: everything works offline, syncs opportunistically, and your data lives in plain files (`.yjs`, SQLite, markdown) that you fully control.

## Shared Workspace ID Convention

Epicenter uses stable, shared workspace IDs so multiple apps can collaborate on the same data.

- **Format**: `epicenter.<app>` (for example, `epicenter.whispering`)
- **Purpose**: Ensures the same workspace is discovered, synced, and shared across Epicenter apps
- **Stability**: IDs must be globally unique and never change once published
- **Usage**: The workspace ID is used for routing, persistence paths, Y.Doc IDs, and sharing

When two apps declare the same workspace ID, they intentionally point to the same shared workspace and data.

## Quick Start

### Installation

```bash
bun add @epicenter/hq
```

### Basic Example

```typescript
import {
	defineWorkspace,
	createClient,
	id,
	text,
	integer,
	boolean,
	date,
	select,
	sqliteProvider,
	markdownProvider,
} from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';

// 1. Define your workspace
const blogWorkspace = defineWorkspace({
	id: 'blog',

	tables: {
		posts: {
			id: id(),
			title: text(),
			content: text({ nullable: true }),
			category: select({ options: ['tech', 'personal'] }),
			published: boolean({ default: false }),
			views: integer({ default: 0 }),
			publishedAt: date({ nullable: true }),
		},
	},

	kv: {},
});

// 2. Initialize the workspace client
const client = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({
		// Optional: Add YJS persistence (IndexedDB in browser, filesystem in Node.js)
		persistence: setupPersistence,
		// Optional: Add SQLite for SQL queries
		sqlite: (c) => sqliteProvider(c),
		// Optional: Add markdown for file-based persistence
		markdown: (c) => markdownProvider(c),
	});

// 3. Define actions (exposed via REST/MCP)
const blogActions = {
	createPost: defineMutation({
		input: type({
			title: 'string',
			'category?': '"tech" | "personal"',
		}),
		handler: async ({ title, category }) => {
			const id = generateId();
			client.tables.get('posts').upsert({
				id,
				title,
				content: null,
				category: category ?? 'tech',
				published: false,
				views: 0,
				publishedAt: null,
			});

			return Ok({ id });
		},
	}),

	getPublishedPosts: defineQuery({
		handler: async () => {
			// Query the SQLite extension with Drizzle
			const { posts } = client.extensions.sqlite;
			return await posts
				.select()
				.where(eq(posts.published, true))
				.orderBy(desc(posts.publishedAt));
		},
	}),
};

// 4. Use the actions or tables directly
const result = await blogActions.createPost.handler({ title: 'Hello World' });
if (result.error) {
	console.error('Failed to create post:', result.error);
} else {
	console.log('Created post:', result.data.id);
}

// 5. Query via table operations
const allPosts = client.tables.get('posts').getAll();
console.log('All posts:', allPosts);

// 6. Query published posts (uses SQLite extension)
const published = await blogActions.getPublishedPosts.handler();
console.log('Published:', published);

// 7. Cleanup when done
await client.destroy();
```

## Core Concepts

### Workspaces

A workspace is a self-contained module with:

- **Tables**: Table definitions with column types
- **KV Store**: Simple key-value store for settings and metadata
- **Extensions**: Capabilities including persistence, sync, and materializers (SQLite, markdown, custom)

Workspaces can be defined once and used to create multiple clients at different epochs.

### YJS Document

Every workspace has a YJS document that stores all table data. The YJS document:

- Is the source of truth for all data
- Supports real-time collaboration
- Provides CRDT-based conflict resolution
- Enables undo/redo
- Can be persisted to disk or IndexedDB

### Tables

Tables are defined as column schemas (pure JSON):

```typescript
tables: {
  posts: {
    id: id(),                           // Auto-generated ID (always required)
    title: text(),                      // NOT NULL by default
    content: text({ nullable: true }), // Explicitly nullable
    views: integer({ default: 0 }),    // NOT NULL with default
  }
}
```

At runtime, tables become YJS-backed collections with CRUD operations:

```typescript
tables.get('posts').upsert({ id: '1', title: 'Hello', ... })
tables.get('posts').get({ id: '1' })
tables.get('posts').update({ id: '1', views: 100 })
tables.get('posts').delete({ id: '1' })
```

### Extensions

Extensions add capabilities to your workspace, such as persistence, sync, and materializers (SQLite, markdown). They are attached to the client during initialization:

```typescript
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		persistence: setupPersistence, // YJS persistence
		sqlite: (c) => sqliteProvider(c), // SQL queries via Drizzle ORM
		markdown: (c) => markdownProvider(c), // File-based persistence
	});
```

Materializer extensions (sqlite, markdown) automatically sync with YJS:

- **Write to YJS** → Extensions auto-update
- **Pull from extension** → Replaces YJS data
- **Push to extension** → Replaces extension data

Access extension exports in your actions:

```typescript
const queryPosts = defineQuery({
  handler: async () => {
    // Access SQLite extension via client.extensions
    const { sqlite } = client.extensions;
    return await sqlite.posts.select().where(...);
  }
});
```

Extension factory functions receive a context object with `{ id, extensionId, ydoc, tables, kv }` and can return exports. For example, sync extensions:

```typescript
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		persistence: setupPersistence,
		sqlite: (c) => sqliteProvider(c),

		// WebSocket sync (y-websocket protocol)
		sync: createWebsocketSyncProvider({
			url: 'ws://localhost:3913/sync',
		}),
	});
```

### Actions

Actions are workspace operations defined with `defineQuery` (read) or `defineMutation` (write). They are lightweight objects that can be exposed via REST, MCP, or CLI:

```typescript
const blogActions = {
  getPost: defineQuery({
    input: type({ id: 'string' }),
    handler: ({ id }) => {
      return client.tables.get('posts').get({ id });
    }
  }),

  createPost: defineMutation({
    input: type({ title: 'string' }),
    handler: ({ title }) => {
      const id = generateId();
      client.tables.get('posts').upsert({ id, title, ... });
      return { id };
    }
  })
};
```

Actions can be exposed via MCP servers or HTTP APIs by passing them to `createServer()`.

## Column Types

All columns support `nullable` (default: `false`) and `default` options.

### `id()`

Auto-generated primary key. Always required, always NOT NULL.

```typescript
id: id();
```

### `text(options?)`

Text column.

```typescript
name: text(); // NOT NULL
bio: text({ nullable: true }); // Nullable
role: text({ default: 'user' }); // NOT NULL with default
```

### `ytext(options?)`

Collaborative text editor column using Y.Text. Supports inline formatting and is ideal for code editors (Monaco, CodeMirror) or simple rich text (Quill).

```typescript
code: ytext(); // Collaborative code editor
notes: ytext({ nullable: true }); // Optional collaborative text
```

### `integer(options?)`, `real(options?)`

Numeric columns.

```typescript
age: integer();
price: real({ default: 0.0 });
score: integer({ nullable: true });
```

### `boolean(options?)`

Boolean column.

```typescript
published: boolean({ default: false });
verified: boolean({ nullable: true });
```

### `date(options?)`

Date with timezone support using `DateTimeString` (branded string with lazy Temporal parsing).

```typescript
createdAt: date();
publishedAt: date({ nullable: true });
```

Working with dates:

```typescript
import { DateTimeString } from '@epicenter/hq';

// Create current timestamp
const now = DateTimeString.now(); // Uses system timezone
const nowNY = DateTimeString.now('America/New_York');

// Storage format: "2024-01-01T20:00:00.000Z|America/New_York"

// Parse to Temporal.ZonedDateTime when you need date math
const live = DateTimeString.parse(now);
const nextMonth = live.add({ months: 1 });

// Stringify back for storage
const stored = DateTimeString.stringify(nextMonth);
```

### `select(options)`

Single choice from predefined options.

```typescript
status: select({
	options: ['draft', 'published', 'archived'],
});

priority: select({
	options: ['low', 'medium', 'high'],
	default: 'medium',
});

visibility: select({
	options: ['public', 'private'],
	nullable: true,
});
```

### `tags(options?)`

Array of strings with optional validation.

```typescript
// Unconstrained (any string array)
tags: tags();
freeTags: tags({ nullable: true });

// Constrained (validated against options)
categories: tags({
	options: ['tech', 'personal', 'work'],
});
```

### `json(options)`

JSON column with arktype schema validation.

**Important**: When used in action inputs, schemas are converted to JSON Schema for MCP/OpenAPI. Avoid:

- Transforms: `.pipe()` (arktype), `.transform()` (Zod)
- Custom validation: `.filter()` (arktype), `.refine()` (Zod)
- Use `.matching(regex)` for patterns

```typescript
import { json } from '@epicenter/hq';
import { type } from 'arktype';

metadata: json({
	schema: type({
		key: 'string',
		value: 'string',
	}),
});

preferences: json({
	schema: type({
		theme: 'string',
		notifications: 'boolean',
	}),
	nullable: true,
	default: { theme: 'dark', notifications: true },
});
```

## Table Operations

All table operations are accessed via `tables.get('{tableName}')`.

### Upsert Operations

**`upsert(row)`**

Insert or update a row. Never fails. This is the primary way to write data.

For Y.js columns (ytext, tags), provide plain values:

- ytext: provide strings
- tags: provide arrays

```typescript
tables.get('posts').upsert({
	id: generateId(),
	title: 'Hello World',
	content: 'Post content here', // For ytext column, pass string
	tags: ['tech', 'blog'], // For tags column, pass array
	published: false,
});
```

**`upsertMany(rows)`**

Insert or update multiple rows. Never fails.

### Update Operations

**`update(partialRow)`**

Update specific fields of an existing row. **If the row doesn't exist locally, this is a no-op.**

This is intentional: Y.js uses Last-Writer-Wins at the key level when setting a Y.Map. Creating a new Y.Map for a missing row could overwrite an existing row from another peer, causing data loss.

For Y.js columns, pass plain values and they'll be synced to existing Y.Text/Y.Array.

```typescript
tables.get('posts').update({
	id: '1',
	title: 'New Title',
	tags: ['updated', 'tags'], // Syncs to existing Y.Array
});
```

**`updateMany(partialRows)`**

Update multiple rows. Rows that don't exist locally are skipped (see `update` for rationale).

### Read Operations

**`get({ id })`**

Get a row by ID. Returns a discriminated union with status:

- `{ status: 'valid', row }` - Row exists and passes validation
- `{ status: 'invalid', id, error }` - Row exists but fails validation
- `{ status: 'not_found', id }` - Row doesn't exist

Returns Y.js objects for collaborative editing:

- ytext columns: Y.Text instances
- tags columns: Y.Array instances

```typescript
const result = tables.get('posts').get({ id: '1' });
switch (result.status) {
	case 'valid':
		console.log('Row:', result.row);
		const ytext = result.row.content; // Y.Text instance
		break;
	case 'invalid':
		console.error('Validation error:', result.error.context.summary);
		break;
	case 'not_found':
		console.log('Not found:', result.id);
		break;
}
```

**`getAll()`**

Get all rows with their validation status. Returns `RowResult<Row>[]`.

```typescript
const results = tables.get('posts').getAll();
for (const result of results) {
	if (result.status === 'valid') {
		console.log(result.row.title);
	} else {
		console.log('Invalid row:', result.id);
	}
}
```

**`getAllValid()`**

Get all valid rows. Skips invalid rows that fail validation.

```typescript
const posts = tables.get('posts').getAllValid(); // Row[]
```

**`getAllInvalid()`**

Get validation errors for all invalid rows.

```typescript
const errors = tables.get('posts').getAllInvalid(); // RowValidationError[]
```

**`has({ id })`**

Check if a row exists.

```typescript
const exists = tables.get('posts').has({ id: '1' }); // boolean
```

**`count()`**

Get total row count.

```typescript
const total = tables.get('posts').count(); // number
```

**`filter(predicate)`**

Filter valid rows by predicate. Invalid rows are skipped.

```typescript
const published = tables.get('posts').filter((row) => row.published);
```

**`find(predicate)`**

Find first valid row matching predicate. Returns `Row | null`.

```typescript
const first = tables.get('posts').find((row) => row.published);
```

### Delete Operations

**`delete({ id })`**

Delete a row.

```typescript
tables.get('posts').delete({ id: '1' });
```

**`deleteMany({ ids })`**

Delete multiple rows.

```typescript
tables.get('posts').deleteMany({ ids: ['1', '2', '3'] });
```

**`clear()`**

Delete all rows.

```typescript
tables.get('posts').clear();
```

### Reactive Updates

**`observe(callback)`**

Watch for real-time changes. Returns unsubscribe function.

The callback receives a `Map<id, action>` where action is `'add' | 'update' | 'delete'`. To get row data, call `table.get(id)`; the observer intentionally does not include row data to avoid unnecessary reconstruction.

```typescript
const unsubscribe = tables.posts.observe((changes, transaction) => {
	for (const [id, action] of changes) {
		if (action === 'delete') {
			console.log('Post deleted:', id);
			removeFromCache(id);
		} else {
			// Fetch row data only when needed
			const result = tables.posts.get(id);
			if (result.status === 'valid') {
				console.log(`Post ${action}:`, result.row);
				updateCache(id, result.row);
			}
		}
	}
});

// Stop watching
unsubscribe();
```

**How it works:**

- Changes are batched per Y.Transaction; bulk operations fire one callback
- The `transaction` object enables origin checks (local vs remote changes)
- `'add'`: Fires when a new row Y.Map is added to the table
- `'update'`: Fires when any field changes within an existing row
- `'delete'`: Fires when a row Y.Map is removed from the table

## Provider System

Providers are a unified map of capabilities. All workspace capabilities (persistence, sync, materializers like SQLite/markdown) are defined in a single `providers` map.

### SQLite Extension

The SQLite extension provides SQL query capabilities via Drizzle ORM.

**Setup:**

```typescript
import { createClient, sqliteProvider } from '@epicenter/hq';

const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		sqlite: (c) => sqliteProvider(c),
	});
```

**Storage:**

- Database: `.epicenter/providers/sqlite/{workspaceId}.db`
- Logs: `.epicenter/providers/sqlite/logs/{workspaceId}.log`

**Exports:**

```typescript
{
  pullToSqlite: Query,              // Sync YJS → SQLite (replace all)
  pushFromSqlite: Query,            // Sync SQLite → YJS (replace all)
  db: BetterSQLite3Database,       // Drizzle database instance
  posts: DrizzleTable,              // Each table as Drizzle table reference
  users: DrizzleTable,
  // ... all tables
}
```

**Usage:**

```typescript
const blogActions = {
	getPublishedPosts: defineQuery({
		handler: async () => {
			// Query with full Drizzle power via client.extensions
			const { sqlite } = client.extensions;
			return await sqlite.posts
				.select()
				.where(eq(sqlite.posts.published, true))
				.orderBy(desc(sqlite.posts.publishedAt))
				.limit(10);
		},
	}),

	getPostStats: defineQuery({
		handler: async () => {
			const { sqlite } = client.extensions;
			return await sqlite.posts
				.select({
					category: sqlite.posts.category,
					total: count(),
					avgViews: avg(sqlite.posts.views),
				})
				.groupBy(sqlite.posts.category);
		},
	}),

	// Manual sync operations
	syncToSqlite: defineMutation({
		handler: () => client.extensions.sqlite.pullToSqlite(),
	}),
};
```

**How it works:**

- Observes YJS changes and updates SQLite automatically
- Uses WAL mode for concurrent access
- Prevents infinite loops with sync coordination flags
- Logs validation errors without blocking sync
- Performs full initial sync on startup

### Markdown Extension

The markdown extension persists data as human-readable markdown files.

**Setup:**

```typescript
import { createClient, markdownProvider } from '@epicenter/hq';

const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		markdown: (c) =>
			markdownProvider(c, {
				directory: './data', // Optional: workspace-level directory
				tableConfigs: {
					posts: {
						directory: './posts', // Optional: per-table directory
						serialize: ({ row }) => ({
							frontmatter: { title: row.title, published: row.published },
							body: row.content,
							filename: `${row.id}.md`,
						}),
						deserialize: ({ frontmatter, body, filename }) => {
							const id = basename(filename, '.md');
							return Ok({ id, content: body, ...frontmatter });
						},
					},
				},
			}),
	});
```

**Storage:**

- Markdown files: `./{workspaceId}/{tableName}/*.md` (configurable)
- Logs: `.epicenter/providers/markdown/logs/{workspaceId}.log`
- Diagnostics: `.epicenter/providers/markdown/diagnostics/{workspaceId}.json`

**Exports:**

```typescript
{
  pullToMarkdown: Query,            // Sync YJS → Markdown files (replace all)
  pushFromMarkdown: Query,          // Sync Markdown files → YJS (replace all)
  scanForErrors: Query,             // Validate all files, rebuild diagnostics
}
```

**Usage:**

```typescript
const blogActions = {
	// Export markdown sync operations
	syncToMarkdown: defineMutation({
		handler: () => client.extensions.markdown.pullToMarkdown(),
	}),
	syncFromMarkdown: defineMutation({
		handler: () => client.extensions.markdown.pushFromMarkdown(),
	}),
	validateFiles: defineQuery({
		handler: () => client.extensions.markdown.scanForErrors(),
	}),
};
```

**How it works:**

- Watches markdown directories for file changes
- Syncs changes bidirectionally with YJS
- Maintains rowId ↔ filename mapping (handles renames/deletions)
- Validates all files on startup
- Tracks errors in diagnostics (JSON) and error log (append-only)
- Prevents infinite loops with sync coordination

**Default serialization:**

- Frontmatter: All columns except content
- Body: `content` column (if exists)
- Filename: `{id}.md`

**Custom serialization:**

```typescript
serialize: ({ row, table }) => {
  // Custom logic
  return {
    frontmatter: { /* YAML frontmatter */ },
    body: 'markdown body',
    filename: 'custom-name.md'
  };
},
deserialize: ({ frontmatter, body, filename, table }) => {
  // Custom parsing
  const row = { id: '...', ... };
  return Ok(row); // or Err(MarkdownProviderErr({ ... }))
}
```

### WebSocket Sync Extension

The WebSocket sync extension enables real-time Y.Doc synchronization using the y-websocket protocol. This is the recommended sync solution for Epicenter.

**Setup:**

```typescript
import { createClient } from '@epicenter/hq';
import { createWebsocketSyncProvider } from '@epicenter/hq/extensions/websocket-sync';

const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		sync: createWebsocketSyncProvider({
			url: 'ws://localhost:3913/sync',
		}),
	});
```

**Server-side sync endpoint:**

The Epicenter server includes a sync endpoint at `/sync/{workspaceId}`:

```typescript
// In server.ts, sync is automatically included
const { app, client } = await createServer(config);
app.listen(3913);

// Clients connect to: ws://localhost:3913/sync/blog
```

**How it works:**

1. Client opens WebSocket to `/sync/{workspaceId}`
2. Server sends initial sync state
3. Client and server exchange updates bidirectionally
4. Server broadcasts updates to all connected clients
5. All Y.Docs converge via Yjs CRDTs

**Key properties:**

- Server is authoritative: REST API always reflects current Y.Doc state
- Standard protocol: Compatible with any y-websocket client
- Built-in awareness: User presence/cursors work out of the box
- No native modules: Pure JS, works with Bun

### Multi-Device Sync Architecture

Epicenter supports a distributed sync architecture where Y.Doc instances can be replicated across multiple devices and servers.

**Define your sync nodes:**

```typescript
// src/config/sync-nodes.ts
export const SYNC_NODES = {
	// Local devices via Tailscale
	desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync',
	laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',

	// Cloud server (optional, always-on)
	cloud: 'wss://sync.myapp.com/sync',

	// Localhost (for browser connecting to local server)
	localhost: 'ws://localhost:3913/sync',
} as const;
```

**Provider strategy per device:**

| Device          | Role          | Connects To                  |
| --------------- | ------------- | ---------------------------- |
| Phone browser   | Client only   | `desktop`, `laptop`, `cloud` |
| Laptop browser  | Client        | `localhost`                  |
| Desktop browser | Client        | `localhost`                  |
| Laptop server   | Node + Client | `desktop`, `cloud`           |
| Desktop server  | Node + Client | `laptop`, `cloud`            |

**Multi-extension example (phone):**

```typescript
// Phone connects to ALL available sync nodes
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		syncDesktop: createWebsocketSyncProvider({ url: SYNC_NODES.desktop }),
		syncLaptop: createWebsocketSyncProvider({ url: SYNC_NODES.laptop }),
		syncCloud: createWebsocketSyncProvider({ url: SYNC_NODES.cloud }),
	});
```

**Server-to-server sync:**

```typescript
// Desktop server connects to OTHER servers (not itself!)
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({
		syncToLaptop: createWebsocketSyncProvider({ url: SYNC_NODES.laptop }),
		syncToCloud: createWebsocketSyncProvider({ url: SYNC_NODES.cloud }),
	});
```

Yjs supports multiple providers simultaneously. Changes merge automatically via CRDTs regardless of which provider delivers them first.

See [SYNC_ARCHITECTURE.md](./SYNC_ARCHITECTURE.md) for complete multi-device sync documentation.

## Workspace Dependencies

Workspaces can depend on other workspaces, enabling modular architecture. For cross-workspace communication, simply import the initialized client of the dependency.

**Access pattern (regular imports):**

```typescript
import { authClient } from './auth-client';
import { storageClient } from './storage-client';

// blog-actions.ts
export const createPost = defineMutation({
	input: type({ title: 'string', authorId: 'string' }),
	handler: async ({ title, authorId }) => {
		// Access dependency workspace actions via imported client
		const user = await authClient.getUserById({ id: authorId });
		if (!user) {
			return Err({ message: 'User not found' });
		}

		// Access dependency workspace tables
		const allUsers = authClient.tables.get('users').getAll();

		// Create post in local workspace
		const id = generateId();
		blogClient.tables.get('posts').upsert({
			id,
			title,
			authorId,
			published: false,
		});
		return Ok({ id });
	},
});
```

## Actions

Actions are workspace operations defined with `defineQuery` or `defineMutation`.

### Query Actions

Read operations with no side effects. Use HTTP GET when exposed via API/MCP.

**Variants:**

```typescript
// With input, returns Result<T, E>
defineQuery({
	input: type({ id: 'string' }),
	handler: ({ id }) => {
		const post = db.tables.get('posts').get({ id });
		if (!post) {
			return Err({ message: 'Not found' });
		}
		return Ok(post.data);
	},
});

// With input, returns T (can't fail)
defineQuery({
	input: type({ limit: 'number' }),
	handler: ({ limit }) => {
		return db.tables.get('posts').getAll().slice(0, limit);
	},
});

// No input, returns Result<T, E>
defineQuery({
	handler: () => {
		const result = someOperationThatCanFail();
		if (result.error) {
			return Err(result.error);
		}
		return Ok(result.data);
	},
});

// No input, returns T (can't fail)
defineQuery({
	handler: () => {
		return db.tables.get('posts').count();
	},
});
```

All variants support async handlers:

```typescript
defineQuery({
	input: type({ id: 'string' }),
	handler: async ({ id }) => {
		const data = await fetchExternal(id);
		return Ok(data);
	},
});
```

### Mutation Actions

Write operations that modify state. Use HTTP POST when exposed via API/MCP.

**Variants:** Same as queries (8 overloads: with/without input, sync/async, Result/raw).

```typescript
// With input, returns Result<T, E>
defineMutation({
	input: type({ title: 'string' }),
	handler: ({ title }) => {
		const id = generateId();
		db.tables.get('posts').upsert({
			id,
			title,
			published: false,
		});
		return Ok({ id });
	},
});

// With input, returns void (can't fail)
defineMutation({
	input: type({ id: 'string' }),
	handler: ({ id }) => {
		db.tables.get('posts').delete({ id });
	},
});
```

### Input Validation

Actions support Standard Schema validation (ArkType, Zod, Valibot, Effect):

```typescript
import { type } from 'arktype';
import { z } from 'zod';

// ArkType (recommended)
defineQuery({
  input: type({
    email: 'string.email',
    age: 'number>0',
  }),
  handler: (input) => { ... }
})

// Zod
defineQuery({
  input: z.object({
    email: z.string().email(),
    age: z.number().positive(),
  }),
  handler: (input) => { ... }
})
```

**JSON Schema Limitations:**

Input schemas are converted to JSON Schema for MCP/CLI/OpenAPI. Avoid:

- Transforms: `.pipe()` (ArkType), `.transform()` (Zod)
- Custom validation: `.filter()` (ArkType), `.refine()` (Zod)
- Non-JSON types: `bigint`, `symbol`, `undefined`, `Date`, `Map`, `Set`

Use basic types and `.matching(regex)` for patterns. For complex validation, validate in the handler.

### Action Properties

Actions have metadata properties:

```typescript
const action = defineQuery({ ... });

action.type         // 'query' | 'mutation'
action.input        // StandardSchemaV1 | undefined
action.description  // string | undefined
```

### Type Guards

```typescript
import { isAction, isQuery, isMutation } from '@epicenter/hq';

isAction(value); // value is Query | Mutation
isQuery(value); // value is Query
isMutation(value); // value is Mutation
```

## Providers

Providers are defined as a map and can attach capabilities to YJS documents. They run in parallel during workspace initialization.

**Type:**

```typescript
type Provider<TExports> = (
	context: ProviderContext,
) => TExports | void | Promise<TExports | void>;

type ProviderContext = {
	id: string; // Workspace ID
	providerId: string; // Provider key (e.g., 'sqlite', 'persistence')
	ydoc: Y.Doc; // YJS document
	schema: TSchema; // Workspace schema (table definitions)
	tables: Tables<TSchema>; // Access to workspace tables
	paths: ProviderPaths | undefined; // Filesystem paths (undefined in browser)
};

type ProviderPaths = {
	project: ProjectDir; // Project root for user content
	epicenter: EpicenterDir; // .epicenter directory
	provider: ProviderDir; // .epicenter/providers/{providerId}/
};
```

**Common providers:**

```typescript
import { setupPersistence } from '@epicenter/hq/providers';
import { sqliteProvider, markdownProvider } from '@epicenter/hq';
import { createWebsocketSyncProvider } from '@epicenter/hq/extensions/websocket-sync';

providers: {
  // Filesystem persistence (Node.js) or IndexedDB (browser)
  persistence: setupPersistence,

  // SQLite materializer
  sqlite: (c) => sqliteProvider(c),

  // Markdown materializer
  markdown: (c) => markdownProvider(c),

  // WebSocket sync provider (y-websocket protocol)
  sync: createWebsocketSyncProvider({
    url: 'ws://localhost:3913/sync',
  }),

  // Custom provider
  custom: ({ id, ydoc, paths }) => {
    console.log(`Setting up workspace: ${id}`);
    // Attach custom capabilities
  },
}
```

**Execution:**

Providers run in parallel during initialization. Providers that return exports make those exports available in the `providers` object passed to handlers.

### Create Client

Create a workspace client using the builder pattern:

```typescript
// Create a client with extensions
const blogClient = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite: sqliteProvider });

// Direct table access
const posts = blogClient.tables.get('posts').getAllValid();

// Cleanup when done
await blogClient.destroy();

// Or use with `await using` for automatic cleanup
{
	await using client = createClient(blogWorkspace.id)
		.withDefinition(blogWorkspace)
		.withExtensions({ sqlite: sqliteProvider });

	client.tables.get('posts').upsert({ id: '1', title: 'Hello' });
}
```

**projectDir**: Defaults to `process.cwd()` in Node.js, `undefined` in browser.

## Architecture & Lifecycle

### Client Initialization Lifecycle

When you call `.withExtensions()`, here's what happens:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CREATE Y.Doc (CRDT data structure)                       │
│    • Unique document ID = workspace ID                      │
│    • In-memory collaborative data structure                 │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. INITIALIZE TABLES                                        │
│    • Create YJS-backed table operations                     │
│    • Set up runtime validators from schema                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. INITIALIZE PROVIDERS                                     │
│    • Run provider factories (SQLite, markdown, etc.)        │
│    • Providers receive YDoc, tables, paths, validators      │
│    • Loads existing state, starts auto-sync                 │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. BIND ACTION HANDLERS                                     │
│    • Connect handlers to contracts                          │
│    • Inject handler context (tables, providers, etc.)       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. RETURN BOUND CLIENT                                      │
│    • client.id - workspace ID                               │
│    • client.tables - YJS table operations                   │
│    • client.actions - bound action methods                  │
│    • client.contracts - action schemas (for introspection)  │
│    • client.destroy() - cleanup resources                   │
└─────────────────────────────────────────────────────────────┘
```

### Storage Context

Each client instance writes to a **storage context** determined by:

- **Directory**: Where the script runs (affects `.epicenter/` path)
- **Environment**: Browser (IndexedDB) vs Node (filesystem)
- **Workspace ID**: The specific workspace being accessed

```
Storage Context = Directory + Environment + Workspace ID

Examples:
  /project-a + Node + pages → /project-a/.epicenter/providers/persistence/pages.yjs
  /project-b + Node + pages → /project-b/.epicenter/providers/persistence/pages.yjs (different!)
  Browser + pages → IndexedDB:pages (different!)
```

### `.epicenter/` Folder Structure

The `.epicenter` folder contains all internal data, organized by provider:

```
.epicenter/
└── providers/                        # GITIGNORED
    ├── persistence/                  # YJS persistence provider
    │   ├── blog.yjs
    │   └── auth.yjs
    ├── sqlite/                       # SQLite provider
    │   ├── blog.db
    │   ├── auth.db
    │   └── logs/
    │       ├── blog.log
    │       └── auth.log
    ├── markdown/                     # Markdown provider
    │   ├── logs/
    │   │   └── blog.log
    │   └── diagnostics/
    │       └── blog.json
    └── gmailAuth/                    # Custom auth provider example
        └── token.json
```

**Key design decisions:**

- Each provider gets isolated storage at `.epicenter/providers/{providerId}/`
- Provider artifacts are gitignored (add `.epicenter/providers/` to `.gitignore`)
- Simple naming within providers: `{workspaceId}.{ext}` for data, `logs/{workspaceId}.log` for logs
- **Rule**: Only one client can access the same storage context at a time.

### Cleanup Lifecycle

When you dispose a client (automatically with `await using` or manually with `await client.destroy()`):

```
┌─────────────────────────────────────────────────────────────┐
│ destroy() or Symbol.asyncDispose Called                      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ For Each Workspace:                                          │
│                                                              │
│    1. Destroy Providers                                      │
│       • Close SQLite connections                             │
│       • Unsubscribe observers                                │
│       • Disconnect persistence                               │
│                                                              │
│    2. Destroy Y.Doc                                          │
│       • Clean up observers                                   │
│       • Free memory                                          │
└─────────────────────────────────────────────────────────────┘
```

## Client vs Server

Epicenter can be used in two primary ways:

### 1. As a Client (Scripts, Migrations, CLI Tools)

Create a client directly for standalone scripts. Use `await using` for automatic cleanup:

```typescript
// Script or migration
{
	await using client = createClient(blogWorkspace.id)
		.withDefinition(blogWorkspace)
		.withExtensions({ sqlite: sqliteProvider });

	client.tables.get('posts').upsert({ id: '1', title: 'Hello' });
	// Automatic cleanup when block exits
}
```

**Important**: When running scripts, **ensure no server is running** in the same directory. Multiple clients accessing the same storage context simultaneously will conflict.

### 2. As a Server (Web APIs, Long-Running Processes)

The server is a wrapper around the client that maps REST, MCP, and WebSocket Sync endpoints to workspace actions and tables.

```typescript
import { createClient, createServer } from '@epicenter/hq';

const client = createClient(blogWorkspace.id)
  .withDefinition(blogWorkspace)
  .withExtensions({ sqlite: sqliteProvider });

// Expose the client and custom actions via HTTP
const server = createServer(client, {
  port: 3913,
  actions: blogActions
});

server.start();

// Other processes can now use the HTTP API
await fetch('http://localhost:3913/actions/createPost', {
  method: 'POST',
  body: JSON.stringify({ title: 'New Post', ... }),
});
```

## API Reference

### Workspace Definition

```typescript
import { defineWorkspace, defineMutation, defineQuery } from '@epicenter/hq';
```

**`defineWorkspace({ id, tables, kv })`**

Define a workspace contract with tables and key-value store.

```typescript
const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: {
			name: 'Posts',
			fields: { id: id(), title: text() },
		},
	},
	kv: {},
});
```

### Client Creation

```typescript
// Create client with extensions
const client = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite: sqliteProvider });

// Use tables directly
const id = generateId();
client.tables.get('posts').upsert({ id, title: 'Hello' });
```

### Client Properties

```typescript
client.id; // Workspace ID ('blog')
client.tables; // YJS-backed table operations
client.kv; // Key-value store
client.extensions; // Extension exports
client.ydoc; // Underlying Y.Doc
client.whenSynced; // Promise for async initialization

await client.destroy(); // Cleanup resources
```

### Column Schemas

```typescript
import {
	id,
	text,
	ytext,
	integer,
	real,
	boolean,
	date,
	select,
	tags,
	json,
	type ColumnSchema,
	type TableSchema,
	type WorkspaceSchema,
} from '@epicenter/hq';
```

**Column factory functions:**

- `id()`: Auto-generated ID
- `text(options?)`: Text column
- `ytext(options?)`: Collaborative text (Y.Text)
- `integer(options?)`, `real(options?)`: Numeric columns
- `boolean(options?)`: Boolean column
- `date(options?)`: Date with timezone
- `select<TOptions>(options)`: Single choice enum
- `tags<TOptions>(options?)`: String array
- `json<TSchema>(options)`: JSON with arktype validation

**Common options:**

- `nullable?: boolean` (default: `false`)
- `default?: T | (() => T)`

### Actions

```typescript
import {
	defineQuery,
	defineMutation,
	isAction,
	isQuery,
	isMutation,
	defineActions,
	type Query,
	type Mutation,
	type Action,
	type Actions,
} from '@epicenter/hq';
```

**`defineQuery(config)`**

Define a query action (read operation).

**`defineMutation(config)`**

Define a mutation action (write operation).

**Type guards:**

- `isAction(value)`: Check if value is Query or Mutation
- `isQuery(value)`: Check if value is Query
- `isMutation(value)`: Check if value is Mutation

**`defineActions<T>(exports)`**

Identity function for type inference.

### Table Operations

```typescript
import { type Tables, type TableHelper } from '@epicenter/hq';
```

**`TableHelper<TSchema>`** methods:

- `upsert(row)`, `upsertMany(rows)`: Create or replace entire row (never fails)
- `update(partial)`, `updateMany(partials)`: Merge fields into existing row (no-op if not found)
- `get({ id })`, `getAll()`, `getAllInvalid()`
- `has({ id })`, `count()`
- `delete({ id })`, `deleteMany({ ids })`, `clear()`
- `filter(predicate)`, `find(predicate)`
- `observe(callback)`: Watch for changes (receives `Map<id, 'add'|'update'|'delete'>`)

### Providers

```typescript
import { sqliteProvider } from '@epicenter/hq';
import { markdownProvider, type MarkdownProviderConfig } from '@epicenter/hq';
import {
	type Provider,
	type ProviderContext,
	type Providers,
	type WorkspaceProviderMap,
} from '@epicenter/hq';
```

**`sqliteProvider(context)`**

Create SQLite provider with Drizzle ORM.

**`markdownProvider(context, config?)`**

Create markdown file provider.

### Persistence Provider

```typescript
import { setupPersistence } from '@epicenter/hq/providers';
```

**`setupPersistence`**

Built-in persistence provider (IndexedDB in browser, filesystem in Node.js).

### Date Utilities

```typescript
import {
	DateTimeString,
	type DateIsoString,
	type TimezoneId,
} from '@epicenter/hq';
```

**`DateTimeString.now(timezone?)`**

Create a DateTimeString for the current moment. Uses system timezone if not specified.

**`DateTimeString.parse(str)`**

Parse storage string to `Temporal.ZonedDateTime` for date math and manipulation.

**`DateTimeString.stringify(dt)`**

Convert `Temporal.ZonedDateTime` back to storage format.

**`DateTimeString.is(value)`**

Type guard to check if a value is a valid DateTimeString.

### Validation

```typescript
import {
	createTableValidators,
	createWorkspaceValidators,
	type TableValidators,
	type WorkspaceValidators,
} from '@epicenter/hq';
```

**`createTableValidators<TSchema>(schema)`**

Create validators for a table schema.

**`createWorkspaceValidators<TSchema>(schema)`**

Create validators for all tables in a workspace.

### Error Types

```typescript
import {
	EpicenterOperationErr,
	IndexErr,
	ValidationErr,
	type EpicenterOperationError,
	type IndexError,
	type ValidationError,
} from '@epicenter/hq';
```

**Error constructors:**

- `EpicenterOperationErr({ message, context, cause })`: General operation errors
- `IndexErr({ message, context, cause })`: Index sync errors
- `ValidationErr({ message, context, cause })`: Schema validation errors

### Drizzle Re-exports

```typescript
import {
	eq,
	ne,
	gt,
	gte,
	lt,
	lte,
	and,
	or,
	not,
	like,
	inArray,
	isNull,
	isNotNull,
	sql,
	desc,
	asc,
} from '@epicenter/hq';
```

Commonly used Drizzle operators for querying SQLite provider.

### Server

```typescript
import { createServer } from '@epicenter/hq';

// Single workspace
const server = createServer(blogClient, { port: 3913 });

// Multiple workspaces (IDs from workspace definitions)
const server = createServer([blogClient, authClient], { port: 3913 });

server.start();
```

**`createServer(client | clients, options?)`**

Create an HTTP server from workspace clients. Exposes:

- REST endpoints for actions: `/workspaces/{id}/actions/{action}`
- Table CRUD: `/workspaces/{id}/tables/{table}`
- WebSocket sync: `/workspaces/{id}/sync`
- OpenAPI documentation: `/openapi`

## MCP Integration

Epicenter workspaces can be exposed as MCP (Model Context Protocol) servers for AI assistant integration.

### HTTP Transport Only

Epicenter uses HTTP transport exclusively, not stdio. This is intentional:

**Why not stdio?**

stdio spawns a new process per AI session, which creates problems:

- Expensive cold starts (initialize YJS, build providers, parse files)
- File system conflicts (multiple watchers, SQLite locks)
- No shared state (wasted memory, duplicate work)

**Why HTTP?**

A long-running HTTP server models Epicenter's folder-based architecture:

- Initialize once, serve many sessions
- Share state across all AI assistants
- Handle file watching without conflicts
- Efficient resource usage

### Route Handling

Workspace actions are exposed via REST endpoints under the `/workspaces` prefix:

**Query Actions** (HTTP GET):

- Path: `/workspaces/{workspaceId}/{actionName}`
- Input: Query string parameters

**Mutation Actions** (HTTP POST):

- Path: `/workspaces/{workspaceId}/{actionName}`
- Input: JSON request body

**URL Hierarchy:**

```
/                                    - API root/discovery
/openapi                             - OpenAPI spec (JSON)
/scalar                              - Scalar UI documentation
/mcp                                 - MCP endpoint
/signaling                           - WebRTC signaling WebSocket
/workspaces/{workspaceId}/{action}   - Workspace actions
```

### Setup

```typescript
import { createClient, createServer } from '@epicenter/hq';

// Create clients with extensions
const blogClient = createClient(blogWorkspace.id)
	.withDefinition(blogWorkspace)
	.withExtensions({ sqlite: sqliteProvider });

const authClient = createClient(authWorkspace.id)
	.withDefinition(authWorkspace)
	.withExtensions({ sqlite: sqliteProvider });

// Create and start server
const server = createServer([blogClient, authClient], { port: 3913 });
server.start();
console.log('Server running on http://localhost:3913');
```

AI assistants connect via HTTP, with no cold start penalty.

## Contributing

### Local Development

If you're working on the Epicenter package, test it locally using `bun link`:

```bash
# Install dependencies (from repository root)
bun install

# One-time setup: Link the package globally
cd packages/epicenter
bun link

# Now use from any directory
cd examples/content-hub
epicenter --help
epicenter blog createPost --title "Test"

# When done testing
cd packages/epicenter
bun unlink
```

**Alternative:** Use local `cli.ts` in examples:

```bash
cd examples/content-hub
bun cli.ts --help
bun cli.ts blog createPost --title "Test"
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific workspace tests
cd examples/content-hub
bun test
```

### More Information

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for complete development setup and guidelines.

## License

AGPL-3.0
