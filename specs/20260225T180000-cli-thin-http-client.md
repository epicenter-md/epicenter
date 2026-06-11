# CLI as Thin HTTP Client via Eden Treaty

**Date:** 2026-02-25
**Status:** Implemented
**Feature:** Redesign the CLI from an in-process workspace loader to a thin HTTP client that talks to a running Elysia server via Eden Treaty

## Problem

The CLI currently loads workspace configs in-process and operates directly on Y.Doc data. Each invocation initializes a full workspace client, does one operation, and exits. This is:

1. **Slow**: Y.Doc initialization on every command
2. **Stateless**: no persistence between commands without file-based extensions
3. **Single-workspace only**: treats multiple configs as an error
4. **Architecturally misaligned**: the sidecar spec (`specs/20260225T000000-bun-sidecar-workspace-modules.md`) defines a persistent Bun server as the single owner of workspace Y.Docs

The server (`packages/server/`) already has multi-workspace support, REST CRUD for tables, and action endpoints. The CLI should become a thin HTTP client that talks to this running server.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  epicenter serve                                         │
│  (loads ALL workspaces, single owner of Y.Docs)          │
│  Elysia server on localhost:3913                         │
│  exports type LocalApp = typeof app                      │
└────────────┬─────────────────────────┬───────────────────┘
             │ HTTP (Eden Treaty)      │ HTTP/WS
     ┌───────┴────────┐      ┌────────┴──────────┐
     │  CLI commands   │      │  Tauri WebView    │
     │  (thin client)  │      │  (SPA, also thin) │
     └────────────────┘      └───────────────────┘
