# Sync Plugin REST Endpoints

**Date**: 2026-02-20
**Status**: Draft
**Author**: Braden + Claude
**Relates to**: `specs/20260220T080000-plugin-first-server-architecture.md`

## Overview

This specification amends the plugin-first server architecture to include REST endpoints directly within `createSyncPlugin`. While the original design limited the plugin to WebSocket sync and placed REST routes in the `createSyncServer` wrapper, we're moving those routes into the plugin to improve composability and align with how document state is actually managed.

## Motivation

The original decision to separate REST endpoints from the WebSocket plugin was artificial. Document state management, whether via real-time sync or HTTP snapshots, is a single concern.

### Current State

The `createSyncPlugin` is WebSocket-only. If a developer wants to mount the sync engine on an existing Elysia app, they only get the `/:room/sync` WebSocket route. To get document snapshots or room lists, they have to use the `createSyncServer` wrapper or manually recreate the REST logic.

This creates several problems:

1.  **Fragmented Logic**: The code that reads and writes the `Y.Doc` is split between the plugin (WS) and the wrapper (REST).
2.  **Poor Composability**: Developers using the plugin standalone lose access to essential document operations unless they duplicate the server's internal logic.
3.  **Namespace Confusion**: The plugin already owns the `/:room` parameter space for WebSockets. Splitting REST routes into a different layer makes the API surface feel disconnected.

### Desired State

The `createSyncPlugin` becomes the single source of truth for all room and document operations. It registers four primary routes:

```
GET  /              → Room list
WS   /:room/sync    → Real-time sync (y-websocket)
GET  /:room/doc     → Binary document snapshot
POST /:room/doc     → Binary document update
```

This makes `createSyncServer` a thin lifecycle wrapper that simply mounts the plugin and manages the server process.

## Research Findings

### Industry Patterns

We looked at how other sync engines handle the intersection of WebSockets and REST.

| Project        | Approach   | REST Capability                                     |
| :------------- | :--------- | :-------------------------------------------------- |
| **y-sweet**    | Integrated | `GET /d/:id/as-update`, `POST /d/:id/update`        |
| **Liveblocks** | Integrated | REST API for reading/updating Yjs docs alongside WS |
| **Hocuspocus** | Integrated | Extension-based REST endpoints in the same core     |

**Key finding**: Successful sync platforms treat REST as a first-class citizen of the sync engine, not an external operational concern.

**Implication**: Moving REST routes into the plugin aligns with developer expectations and simplifies the architecture.

## Design Decisions

| Decision           | Choice                                             | Rationale                                                                 |
| :----------------- | :------------------------------------------------- | :------------------------------------------------------------------------ |
| **Route Location** | Inside `createSyncPlugin`                          | Ensures any app using the plugin gets the full API surface.               |
| **Data Format**    | `application/octet-stream`                         | Yjs updates are binary. Raw binary is more efficient than Base64 in JSON. |
| **Room Creation**  | POST creates, GET doesn't                          | GET requests shouldn't have side effects like initializing room state.    |
| **Auth Strategy**  | `Authorization: Bearer` for REST, `?token=` for WS | Each transport uses its idiomatic auth mechanism. No fallback mixing.     |

## Auth Strategy

Each transport uses the auth mechanism appropriate to its constraints:

| Transport                     | Auth Mechanism                     | Why                                                                                                    |
| :---------------------------- | :--------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **WebSocket** (`/:room/sync`) | `?token=xxx` query param           | Browser `WebSocket` API cannot set custom headers. This is a platform constraint, not a design choice. |
| **REST** (`/:room/doc`, `/`)  | `Authorization: Bearer xxx` header | HTTP standard. Tokens stay out of access logs, proxy logs, referer headers, and browser history.       |

No fallback between them. WS uses query param because it must. REST uses header because it can.

### Why no `?token=` fallback on REST

Supporting `?token=` on REST "for convenience" means tokens leak into places they shouldn't:

- Server access logs (`GET /rooms/blog/doc?token=secret 200`)
- Reverse proxy logs
- Browser history and referer headers
- Shared curl commands in Slack

The convenience gain (`?token=` vs `-H "Authorization: Bearer"`) is marginal. The security cost is real.

### Elysia Implementation

The REST routes use a `guard` with `beforeHandle` to extract and validate the Bearer token:

```typescript
// Inside createSyncPlugin: REST routes only
new Elysia()
  .guard({
    async beforeHandle({ headers, set }) {
      const authHeader = headers.authorization;
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
      const authorized = await validateAuth(config?.auth, token);
      if (!authorized) {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
    },
  })
  .get('/:room/doc', ...)
  .post('/:room/doc', ...)
```

