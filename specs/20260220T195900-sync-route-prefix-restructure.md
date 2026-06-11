# Sync Route Prefix Restructure: `/workspaces` → `/rooms`

**Date**: 2026-02-20
**Status**: Draft
**Author**: Braden + Claude

## Overview

Move the sync WebSocket endpoint from `/workspaces/:room/sync` to `/rooms/:room/sync`. The sync layer is a generic Y.Doc relay organized by rooms. It doesn't know about workspaces, and mounting it under `/workspaces` becomes semantically wrong when row-level documents also sync through it.

## Motivation

### Current State

Everything lives under `/workspaces`:

```
/workspaces/{id}/tables/{table}    ← workspace REST API
/workspaces/{id}/actions/{action}  ← workspace REST API
/workspaces/{id}/sync              ← Y.Doc sync
```

The sync plugin registers `/:room/sync` and gets mounted under a `/workspaces` prefix:

```typescript
// server.ts
new Elysia({ prefix: '/workspaces' })
	.use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
	.use(createWorkspacePlugin(clients));

// sync/server.ts (standalone)
new Elysia().use(new Elysia({ prefix: '/workspaces' }).use(syncPlugin));
```

Client-side URLs use the same pattern:

```typescript
// extensions/sync.ts
createSyncExtension({ url: 'ws://localhost:3913/workspaces/{id}/sync' });

// tab-manager background.ts
createSyncExtension({ url: 'ws://127.0.0.1:3913/workspaces/{id}/sync' });
```

This works today because only workspace Y.Docs sync: each room IS a workspace ID.

### The Problem

Tables can declare per-row documents via `.withDocument()`:

```typescript
const files = defineTable(
	type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });
```

Each row gets its own Y.Doc managed by `createDocumentBinding`. These docs have their own lifecycle and can have sync extensions wired via `withDocumentExtension()`:

```typescript
workspace.withDocumentExtension('sync', ({ ydoc, binding }) => {
	// ydoc.guid is a row-level GUID, NOT a workspace ID
	const provider = createSyncProvider({
		doc: ydoc,
		url: `ws://server/workspaces/${ydoc.guid}/sync`, // ← wrong prefix
	});
	return { destroy: () => provider.destroy() };
});
```

When row-level documents sync, the room ID is a document GUID (e.g., `abc-123-def`), not a workspace ID. The URL becomes `ws://server/workspaces/abc-123-def/sync`, but `abc-123-def` isn't a workspace. It's a content document belonging to a row in some table.

The `/workspaces` prefix promises "this is about workspaces". The tables and actions routes deliver on that promise, but the sync route doesn't. It's a generic document relay that happens to be co-located with workspace routes.

### Desired State

```
/workspaces/{id}/tables/{table}    ← workspace REST API (unchanged)
/workspaces/{id}/actions/{action}  ← workspace REST API (unchanged)
/rooms/{room}/sync                 ← Y.Doc sync (any document)
```

Client URLs become:

```typescript
// Workspace sync
createSyncExtension({ url: 'ws://localhost:3913/rooms/{id}/sync' });

// Row-level document sync
createSyncProvider({ doc: ydoc, url: `ws://server/rooms/${ydoc.guid}/sync` });
```

Both workspace docs and row-level docs use `/rooms`: no semantic confusion.

## Design Decisions

| Decision               | Choice                               | Rationale                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New prefix name        | `/rooms` not `/documents`            | Server code already uses "room" everywhere: `createRoomManager`, `roomId`, `join(roomId)`, `onRoomCreated`, `onRoomEvicted`. "Room" is the sync session (connections + awareness + eviction). "Document" would conflate with Y.Doc (the data structure) vs. room (the sync unit wrapping it). |
| Scope of change        | Only the mount prefix changes        | The sync plugin already registers `/:room/sync`. Only the Elysia `prefix` option changes from `/workspaces` to `/rooms`. The plugin, room manager, protocol, and auth are all untouched.                                                                                                       |
| Standalone sync server | Also uses `/rooms`                   | `createSyncServer()` currently mounts under `/workspaces`. Should use `/rooms` for consistency.                                                                                                                                                                                                |
| Client-side URLs       | Update `{id}` placeholder convention | The `{id}` placeholder in sync URLs already refers to `ydoc.guid`, not workspace ID. This doesn't change: just the prefix around it.                                                                                                                                                          |
| Breaking change        | Yes, intentional                     | The URL structure is not semver-stable yet (pre-1.0). All known sync URL references are in this repo.                                                                                                                                                                                          |

## Architecture

### Before

```
Elysia()
└── prefix: /workspaces
    ├── createSyncPlugin()     →  /workspaces/:room/sync    (WebSocket)
    └── createWorkspacePlugin()
        ├── /:id/tables/:table                                (REST)
        └── /:id/actions/:action                              (REST)