```

The server is the **single owner** of each workspace's Y.Doc. Everything else (CLI, UI, sync peers) talks to it via HTTP or WebSocket. Without the server running, there is no safe way to read/write workspace data: concurrent access to Y.Doc files is a race condition even with CRDTs (lost updates between read-modify-write cycles).

## Key Design Decision: Parameterized Routes

The original plan was to create routes dynamically per workspace (e.g., `new Elysia({ prefix: \`/\${client.id}\` })`). This doesn't work with Eden Treaty because Elysia's type system only accumulates types from statically-defined `.use()` chains. Routes created inside loops produce `Elysia<{}>`: the types vanish.

**Solution**: All workspace routes use parameterized paths (`/:workspaceId/tables/:tableName`) and resolve the workspace at request time from a `Record<string, AnyWorkspaceClient>` map. This gives Eden Treaty full static type information.

Eden Treaty represents parameterized route segments as **functions**, not indexable objects:
```typescript
// Correct: function-call syntax
api.workspaces({ workspaceId }).tables({ tableName }).get()

// Wrong: bracket syntax (TypeScript error)
api.workspaces[workspaceId].tables[tableName].get()
```

**Actions exception**: Wildcard routes (`/*`) don't produce usable types in Eden Treaty. Action commands use plain `fetch` instead of the Eden client.

## Workspace Metadata Endpoint

The CLI needs to know which tables exist for a workspace to build yargs commands dynamically. A workspace metadata endpoint was added:

```
GET /workspaces/:workspaceId → { id, tables: string[], kv: string[], actions: string[] }
```

This lets the CLI discover available resources without loading workspace configs.

## Command Structure

```
epicenter serve [--port 3913] [--dir <path>...]   # Start server, load all workspaces
epicenter workspaces                               # List loaded workspaces from server

epicenter <workspace> tables                       # List tables for a workspace
epicenter <workspace> <table> list                 # List all rows
epicenter <workspace> <table> get <id>             # Get row by ID
epicenter <workspace> <table> set <id> [json]      # Create/replace row
epicenter <workspace> <table> patch <id> [json]    # Partial update row
epicenter <workspace> <table> delete <id>          # Delete row

epicenter <workspace> kv get <key>                 # Get KV value
epicenter <workspace> kv set <key> [value]         # Set KV value
epicenter <workspace> kv delete <key>              # Delete KV entry

epicenter <workspace> action <path> [json]         # Run action (query or mutation)
```

### Design decisions

- **Workspace ID is always the first positional arg** for CRUD commands. No implicit resolution from cwd: explicit is better for a client talking to a remote server that may host multiple workspaces.
- **`kv` and `action` are subcommands**, not top-level like table names. This avoids namespace collisions (a table named `kv` would shadow the KV commands otherwise).
- **Table names are top-level subcommands** under a workspace, discovered dynamically from the metadata endpoint.
- **Input methods** are preserved: inline JSON, `@file` references, stdin piping (from existing `parse-input.ts`).
- **Output formatting** is preserved: pretty JSON for TTY, compact JSON for pipes, JSONL (from existing `format-output.ts`).

## Eden Treaty Integration

Eden Treaty provides type-safe RPC with zero codegen. The server exports its Elysia app type, and the CLI imports it:

**Server** (type export only, no runtime dependency):
```typescript
// packages/server/src/local.ts
export type LocalApp = ReturnType<typeof createLocalServer>['app'];
```

**CLI** (runtime dependency):
```typescript
// packages/cli/src/api-client.ts
import { treaty } from '@elysiajs/eden';
import type { LocalApp } from '@epicenter/server';

export function createApiClient(baseUrl = 'http://localhost:3913') {
  return treaty<LocalApp>(baseUrl);
}
```

The `@elysiajs/eden` package lives in `packages/cli/` only. The server never needs it.

**Type stability requirement**: All `.use()` calls in `local.ts` must be chained in a single expression for Elysia's type to accumulate. The auth guard was extracted to a separate plugin function to enable this chaining. The workspace plugin is always mounted unconditionally (even with zero clients) so the type is stable.

## Multi-Workspace Discovery

### `epicenter serve` discovery strategy

1. Scan provided directories (or cwd by default) for `epicenter.config.ts`
2. `--dir` flag accepts multiple directories to scan
3. All discovered clients merged into a single server
4. **Duplicate workspace IDs = hard error at startup**, listing the conflicting file paths

### `epicenter workspaces` enumeration

Calls `GET /` on the running server via Eden Treaty. The discovery root returns `{ workspaces: string[] }` with all loaded workspace IDs.

## No Server Running

If a CRUD command runs without a server on `localhost:3913`:

```
Error: No Epicenter server running on localhost:3913.
Start one with: epicenter serve
```

Hard error. No auto-start, no fallback to direct mode. The server must be running.

## Implementation Steps (As Executed)

### Step 1: Add KV REST endpoints to server

**New file**: `packages/server/src/workspace/kv.ts`

Created `createKvPlugin(workspaces)` with parameterized routes:

| Method | Route | Handler | Response |
|--------|-------|---------|----------|
| `GET` | `/:workspaceId/kv/:key` | `workspace.kv.get(key)` | `200 { value }` or `404` |
| `PUT` | `/:workspaceId/kv/:key` | `workspace.kv.set(key, body)` | `200` |
| `DELETE` | `/:workspaceId/kv/:key` | `workspace.kv.delete(key)` | `200` |

**Modified**: `packages/server/src/workspace/plugin.ts`: mounts KV plugin.
**Modified**: `packages/server/src/workspace/index.ts`: re-exports `createKvPlugin`.

### Step 2: Refactor server routes to parameterized paths

All workspace routes changed from per-workspace dynamic prefixes to parameterized paths. Each plugin takes `Record<string, AnyWorkspaceClient>` and resolves the workspace at request time.

**Rewritten**: `packages/server/src/workspace/tables.ts`: `/:workspaceId/tables/:tableName[/:id]`
**Rewritten**: `packages/server/src/workspace/actions.ts`: `/:workspaceId/actions/*` (wildcard)
**Rewritten**: `packages/server/src/workspace/plugin.ts`: builds workspaces map, adds metadata endpoint, chains all plugins.

### Step 3: Export Elysia App type for Eden Treaty

**Rewritten**: `packages/server/src/local.ts`: auth guard extracted to plugin, all `.use()` chained, unconditional workspace mount, exports `LocalApp` type.
**Modified**: `packages/server/src/index.ts`: re-exports `LocalApp` type.

### Step 4: Add `@elysiajs/eden` to CLI + create API client

**Modified**: `packages/cli/package.json`: added `@elysiajs/eden` dependency.
**New file**: `packages/cli/src/api-client.ts`: Eden Treaty client wrapper + `assertServerRunning()`.

### Step 5: Multi-workspace discovery

**Modified**: `packages/cli/src/discovery.ts`: added `discoverAllWorkspaces(dirs)` with duplicate ID detection.

### Step 6: Rewrite CRUD commands as HTTP calls

**Rewritten**: `packages/cli/src/commands/table-commands.ts`: Eden Treaty function-call syntax.
**Rewritten**: `packages/cli/src/commands/kv-commands.ts`: Eden Treaty function-call syntax.
**Rewritten**: `packages/cli/src/commands/meta-commands.ts`: takes table names from server metadata.
**Rewritten**: `packages/cli/src/command-builder.ts`: actions via plain `fetch` (wildcards don't type in Eden).
**New file**: `packages/cli/src/commands/workspaces-command.ts`: lists workspaces via Eden Treaty.

### Step 7: Restructure CLI entry point

**Rewritten**: `packages/cli/src/cli.ts`: two-mode dispatch: `serve` loads in-process, everything else fetches workspace metadata then builds commands.
**Simplified**: `packages/cli/src/bin.ts`: removed watch mode and directory flag parsing.

## Server Route Structure

```
GET  /                                              → { workspaces, actions }
WS   /rooms/:room                                   → y-websocket sync
GET  /rooms/:room                                   → binary Y.Doc state
POST /rooms/:room                                   → apply Yjs update

/workspaces/
  GET  /:workspaceId                                → { id, tables, kv, actions }
  /:workspaceId/tables/
    GET    /:tableName                              → list all valid rows
    GET    /:tableName/:id                          → get row by ID
    PUT    /:tableName/:id                          → create or replace row
    PATCH  /:tableName/:id                          → partial update row
    DELETE /:tableName/:id                          → delete row
  /:workspaceId/kv/
    GET    /:key                                    → get KV value
    PUT    /:key                                    → set KV value
    DELETE /:key                                    → delete KV entry
  /:workspaceId/actions/
    GET    /*                                       → run query (input via query params)
    POST   /*                                       → run mutation (input via JSON body)
```

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/workspace/kv.ts` | **New** | KV REST plugin with parameterized routes |
| `packages/server/src/workspace/tables.ts` | Rewrite | Parameterized routes, takes workspaces map |
| `packages/server/src/workspace/actions.ts` | Modify | Added `createActionsPlugin` with parameterized wildcard routes |
| `packages/server/src/workspace/plugin.ts` | Rewrite | Builds workspaces map, metadata endpoint, chains all plugins |
| `packages/server/src/workspace/index.ts` | Modify | Re-export `createKvPlugin` |
| `packages/server/src/workspace/tables.test.ts` | Rewrite | Updated for parameterized routes, added 404 tests |
| `packages/server/src/local.ts` | Rewrite | Auth guard plugin, chained `.use()`, unconditional mount, `LocalApp` type |
| `packages/server/src/index.ts` | Modify | Re-export `LocalApp` type |
| `packages/cli/package.json` | Modify | Add `@elysiajs/eden` dependency |
| `packages/cli/src/api-client.ts` | **New** | Eden Treaty client wrapper + server health check |
| `packages/cli/src/discovery.ts` | Modify | Add `discoverAllWorkspaces()`, duplicate ID check |
| `packages/cli/src/cli.ts` | Rewrite | Two-mode dispatch (serve vs HTTP client) |
| `packages/cli/src/bin.ts` | Simplify | Removed watch mode, directory flag parsing |
| `packages/cli/src/commands/table-commands.ts` | Rewrite | Eden Treaty function-call syntax |
| `packages/cli/src/commands/kv-commands.ts` | Rewrite | Eden Treaty function-call syntax |
| `packages/cli/src/commands/meta-commands.ts` | Rewrite | Takes table names from server metadata |
| `packages/cli/src/commands/workspaces-command.ts` | **New** | `epicenter workspaces`: list from server |
| `packages/cli/src/command-builder.ts` | Rewrite | Action commands via plain `fetch` |
| `packages/cli/src/cli.test.ts` | Rewrite | Updated for HTTP-based architecture |
| `packages/cli/src/command-builder.test.ts` | Rewrite | Updated for new action command shape |
