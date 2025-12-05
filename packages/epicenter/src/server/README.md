# Epicenter Server

Expose your Epicenter workspaces as REST APIs and AI-accessible tools.

## What This Does

`createServer()` is a thin wrapper around `createEpicenterClient()` that:

1. **Creates an Epicenter client** (same initialization as scripts)
2. **Keeps it alive** (doesn't dispose until you stop the server)
3. **Maps HTTP endpoints** to each client action (REST, MCP, Hocuspocus)

The key difference from running scripts:

- **Scripts**: Client is alive only during the `using` block, then auto-disposed
- **Server**: Client stays alive until you manually stop the server (Ctrl+C)

This means:

- Y.Doc stays in memory
- Observers keep watching for changes
- Indexes keep syncing
- Actions remain callable via HTTP

## Server vs Scripts: When to Use Each

### Use Scripts (Direct Client)

```typescript
// Migration script
{
  await using client = await createEpicenterClient(config);
  await client.pages.createPage({ ... });
  // Client disposed when block exits
}
```

**Good for:**

- One-off migrations
- Data imports/exports
- CLI tools
- Batch processing

**Requirements:**

- Server must NOT be running in the same directory
- Script has exclusive access to `.epicenter/` storage

### Use Server (HTTP Wrapper)

```typescript
// Long-running server
const { app, client } = await createServer(config);
Bun.serve({ fetch: app.fetch, port: 3913 });
// Client stays alive until Ctrl+C
```

**Good for:**

- Web applications
- API backends
- Real-time collaboration (Hocuspocus)
- Multiple concurrent clients (via HTTP)

**Benefits:**

- Other processes can use HTTP API instead of direct client
- Client stays alive and keeps indexes synced
- No risk of storage conflicts (only server accesses `.epicenter/`)

### Running Scripts While Server is Active

If you need to run scripts while the server is running, use the HTTP API instead of creating another client:

```typescript
// ❌ DON'T: Create another client (storage conflict!)
{
  await using client = await createEpicenterClient(config);
  await client.pages.createPage({ ... });
}

// ✅ DO: Use the server's HTTP API
await fetch('http://localhost:3913/pages/createPage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'New Post', content: '...' }),
});
```

The HTTP approach:

- No storage conflicts (server owns the client)
- Works from any language/tool (just HTTP)
- Server handles all concurrency internally

## Quick Start

### Single Workspace Server

```typescript
import { defineWorkspace, createWorkspaceServer } from '@epicenter/hq';

const blogWorkspace = defineWorkspace({
	id: 'blog',
	name: 'blog',
	schema: {
		/* your schema */
	},
	indexes: {
		/* your indexes */
	},
	exports: ({ db, indexes }) => ({
		createPost: defineMutation({
			input: Type.Object({ title: Type.String() }),
			handler: async ({ title }) => {
				// Your logic here
				return Ok(post);
			},
		}),
		getAllPosts: defineQuery({
			handler: async () => {
				return Ok(posts);
			},
		}),
	}),
});

// Create the server
const app = await createWorkspaceServer(blogWorkspace);

// Start it with Bun
Bun.serve({
	fetch: app.fetch,
	port: 3913,
});
```

Now your actions are available as HTTP endpoints:

- `GET http://localhost:3913/getAllPosts`
- `POST http://localhost:3913/createPost` with JSON body `{ "title": "My Post" }`

### Multiple Workspaces (Epicenter)

```typescript
import { defineEpicenter, createHttpServer } from '@epicenter/hq';

const epicenter = defineEpicenter({
	id: 'my-app',
	workspaces: [blogWorkspace, authWorkspace, storageWorkspace],
});

const app = await createHttpServer(epicenter);

Bun.serve({
	fetch: app.fetch,
	port: 3913,
});
```

Actions from each workspace get their own namespace:

- `GET http://localhost:3913/blog/getAllPosts`
- `POST http://localhost:3913/auth/login`
- `GET http://localhost:3913/storage/listFiles`

## How It Works

When you create a server, it:

1. **Initializes your workspace(s)** using the same logic as client-side initialization
2. **Discovers all actions** by inspecting the workspace client methods
3. **Creates HTTP routes** for each action (both GET and POST for flexibility)
4. **Exposes MCP endpoints** so AI models can discover and call your actions

## REST API Format

### Request

For actions with input:

- **GET**: Pass parameters as query strings: `?title=Hello&category=tech`
- **POST**: Send JSON body: `{ "title": "Hello", "category": "tech" }`

For actions without input:

- Just call the endpoint

### Response

**Success:**

```json
{
	"data": {
		/* your action's return value */
	}
}
```

**Error:**

```json
{
	"error": {
		"message": "What went wrong"
	}
}
```

HTTP status codes map to error types:

- `400` - Validation errors, invalid input
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not found
- `409` - Conflicts
- `500` - Server errors

## Model Context Protocol (MCP)

Every server automatically exposes MCP endpoints for AI integration:

**List available tools:**

```bash
POST http://localhost:3913/mcp/tools/list
```

**Call a tool:**

```bash
POST http://localhost:3913/mcp/tools/call
Content-Type: application/json

{
  "name": "createPost",
  "arguments": { "title": "AI-generated post" }
}
```

For Epicenter servers, tool names include the workspace: `blog_createPost`, `auth_login`, etc.

This lets AI models like Claude discover your actions and call them automatically when helping users.

## Real-World Example

```typescript
// Define your workspaces (same as client-side)
const notesWorkspace = defineWorkspace({
	id: 'notes',
	name: 'notes',
	schema: {
		notes: {
			id: id(),
			title: text(),
			content: text(),
			tags: tags({ options: ['work', 'personal', 'ideas'] }),
		},
	},
	indexes: {
		sqlite: (c) => sqliteIndex(c),
	},
	exports: ({ db, indexes }) => ({
		createNote: defineMutation({
			input: Type.Object({
				title: Type.String(),
				content: Type.String(),
				tags: Type.Optional(Type.Array(Type.String())),
			}),
			handler: async (input) => {
				const note = { id: generateId(), ...input };
				db.tables.notes.insert(note);
				return Ok(note);
			},
		}),
		searchNotes: defineQuery({
			input: Type.Object({ query: Type.String() }),
			handler: async ({ query }) => {
				const results = await indexes.sqlite.db
					.select()
					.from(indexes.sqlite.notes)
					.where(like(indexes.sqlite.notes.title, `%${query}%`))
					.all();
				return Ok(results);
			},
		}),
	}),
});

// Expose as server
const app = await createWorkspaceServer(notesWorkspace);

Bun.serve({
	fetch: app.fetch,
	port: 8080,
	development: process.env.NODE_ENV === 'development',
});

console.log('Notes API running at http://localhost:8080');
```

Now you have a fully functional notes API:

- `POST /createNote` - Create notes
- `GET /searchNotes?query=important` - Search notes
- `POST /mcp/tools/call` - Let AI create/search notes

## When to Use This

**Good for:**

- Creating HTTP APIs from your workspace logic
- Enabling AI assistants to interact with your data
- Building backend services for web/mobile apps
- Exposing workspace functionality to external systems

**Not needed if:**

- You're building a local-only desktop app (just use `createWorkspaceClient`)
- Your app doesn't need HTTP access
- You want to keep everything client-side

## Configuration

Both functions accept an optional `RuntimeConfig` parameter (same as workspace clients):

```typescript
const app = await createHttpServer(epicenter, {
	// Future: persistence options, sync providers, etc.
});
```

The returned Hono app gives you full control:

```typescript
// Add middleware
app.use('*', logger());
app.use('/admin/*', authMiddleware);

// Add custom routes
app.get('/health', (c) => c.text('OK'));

// Configure Bun.serve however you want
Bun.serve({
	fetch: app.fetch,
	port: process.env.PORT ?? 3913,
	hostname: '0.0.0.0',
	development: true,
});
```

## What's Next

This is a v1 implementation focused on simplicity. Future enhancements might include:

- Input validation middleware using action schemas
- Action descriptions in MCP tool definitions
- Separate GET/POST routing based on query vs mutation types
- WebSocket support for real-time YJS sync

The foundation is solid and extensible.
