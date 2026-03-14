# Room Isolation and Sharing

**Date**: 2026-03-07
**Status**: Decision Record
**Author**: AI-assisted
**Supersedes**: `20260307T000001-org-scoped-rooms.md`

> **Update (2026-03-13):** DO names now include a type segment: `user:{userId}:{type}:{name}` where `{type}` is `workspace` or `document`. The room key examples below use the original format `user:{userId}:{roomName}`. See `20260313T201800-do-naming-convention.md`.

## Overview

User-scoped room keys (`user:{userId}:{roomName}`) for document isolation, with a `room_access` table as the single source of truth for shared access. No roles — all shared users are editors. Org membership can populate `room_access` rows in the future, but is never the room key itself.

## Motivation

### Current State

Room keys are user-scoped — the Worker prefixes `user:{userId}:` before calling `idFromName()`:

```typescript
// packages/server-remote/src/app.ts:196
const roomKey = `user:${c.var.user.id}:${c.req.param('room')}` as const;
const stub = c.env.YJS_ROOM.get(c.env.YJS_ROOM.idFromName(roomKey));
```

This was shipped to fix a critical bug: all authenticated users sharing the same DO when they used the same workspace name. Personal isolation works. Sharing does not.

### Problems

1. **No sharing mechanism**: There's no way for user A to grant user B access to their room
2. **No shared room discovery**: User B has no way to find rooms shared with them

### Desired State

- Personal rooms work with zero DB lookup (fast path, already shipped)
- Shared room access checked via a single Postgres table
- Org membership can bulk-grant access in the future, but doesn't replace the table
- The YjsRoom DO stays completely unchanged — all scoping is in the Worker

## Research Findings

### Strategy Comparison

Two strategies were evaluated in depth, with dedicated agents arguing for each:

| Dimension | User-scoped keys + `room_access` table | Org-scoped keys (`org:{orgId}:{room}`) |
|---|---|---|
| Personal room DB lookup | None (fast path) | Required (`activeOrganizationId` resolution) |
| Room key stability | Immutable — sharing is a Postgres row | Changes if doc moves between orgs |
| Per-document sharing | Native — insert a row | Requires bolting on an ACL layer on top of org infra |
| Org sharing | Bulk-insert rows into `room_access` | Native — all org members share all rooms |
| `activeOrganizationId` | Not used in routing | Required on every sync request — mutable session state |
| WebSocket session drift | Impossible — userId is immutable | Possible — user switches org in another tab |
| Ownership transfer | Not needed — sharing is additive | Requires re-keying the DO or migrating state |
| Account deletion blast radius | Only affects rooms keyed to that user | Decoupled — org owns rooms, not users |
| "All my shared docs" query | `SELECT * FROM room_access WHERE user_id = ?` | Same, but also needs org membership join |
| Implementation cost (now) | Zero — already shipped | Org plugin + schema + migration + middleware |
| Implementation cost (sharing) | One table + one middleware | Already built in (but per-doc sharing still needs ACL) |

**Key finding**: Org-scoped keys conflate document identity with access control. When you inevitably need per-document sharing (Google Docs model), you end up building a `room_access` table anyway — on top of org infrastructure. Two permission systems coexist awkwardly.

**Implication**: Use user-scoped keys for stable DO identity. Use `room_access` for all access control. Use org membership as one way to populate `room_access`, not as the routing primitive.

### The `activeOrganizationId` Footgun

Better Auth's org plugin stores `activeOrganizationId` on the session. This is mutable — users can switch orgs. WebSocket connections are long-lived. If a user opens a WebSocket under org A, then switches to org B in another tab, the WebSocket is now connected to org A's room while the session says org B. This creates subtle bugs:

- HTTP sync requests go to org B's room (new `activeOrganizationId`)
- WebSocket messages go to org A's room (connection established before switch)
- The client thinks it's synced but it's talking to two different DOs

With user-scoped keys, this is impossible. The user ID is immutable for the session lifetime.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Room key format | `user:{userId}:{roomName}` | Deterministic, immutable, no DB lookup for owner |
| Access control | `room_access` table in Postgres | Single source of truth, queryable, supports both direct and org-derived sharing |
| Roles | None — all shared users are editors | YAGNI. Add a `role` column later if viewer-only access becomes a real need. |
| Org plugin | Deferred | Can be added later; org membership becomes a way to populate `room_access` rows |
| Unified route | Single `/rooms/:room` route with access check | No split between personal and shared routes. Check room key prefix — if it matches the requesting user, skip DB; otherwise, check `room_access`. |
| Owner implicit access | Derived from room key prefix | Owner never needs a `room_access` row — their userId is in the key |
| Sharing by email | Owner shares by email, server resolves to userId | Users don't know each other's IDs. The share endpoint looks up the email in the `user` table. |
| DO changes | None | The DO is a generic Y.Doc host. All access control is at the Worker boundary. |