```

### After

```
Elysia()
├── prefix: /rooms
│   └── createSyncPlugin()     →  /rooms/:room/sync          (WebSocket)
│
└── prefix: /workspaces
    └── createWorkspacePlugin()
        ├── /:id/tables/:table                                (REST)
        └── /:id/actions/:action                              (REST)
```

The sync plugin is no longer nested inside the `/workspaces` Elysia instance. It gets its own `/rooms` prefix at the top level.

### URL Hierarchy (updated)

```
/                                              - API root / discovery
/openapi                                       - Scalar UI documentation
/openapi/json                                  - OpenAPI spec (JSON)
/rooms/{room}/sync                             - WebSocket sync (any Y.Doc)
/workspaces/{workspaceId}/tables/{table}       - RESTful table CRUD
/workspaces/{workspaceId}/tables/{table}/{id}  - Single row operations
/workspaces/{workspaceId}/actions/{action}     - Workspace action endpoints
```

### How Row-Level Document Sync Works

```
Workspace Y.Doc (room = "blog")
├── table:posts (Y.Array of rows)
│   ├── row abc-123 → .withDocument('content', { guid: 'id' })
│   │   └── Content Y.Doc (room = "abc-123")     →  /rooms/abc-123/sync
│   └── row def-456
│       └── Content Y.Doc (room = "def-456")     →  /rooms/def-456/sync
│
└── Workspace itself                              →  /rooms/blog/sync
```

All documents: workspace-level or row-level: sync through the same `/rooms/:room/sync` endpoint. The room manager doesn't distinguish between them. The `getDoc` callback (in integrated mode) resolves whatever room ID the client connects with.

## Implementation Plan

### Phase 1: Update server-side mount prefix

- [x] **1.1** In `server.ts` (`createServer`): Mount sync plugin under `/rooms` prefix instead of nesting it inside the `/workspaces` Elysia instance
- [x] **1.2** In `sync/server.ts` (`createSyncServer`): Change prefix from `/workspaces` to `/rooms`
- [x] **1.3** Update the `getDoc` callback in `createServer`: no code change needed since `getDoc` receives the room ID regardless of prefix, but verify this

### Phase 2: Update client-side URLs

- [x] **2.1** In `extensions/sync.ts`: Update JSDoc examples from `ws://…/workspaces/{id}/sync` to `ws://…/rooms/{id}/sync`
- [x] **2.2** In `apps/tab-manager/src/entrypoints/background.ts`: Update sync URL
- [x] **2.3** In `apps/tab-manager/src/lib/workspace-popup.ts`: Update sync URL
- [x] **2.4** Grep for any other `workspaces/{id}/sync` or `workspaces/{room}/sync` references and update them

### Phase 3: Update documentation and tests

- [x] **3.1** Update `packages/server/README.md`: URL hierarchy section, all WebSocket URL examples
- [x] **3.2** Update `packages/epicenter/README.md`: sync extension examples, server URL references
- [x] **3.3** Update `packages/server/src/sync/plugin.ts` JSDoc: the examples showing `/workspaces` prefix usage
- [x] **3.4** Update test files that reference the old URL pattern (notably `sync/plugin.test.ts`, `server.test.ts`)
- [x] **3.5** Update the plugin-first server architecture spec (`20260220T080000`) to reflect the new prefix in its review section

### Phase 4: Verify

- [x] **4.1** `bun run typecheck` clean (pre-existing errors in `@epicenter/filesystem` only: unrelated to this change)
- [x] **4.2** `bun test` passes for `packages/server` (138 pass, 0 fail) and `packages/epicenter` sync tests (6 pass, 0 fail)
- [x] **4.3** Grep confirms zero remaining `workspaces.*sync` URL patterns (except historical specs)

## Edge Cases

### Standalone sync server has no `/workspaces` routes

1. `createSyncServer()` only has sync: no tables or actions
2. Previously mounted at `/workspaces/:room/sync` despite having nothing workspace-related
3. Now correctly at `/rooms/:room/sync`: matches its actual purpose

### Integrated mode: `getDoc` must resolve both workspace IDs and document GUIDs

1. `createServer()` currently maps workspace IDs: `getDoc: (room) => workspaces[room]?.ydoc`
2. Row-level documents have GUIDs that won't match workspace IDs
3. The `getDoc` callback needs to be extended to resolve both workspace docs and row-level docs
4. **This is a future concern**: this spec only changes the prefix. The `getDoc` resolution logic is a separate feature when row-level document sync is actually wired up.

### Clients connecting to old URLs after upgrade

1. Client uses `ws://server/workspaces/{id}/sync` against updated server
2. Server has no route matching `/workspaces/:room/sync` → WebSocket upgrade fails (404)
3. Client retry loop will keep failing until URL is updated
4. Acceptable: all known clients are in this repo and updated together

## Open Questions