The existing `validateAuth(config, token)` function is reused unchanged. It receives a token string regardless of where it was extracted from. The WS `open` handler keeps using `ws.data.query.token`. The REST guard extracts from `Authorization` header.

### Room list auth

`GET /` (room list) is also behind auth. Active room IDs are operational metadata that shouldn't be publicly enumerable.

## Architecture

The plugin manages the room lifecycle and exposes it through multiple transports.

```
┌──────────────────────────────────────────────────────────┐
│                   createSyncPlugin                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │                  Room Manager                      │  │
│  │        (In-memory Docs + Persistence)              │  │
│  └────────────────────────────────────────────────────┘  │
│          ▲                ▲                ▲             │
│          │                │                │             │
│  ┌───────┴──────┐  ┌──────┴───────┐  ┌─────┴──────┐      │
│  │   WS Sync    │  │  HTTP Snap   │  │ HTTP Update│      │
│  │ /:room/sync  │  │ /:room/doc   │  │ /:room/doc │      │
│  │ ?token=xxx   │  │ Bearer auth  │  │ Bearer auth│      │
│  └──────────────┘  └──────────────┘  └────────────┘      │
└──────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Plugin Enhancement

- [ ] **1.1 Room List**: Add `GET /` to `plugin.ts`. It should return `{ rooms: [{ id, connections }] }` from the room manager.
- [ ] **1.2 Document Snapshot**: Add `GET /:room/doc`. Return `Y.encodeStateAsUpdate(doc)` as a binary response. Return 404 if the room isn't active.
- [ ] **1.3 Document Update**: Add `POST /:room/doc`. Read the binary body and call `Y.applyUpdate(doc, update)`. Create the room on demand if it doesn't exist.
- [ ] **1.4 Auth Integration**: Add an Elysia `guard` with `beforeHandle` for REST routes. Extract token from `Authorization: Bearer` header, pass to existing `validateAuth`. Return 401 if rejected. The WS `open` handler continues using `ws.data.query.token`: no change there.

### Phase 2: Server Simplification

- [ ] **2.1 Cleanup**: Remove REST route definitions from `createSyncServer`.
- [ ] **2.2 Refactor**: Update `createSyncServer` to be a thin wrapper that just calls `app.use(createSyncPlugin(config))`.

### Phase 3: Verification

- [ ] **3.1 Integration Tests**: Verify that a `POST` update to `/:room/doc` is immediately broadcast to clients connected via `/:room/sync`.
- [ ] **3.2 Auth Tests**: Ensure REST endpoints reject requests without `Authorization: Bearer` header (or with invalid token). Verify `?token=` query param does NOT work on REST routes (no fallback).

## Edge Cases

- **Malformed Binary**: `Y.applyUpdate` throws on invalid data. The `POST` handler must catch this and return a 400 Bad Request.
- **Empty Rooms**: `GET /` should return `{ rooms: [] }` when no rooms are active, not a 404 or error.
- **GET on Inactive Room**: If a room exists in persistence but isn't "active" in memory, `GET /:room/doc` should return 404. We only want to serve snapshots for rooms that are currently being managed.
- **REST with `?token=` instead of Bearer**: Returns 401. The token is ignored on REST routes: only `Authorization: Bearer` is checked. This is intentional (see Auth Strategy section).
- **Open mode (no auth configured)**: Both WS and REST skip auth entirely. `GET /:room/doc` works without any header. Same behavior as the current WS open mode.

## Open Questions

1.  **Should GET /:room/doc trigger a load from persistence?**
    - **Recommendation**: No. Keep it simple. If the room isn't active, return 404. This prevents HTTP crawlers or random GETs from spinning up room resources.
2.  **Should we support JSON-wrapped updates?**
    - **Recommendation**: No. Stick to raw binary for now. It's cleaner and matches the Yjs ecosystem better.

## Success Criteria

- `GET /:room/doc` returns a valid Yjs binary update.
- `POST /:room/doc` updates are reflected in real-time for WebSocket clients.
- `createSyncServer` contains no route-specific logic.
- Auth is consistently enforced across WS and REST.

## References

- `packages/server/src/sync/plugin.ts`
- `packages/server/src/sync/server.ts`
- `packages/server/src/sync/rooms.ts`
- `packages/server/src/sync/auth.ts`
- `specs/20260220T080000-plugin-first-server-architecture.md`