## Architecture

```
ROOM ACCESS (single route, smart fast path)
════════════════════════════════════════════

  Client: POST /rooms/tab-manager
    │
    ▼
  authGuard: validate session → c.var.user.id
    │
    ▼
  Construct roomKey from route param
    │
    ├── Room key starts with "user:{myUserId}:" → own room, no DB lookup
    │     │
    │     ▼
    │   idFromName(roomKey) → YjsRoom DO
    │
    └── Room key starts with someone else's userId → shared room
          │
          ▼
        room_access lookup: WHERE room_key = ? AND user_id = ?
          │
          ├── No row → 403 Forbidden
          │
          └── Row found → idFromName(roomKey) → same YjsRoom DO
```

### Sharing Flow

```
SHARE A ROOM
════════════

  Owner (abc123): POST /rooms/tab-manager/share
    body: { email: "bob@example.com" }
    │
    ▼
  Look up user by email → userId = "xyz789"
  (404 if no user with that email)
    │
    ▼
  roomKey = "user:abc123:tab-manager"
  Verify requester owns room (roomKey prefix matches c.var.user.id)
    │
    ▼
  INSERT INTO room_access (room_key, user_id)
  VALUES ('user:abc123:tab-manager', 'xyz789')
  ON CONFLICT DO NOTHING
    │
    ▼
  Return { roomKey, sharedWith: { id: "xyz789", email: "bob@example.com" } }


ORG-BASED BULK SHARE (future, when org plugin is added)
═══════════════════════════════════════════════════════

  Owner (abc123): POST /rooms/tab-manager/share-with-org
    body: { orgId: "org-456" }
    │
    ▼
  For each member in org-456:
    INSERT INTO room_access (room_key, user_id, source, org_id)
    VALUES ('user:abc123:tab-manager', member.user_id, 'org', 'org-456')
    ON CONFLICT (room_key, user_id) DO NOTHING
```

## Database Schema

### `room_access` table

The core table for Phase 2 is minimal — just two columns that matter:

```sql
CREATE TABLE room_access (
  room_key    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW() NOT NULL,
  PRIMARY KEY (room_key, user_id)
);

CREATE INDEX room_access_user_id_idx ON room_access (user_id);
```

When org sharing is added in Phase 3, two nullable columns can be added:

```sql
ALTER TABLE room_access ADD COLUMN source TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE room_access ADD COLUMN org_id TEXT;
```

### Drizzle schema (Phase 2)

```typescript
export const roomAccess = pgTable(
  'room_access',
  {
    roomKey: text('room_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomKey, table.userId] }),
    index('room_access_user_id_idx').on(table.userId),
  ],
);
```

### Future columns (Phase 3, for org-derived sharing)

| Column | Purpose |
|---|---|
| `source` | `'direct'` (shared by owner) or `'org'` (derived from org membership). Enables selective revocation. |
| `org_id` | Non-null when `source = 'org'`. Enables bulk revocation: `DELETE WHERE org_id = ?`. |

These are inspiration for Phase 3, not requirements for Phase 2.

## Implementation Plan

### Phase 1: User-scoped room isolation (DONE)

- [x] **1.1** Prefix room keys with `user:{userId}:` in both route handlers
- [x] **1.2** Update YjsRoom JSDoc to document room isolation

### Phase 2: `room_access` table and sharing endpoints

- [ ] **2.1** Add `roomAccess` table to Drizzle schema (`db/schema.ts`) with relations
- [ ] **2.2** Run `bun x drizzle-kit generate` and `bun x drizzle-kit migrate`
- [ ] **2.3** Update `/rooms/:room` routes to check `room_access` when the room key doesn't belong to the requesting user
- [ ] **2.4** Add `POST /rooms/:room/share` endpoint — accepts `{ email }`, resolves to userId, inserts into `room_access`
- [ ] **2.5** Add `DELETE /rooms/:room/share/:userId` endpoint to revoke access
- [ ] **2.6** Add `GET /rooms/shared` endpoint to list rooms shared with the current user

### Phase 3: Org-derived sharing (when org plugin is added)

