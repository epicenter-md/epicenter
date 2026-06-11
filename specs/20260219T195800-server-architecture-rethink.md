# Server Architecture Rethink: Sync-First, Schema-Derived

**Date**: 2026-02-19
**Status**: Draft: Vision (Layers 0+1 implemented by `specs/20260220T080000-plugin-first-server-architecture.md`)
**Author**: Braden + Claude

## Overview

`epicenter serve` should boot as a sync relay first and derive everything else from discovered workspace schemas. The server's API surface isn't configured. It's computed from contracts on the filesystem. No contracts found? You still get a working sync server.

## Motivation

### Current State

Today, `epicenter serve` requires a fully initialized `WorkspaceClient` from `epicenter.config.ts`. The CLI imports the config, which executes user code (creates Yjs docs, initializes extensions, attaches actions), and hands the live client to `createServer()`. The server wraps it with Elysia routes.

```typescript
// epicenter.config.ts: must exist, must export a live client
export default createWorkspace({ id: 'blog', tables: { ... } })
  .withExtension('persistence', setupPersistence)
  .withActions((client) => ({ ... }));
```

```typescript
// cli.ts: the serve command
const { createServer } = await import('@epicenter/server');
createServer(client, { port: argv.port }).start();
```

This creates three problems:

1. **No config, no server.** If you just want a sync relay between devices, you still need to write a `epicenter.config.ts`. A user with a Mac Mini and a laptop shouldn't need to define table schemas to sync Yjs docs.

2. **All-or-nothing initialization.** The server can't start until the full client is alive: Yjs doc loaded, extensions initialized, actions attached. If persistence fails or SQLite can't open, the entire server crashes. You can't even sync.

3. **Static discovery is impossible.** To list available actions for OpenAPI or MCP, you have to execute the config file. There's no way to read action metadata (descriptions, input schemas) without instantiating the entire workspace runtime.

### Desired State

`epicenter serve` boots instantly as a sync relay. If there are workspace contracts in the filesystem, the server auto-discovers them and derives REST routes, action endpoints, and MCP tools from the static metadata. The live Yjs runtime starts lazily per-workspace, on first data access.

## The Five Architectural Approaches

### Approach A: Staged Kernel

The server boots in stages like an OS kernel. Each stage is independently functional:

```
Stage 0: HTTP + WS listener (always starts, ~50ms)
  ↓
Stage 1: Filesystem scan for contracts (~100ms)
  ↓
Stage 2: Sync rooms created per workspace
  ↓
Stage 3: REST/action routes mounted from metadata
  ↓
Stage 4: Optional modules (MCP, admin UI)
```

Stage 0+2 alone gives you a working sync relay. Stage 3 adds REST. Stage 4 adds extras. A crash in Stage 3 doesn't kill Stage 2.

**Strength**: Clear layering, each stage testable in isolation.
**Weakness**: Stages imply linear boot: what if you want to add a workspace after boot?

### Approach B: Reactive Discovery

The server starts as a bare sync relay. No routes, no contracts. It lazily discovers workspaces when:

- A WebSocket connection arrives for `/workspaces/{id}/sync` → creates room on-demand
- A contract file appears in a watched directory → hot-mounts routes
- The REST API is hit for an unknown workspace → checks if a contract exists

**Strength**: Zero config, works immediately, handles dynamic workspaces.
**Weakness**: First request to a new workspace has cold-start latency. Unknown workspace IDs in sync requests could be typos or DoS vectors.

### Approach C: Contract-as-Server (Declarative Surface)

Contracts define not just data shape but the entire server surface area:

```typescript
export default defineWorkspace({
  id: 'blog',
  tables: { ... },
  server: {
    actions: { ... },
    webhooks: { 'github.push': defineWebhook({ ... }) },
    cron: { 'cleanup': defineCron({ schedule: '0 0 * * *', handler: ... }) },
    on: { 'posts.created': defineHandler({ handler: ... }) },
  },
});
```

**Strength**: Single source of truth. The contract IS the server definition.
**Weakness**: Mixes static metadata with runtime handlers. Contracts should be cheap to parse: adding handlers defeats that. Also, the current action system already handles this via `.withActions()`.

### Approach D: Actor per Workspace

Each workspace is an isolated actor (like Cloudflare Durable Objects or Erlang processes). The server is just a router that dispatches to the right actor:

```
Server (router on :3913)
  ├── /workspaces/blog  → BlogActor { ydoc, room, actions, state }
  ├── /workspaces/auth  → AuthActor { ydoc, room, actions, state }
  └── /workspaces/crm   → CRMActor  { ydoc, room, actions, state }
```

Each actor manages its own Yjs doc lifecycle, sync room, and action handlers. Actors can be suspended when idle, resumed on request.

**Strength**: Clean isolation, testable, matches Durable Objects model you already designed for cloud.
**Weakness**: Actor supervision adds complexity. In practice, most self-hosted deployments have 1-3 workspaces: the overhead might not pay off.

### Approach E: Filesystem-as-API

The server's API is entirely derived from the filesystem:

```
workspaces/
  blog/
    contract.ts  → REST routes for tables
    data.yjs     → sync room source
    actions/
      publish.ts → POST /blog/actions/publish
      get-all.ts → GET /blog/actions/get-all
  auth/
    contract.ts
    data.yjs
```

**Strength**: Dead simple mental model. "Add a file, get an endpoint." Like Next.js for data APIs.
**Weakness**: Doesn't fit Epicenter's existing config pattern. Fragmenting actions into individual files loses the cohesion of `.withActions()`. Also requires convention-heavy file naming.

## Recommended Architecture: A + B + D (Staged Kernel with Reactive Actors)

The strongest design takes the staged kernel boot from A, the reactive discovery from B, and the workspace-as-actor isolation from D:

### The Mental Model

The server is a thin router sitting on top of a room manager. Each workspace is a room. An actor that owns a Yjs doc and can optionally have REST routes and actions derived from its contract.