1. **Should `createServer` support a `syncPrefix` option for custom mount points?**
   - The sync plugin already supports Elysia's native `prefix` mechanism
   - Adding a config option would add API surface for an edge case
   - **Recommendation**: No. Power users who want a custom prefix compose plugins directly with `new Elysia({ prefix: '/custom' }).use(createSyncPlugin())`. Keep `createServer` opinionated.

2. **Should the `{id}` placeholder in sync URLs change to `{room}`?**
   - Currently `createSyncExtension` uses `url: 'ws://…/rooms/{id}/sync'` and replaces `{id}` with `ydoc.guid`
   - `{room}` would be more semantically accurate for the URL template
   - But `{id}` is the workspace ID from the user's perspective when calling `createSyncExtension`
   - **Recommendation**: Keep `{id}`: it's the user-facing placeholder. The fact that it becomes a room ID is an implementation detail. Changing it would break the existing API for no functional benefit.

## Success Criteria

- [x] `ws://localhost:3913/rooms/{room}/sync` is the sync endpoint for both `createServer` and `createSyncServer`
- [x] `/workspaces/{id}/tables/...` and `/workspaces/{id}/actions/...` are unchanged
- [x] All sync-related tests pass with the new URL structure
- [x] Zero remaining references to `/workspaces/…/sync` in non-spec source files
- [x] READMEs reflect the updated URL hierarchy

## References

- `packages/server/src/server.ts`: Mount prefix change (main change)
- `packages/server/src/sync/server.ts`: Standalone server prefix change
- `packages/server/src/sync/plugin.ts`: Plugin itself unchanged, JSDoc examples updated
- `packages/server/src/sync/plugin.test.ts`: Test URL references
- `packages/server/src/server.test.ts`: Test URL references
- `packages/epicenter/src/extensions/sync.ts`: Client-side URL examples in JSDoc
- `apps/tab-manager/src/entrypoints/background.ts`: Sync URL reference
- `apps/tab-manager/src/lib/workspace-popup.ts`: Sync URL reference
- `packages/server/README.md`: URL hierarchy documentation
- `packages/epicenter/README.md`: Sync extension documentation
- `specs/20260220T080000-plugin-first-server-architecture.md`: Prior spec to annotate

## Review

### Changes Made

Split the single `/workspaces` Elysia instance in `server.ts` into two separate instances: `/rooms` for the sync plugin and `/workspaces` for the workspace plugin. Updated all URL references across the codebase.

### Files Changed

**Server-side (functional):**

- `packages/server/src/server.ts`: Split mount prefix, two separate `.use()` calls
- `packages/server/src/sync/server.ts`: Changed prefix from `/workspaces` to `/rooms`
- `packages/server/src/start-hub.ts` -- Hub server CLI entry point, updated JSDoc and console.log URL
- `packages/server/src/start-local.ts` -- Local server CLI entry point, updated JSDoc and console.log URL

**Client-side (functional):**

- `apps/tab-manager/src/entrypoints/background.ts`: Updated sync URL
- `apps/tab-manager/src/lib/workspace-popup.ts`: Updated sync URL

**JSDoc updates:**

- `packages/epicenter/src/extensions/sync.ts`: 5 URL examples
- `packages/epicenter/src/extensions/sync/web.ts`: 1 URL example
- `packages/epicenter/src/extensions/sync/desktop.ts`: 1 URL example
- `packages/server/src/sync/plugin.ts`: JSDoc example showing new prefix pattern
- `packages/server/src/workspace/plugin.ts`: JSDoc example showing separated architecture
- `packages/sync/src/provider.ts`: 3 URL examples

**Tests:**

- `packages/server/src/sync/plugin.test.ts`: `wsUrl` helper
- `packages/epicenter/src/extensions/sync.test.ts`: 9 test URL strings

**Documentation:**

- `packages/server/README.md`: URL hierarchy, deployment diagram, code examples
- `packages/epicenter/README.md`: Sync extension examples, architecture docs
- `packages/sync/README.md`: Provider examples, relationship section
- `packages/epicenter/SYNC_ARCHITECTURE.md`: All sync URL examples
- `packages/epicenter/docs/architecture/security.md`: Auth example URL
- `packages/epicenter/docs/architecture/network-topology.md`: All topology URLs

**Spec annotations:**

- `specs/20260220T080000-plugin-first-server-architecture.md`: Added note about prefix change

### Verification

- `bun typecheck`: Clean for all changed packages. Pre-existing errors in `@epicenter/filesystem` (unrelated `_v` type issues).
- `bun test` (packages/server): 138 pass, 0 fail, 254 expect() calls
- `bun test` (packages/epicenter sync.test.ts): 6 pass, 0 fail
- Grep for `/workspaces.*sync` in `.ts` source files: zero remaining (only table route test names in `server.test.ts`, which are correct)
- Grep for `/workspaces.*sync` in `.md` package docs: zero remaining