- [ ] **3.1** Add Better Auth `organization()` plugin to auth config
- [ ] **3.2** Add org/member/invitation tables to Drizzle schema
- [ ] **3.3** Add `source` and `org_id` columns to `room_access`
- [ ] **3.4** Add `POST /rooms/:room/share-with-org` endpoint that batch-inserts `room_access` rows with `source = 'org'`
- [ ] **3.5** Add webhook or hook for org member removal → `DELETE FROM room_access WHERE user_id = ? AND source = 'org' AND org_id = ?`

## Edge Cases

### Owner deletes their account

1. User `abc123` owns rooms keyed `user:abc123:*`
2. Account is deleted → `ON DELETE CASCADE` removes all `room_access` rows
3. The DOs still exist in Cloudflare but are unreachable (no one can construct the key)
4. DOs eventually expire via Cloudflare's idle eviction (no connections = no compute)
5. **Alternative**: Before deletion, transfer ownership by creating new DOs under a different user's key and migrating state. This is a product decision, not an architectural one.

### User has both direct and org-derived access (Phase 3)

1. User `xyz789` was directly shared `(room_key, xyz789)`
2. Org bulk-share attempts insert `(room_key, xyz789, 'org', 'org-456')` → `ON CONFLICT DO NOTHING`
3. Only the direct share row exists (it was first)
4. Org is removed → `DELETE WHERE source = 'org' AND org_id = 'org-456'` → no rows deleted (it was a direct share)
5. User retains access via their direct share
6. **This is correct behavior**: direct shares are intentional and should survive org changes

### Room key in URL is tampered with

1. User `xyz789` crafts a request for a room key belonging to `abc123`
2. Server checks: does room key start with `user:xyz789:`? No → check `room_access`
3. No row → 403. Knowing a room key doesn't grant access.

### WebSocket reconnection after share is revoked

1. User `xyz789` has an active WebSocket to a shared room
2. Owner revokes access (deletes `room_access` row)
3. The active WebSocket continues until it disconnects (DO doesn't know about access)
4. On reconnect, the access check rejects → 403
5. **Acceptable**: real-time revocation would require the DO to check access on every message, which breaks the clean separation. Eventual consistency (next reconnect) is fine.

### Share with nonexistent email

1. Owner tries to share with `nobody@example.com`
2. Server looks up email in `user` table → no result
3. Return 404 with clear error: "No user found with that email"
4. **No invite flow for now** — user must already have an account

## Open Questions

1. **How should the client route to shared rooms?**
   - The client currently sends `/rooms/{workspaceId}` using its own workspace ID. For shared rooms, it needs to send the owner's room key instead. Options: (a) client stores the full room key when accepting a share, (b) client fetches `GET /rooms/shared` on app open and caches room keys locally.
   - **Recommendation**: (b) — fetch on app open, cache in local state. The client treats shared rooms the same as personal rooms, just with a different room key.

2. **Should org-derived shares be eagerly inserted (batch insert on share) or lazily resolved (join at query time)?**
   - Eager: simpler access check (`SELECT FROM room_access WHERE ...`), but stale if org membership changes
   - Lazy: always current, but every access check joins against the member table
   - **Recommendation**: Eager insert with a hook on member removal to clean up. Simpler query path, acceptable staleness window.

3. **How should the client discover shared rooms?**
   - The client needs to know the room key to connect. Options: (a) API endpoint `GET /rooms/shared` returns list, (b) push notification on share, (c) both
   - **Recommendation**: Start with (a). The client polls or fetches on app open.

## Success Criteria

- [ ] Personal rooms work with zero DB lookup (already passing)
- [ ] Shared rooms require a valid `room_access` row
- [ ] Owner can share by email and unshare by userId
- [ ] Revoking access returns 403 on next connection attempt
- [ ] `GET /rooms/shared` returns all rooms shared with the current user
- [ ] TypeScript compiles: `bun run typecheck` in `packages/server-remote`
- [ ] YjsRoom DO has zero changes (only JSDoc updates)

## References

- `packages/server-remote/src/app.ts` — Worker routes, auth middleware, room key construction
- `packages/server-remote/src/yjs-room.ts` — Durable Object (unchanged by this spec)
- `packages/server-remote/src/db/schema.ts` — Drizzle schema, add `roomAccess` table here
- `packages/epicenter/src/extensions/sync.ts` — Client WebSocket URL construction
- `packages/epicenter/src/extensions/http-sync.ts` — Client HTTP sync URL construction
- `specs/20260307T000001-org-scoped-rooms.md` — Alternative approach (superseded by this spec)