```
┌──────────────────────────────────────────────────────────────┐
│  epicenter serve                                              │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Layer 0: Transport (always on)                           │ │
│  │  • HTTP listener on :3913                                │ │
│  │  • WebSocket upgrade handler                             │ │
│  │  • Health + discovery endpoint (GET /)                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Layer 1: Room Manager (sync relay)                       │ │
│  │  • Accepts any WS connection to /workspaces/{id}/sync    │ │
│  │  • Creates room on first connection per workspace ID     │ │
│  │  • y-websocket protocol, awareness, keepalive            │ │
│  │  • Evicts idle rooms after timeout                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Layer 2: Schema Registry (optional, from filesystem)     │ │
│  │  • Scans for epicenter.config.ts / contract files        │ │
│  │  • Extracts static metadata: tables, KV, action schemas  │ │
│  │  • Watches filesystem for changes (hot reload)           │ │
│  │  • Does NOT execute user code for introspection          │ │
│  └─────────────────────────────────────────────────────────┘ │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Layer 3: API Surface (derived from registry)             │ │
│  │  • REST CRUD routes for each registered table            │ │
│  │  • Action endpoints from registered actions              │ │
│  │  • OpenAPI documentation (generated from metadata)       │ │
│  │  • MCP tool definitions (generated from metadata)        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Layer 4: Runtime (lazy, per-workspace)                   │ │
│  │  • Full WorkspaceClient initialized on first data write  │ │
│  │  • Extensions loaded (persistence, SQLite, markdown)     │ │
│  │  • Action handlers bound to live client                  │ │
│  │  • Can be suspended/evicted when idle                    │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### How Each Layer Works

**Layer 0 (Transport)** starts immediately. No config required. The server is listening within 50ms. It responds to health checks and discovery requests.

**Layer 1 (Room Manager)** is the core sync relay. Any WebSocket connection to `/workspaces/{id}/sync` is accepted. A Yjs room is created on-demand for that workspace ID. If no room exists, one is created with a fresh `Y.Doc`. If a room already exists (from Layer 4 loading a persisted doc), connections join it. This layer is the "sampling server" you mentioned: it's always on, always accepting connections.

**Layer 2 (Schema Registry)** scans the filesystem at boot. It reads `epicenter.config.ts` files and contract definitions, extracting only the static metadata: workspace ID, table names, field schemas, KV definitions, and action metadata (descriptions, input schemas). Crucially, it does NOT instantiate the Yjs runtime. It reads the contract, not the data. If no configs exist, this layer does nothing: Layer 1 still works.

**Layer 3 (API Surface)** is computed from the registry. For each registered workspace, it generates REST routes for tables, action endpoints, and documentation. These routes are "schema-aware": they know what fields exist, can validate input against the schema, and can generate OpenAPI specs. But they don't need a live Yjs doc to exist.

**Layer 4 (Runtime)** is where the actual Yjs docs, extensions, and action handlers live. It's lazy: a workspace's runtime is only initialized when someone actually needs to read or write data. A REST `GET /workspaces/blog/tables/posts` request triggers Layer 4 to initialize the blog workspace. Once initialized, it stays alive until idle eviction.

### The Key Insight: Two Kinds of Contract Reading

The fundamental tension you identified: static introspection vs runtime behavior: resolves by splitting contract parsing into two modes:

**Mode 1: Metadata extraction (cheap, synchronous, no side effects)**

Read the contract file, extract:

- Workspace ID
- Table names and field schemas
- KV key names and types
- Action descriptions, input/output schemas (from `defineQuery`/`defineMutation` metadata)

This doesn't need a Yjs doc, doesn't need persistence, doesn't need SQLite. It's just reading the schema declarations.

**Mode 2: Runtime instantiation (expensive, async, has side effects)**

Actually create the `WorkspaceClient`:

- Initialize Yjs doc
- Load persistence (disk, IndexedDB)
- Start extensions (SQLite, markdown)
- Bind action handlers with live client context

This is what the current `epicenter serve` does at boot. In the new architecture, it happens lazily per-workspace.

### Static Contract Discovery

For the server to read action metadata without executing handlers, we need to separate the contract from the runtime. Two approaches:

**Option A: Sidecar metadata files** (like how `package.json` describes a module without running it)

The contract file produces a static `.epicenter-manifest.json` at build time:

```json
{
	"id": "blog",
	"tables": {
		"posts": {
			"fields": { "id": "id", "title": "text", "content": "text" }
		}
	},
	"actions": {
		"publish": {
			"type": "mutation",
			"description": "Publish a post",
			"input": {
				"type": "object",
				"properties": { "id": { "type": "string" } }
			}
		}
	}
}
```

**Option B: Two-phase import** (import the module, read only metadata properties)

The contract file's `defineQuery`/`defineMutation` already create objects with `.type`, `.description`, `.input` as plain data. The handler is a function on the object but doesn't need to be called. The server can import the config, read `client.actions` metadata, and build routes without ever calling a handler. The Yjs doc exists but is empty until data arrives.

Option B is simpler and matches the existing codebase. The contract file is already a module that exports a client with static metadata on actions. The server just needs to be smarter about what it reads eagerly vs lazily.

### Sync Room Resolution

Rooms are resolved from three sources, merged:

1. **Registry**: Any workspace discovered by Layer 2 gets a pre-configured room with its Yjs doc loaded from persistence
2. **On-demand**: Any WebSocket connection to an unknown workspace ID creates an ephemeral room with a fresh doc (useful for ad-hoc sync between devices)
3. **Static config**: An optional server config can list known workspace IDs that should always have rooms, even without a contract file

```typescript
// Optional: epicenter.server.ts (or inline in epicenter.config.ts)
export default defineServer({
	port: 3913,
	auth: { secret: 'my-token' },
	rooms: ['blog', 'auth', 'shared-notes'], // pre-create these rooms
});
```

### The "Sampling" Analog

In MCP, sampling means the server requests the client to perform LLM work. The analog for Epicenter is the server requesting connected clients to perform workspace operations:

**Server → Client commands** (via a custom WebSocket message type):

- `MIGRATE`: "Your schema is outdated, run migration"
- `REINDEX`: "Rebuild your local SQLite from the Yjs doc"
- `COMPACT`: "Run Yjs garbage collection"
- `INVALIDATE`: "Discard your local cache, re-sync from server"

These would use a new message type in the y-websocket protocol extension, similar to how `MESSAGE_SYNC_STATUS (102)` already extends the protocol. The client's sync provider would handle these commands.

This is genuinely novel: most CRDT sync servers are passive relays. A server that can request clients to perform maintenance operations is closer to how database clusters work (leader sends replication commands to followers).

### What This Resolves

| Tension              | Resolution                                             |
| -------------------- | ------------------------------------------------------ |
| No config, no server | Layer 0+1 works with zero config                       |
| Static introspection | Layer 2 reads metadata without executing handlers      |
| Runtime behavior     | Layer 4 initializes lazily per-workspace               |
| Sync room management | Rooms created reactively from connections + registry   |
| Multiple workspaces  | Each workspace is a room; router dispatches            |
| Hot reload           | Layer 2 watches filesystem, Layer 3 regenerates routes |

## Design Decisions

| Decision                              | Choice                                                             | Rationale                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Sync relay as base layer              | Always-on, no config required                                      | The most common use case (personal sync between devices) shouldn't require schema definitions |
| Lazy workspace initialization         | On first data access, not at boot                                  | Faster startup, failures isolated per-workspace, idle workspaces don't consume memory         |
| Metadata extraction via module import | Import config, read `.type`/`.description`/`.input`, skip handlers | Reuses existing action objects; no build step or sidecar files needed                         |
| Room creation strategy                | Registered rooms from contracts + on-demand from connections       | Covers both "known workspaces" and "ad-hoc sync" use cases                                    |
| Server-to-client commands             | Custom WS message types                                            | Enables migration, compaction, and reindexing without manual intervention                     |
| Actor model for workspaces            | Lightweight actors, not OS processes                               | Isolation and eviction without the overhead of process management                             |

## Open Questions

1. **Should on-demand rooms (from unknown workspace IDs) be allowed by default?**
   - Options: (a) Allow all, (b) Only registered workspaces, (c) Configurable
   - **Recommendation**: Default to allow-all in open auth mode, restrict to registered in token/JWT auth mode. Reasoning: open mode is trusted-network, so ad-hoc is fine. Auth mode means you're exposed to the internet, so lock it down.

2. **How should the server discover contracts in subdirectories?**
   - Options: (a) Scan `**/epicenter.config.ts`, (b) Only current dir, (c) Use a manifest listing workspace paths
   - **Recommendation**: Current dir by default (matching CLI behavior), with a `--scan` flag for recursive discovery. A root-level `epicenter.server.ts` can explicitly list workspace paths.

3. **Should the server support JSON-only contracts (no TypeScript)?**
   - This matters for AI-generated workspaces (see spec `20260115T102836-ai-generated-local-first-apps.md`)
   - Options: (a) TypeScript only, (b) JSON + TypeScript, (c) JSON with a TS adapter
   - **Recommendation**: Support both. JSON contracts are inherently static: perfect for Layer 2 metadata extraction. The server can read a `contract.json` without any TypeScript compilation.

4. **What's the eviction policy for idle workspace actors?**
   - Options: (a) Timer-based (evict after N minutes idle), (b) Memory-based (evict LRU when memory exceeds threshold), (c) Never evict
   - **Recommendation**: Timer-based, 60 seconds after last connection disconnects (matching the current room eviction in `sync/index.ts`). With an option to pin workspaces that should never evict.

5. **Should Layer 3 (API Surface) work without Layer 4 (Runtime)?**
   - Meaning: Can you GET /workspaces/blog/tables/posts if the workspace hasn't been initialized?
   - Options: (a) Return empty/error, (b) Trigger lazy initialization, (c) Return schema-only response
   - **Recommendation**: (b) Trigger lazy initialization. The first data request wakes up the workspace. Schema-only responses (option c) are interesting but add complexity for unclear benefit.

## Edge Cases

### No Config File, Just Sync

User runs `epicenter serve` in an empty directory. No `epicenter.config.ts`, no contracts.

- Layer 0 starts, Layer 1 starts
- Layer 2 finds nothing → no registered workspaces
- Layer 3 mounts no routes (only health/discovery)
- Any WebSocket connection creates an on-demand room
- REST APIs return 404 ("No workspaces registered")

This is a pure sync relay. It works.

### Config File With Broken Extensions

The `epicenter.config.ts` exists but persistence fails to initialize (disk full, permissions).

- Layer 2 reads metadata successfully (tables, actions exist as objects)
- Layer 3 mounts REST routes from metadata
- Layer 4 fails for this workspace → action handlers return 503
- Sync still works (Yjs doc is in-memory, just not persisted)

### Hot-Adding a Workspace

User creates a new `workspaces/crm/epicenter.config.ts` while the server is running.

- Layer 2 detects the new file (filesystem watcher)
- Layer 3 mounts new REST routes
- Layer 4 initializes lazily on first request
- No server restart needed

### Multiple Workspaces, One Fails

Three workspaces: blog, auth, crm. Auth workspace has a schema error.

- Blog and CRM initialize normally
- Auth fails in Layer 4, sync for auth still works in Layer 1
- REST routes for auth return 503 with error details
- Other workspaces are unaffected

## Implementation Sketch

This is not an implementation plan. It's a sketch of what the implementation would look like, to help think through feasibility.

### Room Manager (Layer 1)

Already exists as `packages/server/src/sync/index.ts`. Needs minor refactoring:

- Extract room creation into a standalone function (planned in Phase 2 of `20260213T120800-extract-epicenter-server-package.md`)
- Allow rooms without a pre-existing `Y.Doc` (create fresh on connection)
- Add a registry hook: "when creating a room, check if Layer 4 has a doc for this ID"

### Schema Registry (Layer 2)

New component. Responsible for:

```typescript
type WorkspaceMetadata = {
	id: string;
	source: string; // file path
	tables: Record<string, { fields: Record<string, FieldSchema> }>;
	kv: Record<string, FieldSchema>;
	actions: Record<
		string,
		{
			type: 'query' | 'mutation';
			description?: string;
			inputSchema?: JSONSchema;
		}
	>;
};

