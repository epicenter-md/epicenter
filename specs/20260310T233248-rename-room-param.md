# Rename `:room` URL param to `:workspace`/`:document` in Cloudflare routes

## Problem

The `:room` URL parameter in the Cloudflare Worker routes is a WebSocket/Yjs implementation detail leaking into the API surface. On `/workspaces/:room` it's really a workspace name; on `/documents/:room` it's a document name. `:room` is confusing to anyone reading the URL or debugging in Data Studio.

## Scope

Rename `:room` to `:workspace` on workspace routes and `:document` on document routes. Update associated variables, validators, and comments. **Not** touching:

- Local server `/rooms/` path or `Room`/`RoomManager` internals (architecturally correct as "rooms")
- DO class names (`WorkspaceRoom`, `DocumentRoom`, `BaseSyncRoom`) — they ARE rooms
- wrangler.jsonc bindings — no migration needed
- sync-client URLs/comments — they reference the local server's `/rooms/` path

> **Update (2026-03-13):** DO names were subsequently updated to include a type segment: `user:{userId}:{type}:{name}`. The rename from `:room` to `:workspace`/`:document` described here was a prerequisite. See `20260313T201800-do-naming-convention.md`.

## DO Safety

`idFromName()` hashes the string value, not the variable name. The DO lookup key `user:${userId}:${workspace}` produces the same string as `user:${userId}:${room}` when the value is identical. Zero migration needed.

## Changes

### `packages/server-remote/src/app.ts`

- [x] Route params: `:room` -> `:workspace` (2 workspace routes) and `:document` (6 document routes)
- [x] `getWorkspaceStub()`: `c.req.param('room')` -> `c.req.param('workspace')`, `roomKey` -> `doName`
- [x] `getDocumentStub()`: `c.req.param('room')` -> `c.req.param('document')`, `roomKey` -> `doName`
- [x] arktype validators: `type({ room: 'string', ... })` -> `type({ document: 'string', ... })`
- [x] JSDoc comment block: "Room key namespacing" -> "DO name namespacing", updated references
- [x] Section comments: "per room" -> "per workspace" / "per document"
- [x] Function JSDoc comments on `getWorkspaceStub` / `getDocumentStub`

### `packages/server-remote/src/base-sync-room.ts`

- [x] Class JSDoc: "Room names are user-scoped" -> "DO names are user-scoped", updated references

## Review

Small, safe rename. Two files changed, zero functional impact. The DO lookup key string is unchanged — only the variable names and param names that construct it were renamed. LSP diagnostics clean on both files.