type SchemaRegistry = {
	workspaces: Map<string, WorkspaceMetadata>;
	watch(): void;
	scan(): Promise<void>;
};
```

### API Surface Generator (Layer 3)

Takes a `SchemaRegistry` and produces Elysia plugins:

```typescript
function createApiSurface(registry: SchemaRegistry): Elysia {
	const app = new Elysia();

	for (const [id, meta] of registry.workspaces) {
		// Mount table CRUD routes from metadata
		for (const [table, def] of Object.entries(meta.tables)) {
			app.get(`/workspaces/${id}/tables/${table}`, () => {
				// Lazy: get runtime, read from Yjs
				const runtime = getOrCreateRuntime(id);
				return runtime.tables[table].getAllValid();
			});
		}

		// Mount action routes from metadata
		for (const [action, def] of Object.entries(meta.actions)) {
			const method = def.type === 'query' ? 'get' : 'post';
			app[method](`/workspaces/${id}/actions/${action}`, (ctx) => {
				const runtime = getOrCreateRuntime(id);
				return runtime.actions[action](ctx.body);
			});
		}
	}

	return app;
}
```

### Lazy Runtime Manager (Layer 4)

```typescript
type RuntimeManager = {
	get(id: string): WorkspaceRuntime | undefined;
	getOrCreate(id: string): Promise<WorkspaceRuntime>;
	evict(id: string): Promise<void>;
};
```

Imports the config file, calls `createWorkspace(...).withExtension(...)` etc., and caches the live client. Evicts after idle timeout.

## How This Differs From the Current Architecture

| Aspect              | Current                        | Proposed                                  |
| ------------------- | ------------------------------ | ----------------------------------------- |
| Boot dependency     | Requires live client           | Only needs HTTP listener                  |
| Sync availability   | After full initialization      | Immediately                               |
| Schema reading      | Executes entire config         | Reads metadata without executing handlers |
| Failure isolation   | Server crashes on any error    | Per-workspace failures, sync unaffected   |
| Multiple workspaces | Pass array to `createServer()` | Auto-discovered from filesystem           |
| Hot reload          | Not supported                  | Filesystem watcher updates routes         |
| No-config usage     | Not possible                   | Pure sync relay mode                      |

## References

- `packages/server/src/server.ts`: Current `createServer()` implementation
- `packages/server/src/sync/index.ts`: WebSocket sync plugin (room management)
- `packages/epicenter/src/cli/cli.ts`: Current `serve` command
- `packages/epicenter/src/cli/discovery.ts`: Config file discovery
- `specs/20260213T120800-extract-epicenter-server-package.md`: Server extraction (Phase 2 designs room manager)
- `specs/20260205T120000-static-only-server-architecture.md`: Static API server rewrite
- `specs/20260205T000000-cli-config-and-composition.md`: Multi-workspace composition
- `specs/20260203T000000-action-system-v2-context-passing.md`: Action system with `client.actions`
- `specs/20260115T100800-contract.md`: Contract specification
- `specs/20260115T102836-ai-generated-local-first-apps.md`: AI-generated workspace vision
