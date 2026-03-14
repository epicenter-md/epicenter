# Split YjsRoom into WorkspaceRoom + DocumentRoom

**Status:** In Progress — Wave 1 complete

**Supersedes:** [20260307T000000-split-yjsroom-workspace-document.md](./20260307T000000-split-yjsroom-workspace-document.md)

## Context

We currently have a single `YjsRoom` Durable Object class serving both workspace metadata docs and content documents. Both use `gc: true` (the Y.Doc default). We want to split this into two classes so that content documents can use `gc: false` with lightweight metadata snapshots for version history.

## Why split

Workspace rooms and document rooms have genuinely different requirements:

| Concern | Workspace | Document |
|---|---|---|
| **Content** | Structured metadata (tables, KV, awareness) | Text / rich text |
| **GC setting** | `gc: true` — keep docs small | `gc: false` — preserve delete history for snapshots |
| **Version history** | Not needed | Yes — Google Docs-style revisions |
| **Snapshot strategy** | N/A | Lightweight metadata snapshots (~7 bytes to ~1.5KB each) |
| **Doc size profile** | Small, bounded (~1.5x raw content) | Larger, grows with edit history (2-5x raw content) |

The gc setting is the fundamental divergence. Everything else follows from it.

## Research findings

### Lightweight metadata snapshots are absurdly cheap

`Y.snapshot(doc)` returns a state vector + delete set — pure metadata, no content. Measured sizes:

| Scenario | Snapshot size |
|---|---|
| 1 client, no deletes | 7 bytes |
| 1 client, with deletes | 18 bytes |
| 10 clients, heavy editing | 62 bytes |
| 50 clients, heavy editing | ~800 bytes |
| 100 clients, heavy editing | ~1.5 KB |

100 snapshots for a 50-client document = ~80 KB total. Fits trivially in SQLite.

### The `gc: true` full-snapshot alternative is far more expensive

With `gc: true`, version history requires `Y.encodeStateAsUpdateV2(doc)` per snapshot — the full document state, ~160 KB for a substantial doc. 100 versions = ~16 MB. Large documents could exceed the 2 MB per-row BLOB limit, requiring R2 overflow. With `gc: false` metadata snapshots, you store the history once in the live doc and snapshots are just bookmarks into it.

### Update compaction is fully compatible with `gc: false`

`Y.mergeUpdatesV2` deduplicates and compacts the binary update encoding. When the merged result is applied to a `gc: false` Y.Doc, all structs are preserved in the store. `Y.createDocFromSnapshot(doc, snapshot)` reads from the struct store and works identically whether the doc was built from merged or individual updates.

The existing cold-start compaction logic works unchanged for `DocumentRoom`. The merged blob is larger (preserves delete structures) but well under 2 MB for practical documents.

### `gc: false` growth is your version history

The "unbounded growth" concern with `gc: false` is real — the doc retains deleted item structures (content cleared, structure preserved), growing 2-5x the raw content size for heavily-edited documents. But this IS the version history. With `gc: true`, you'd store equivalent data redundantly across N full snapshots. The `gc: false` approach pays once; the `gc: true` approach pays N times.

## Architecture

### Two DO classes, shared foundation

Both classes share identical:
- WebSocket Hibernation API lifecycle
- Append-only SQLite update log with cold-start compaction via `Y.mergeUpdatesV2`
- RPC methods: `sync(body)`, `getDoc()`
- Connection state management and awareness

`DocumentRoom` adds:
- `gc: false` on the Y.Doc
- `snapshots` table in SQLite for lightweight metadata snapshots
- Snapshot RPC methods: `saveSnapshot()`, `listSnapshots()`, `getSnapshot()`, `restoreSnapshot()`

### Code sharing strategy

Extract the shared foundation into a base class or composition helper. Both DO classes delegate to it.

**Option A — Base class:**
```typescript
// base-room.ts
export class BaseYjsRoom extends DurableObject {
  // All current YjsRoom logic, parameterized by gc setting
  constructor(ctx, env, options: { gc: boolean }) { ... }
}

// workspace-room.ts
export class WorkspaceRoom extends BaseYjsRoom {
  constructor(ctx, env) { super(ctx, env, { gc: true }); }
}

// document-room.ts
export class DocumentRoom extends BaseYjsRoom {
  constructor(ctx, env) { super(ctx, env, { gc: false }); }
  // + snapshot table, snapshot RPCs
}
```

**Option B — Composition (factory helpers):**
Extract `initYjsDoc`, `handleSync`, `handleWsLifecycle` as standalone functions. Each DO class calls them in its constructor and methods. More flexible, less coupled.

Prefer Option A for simplicity — the shared surface is large enough that a base class avoids duplication without overcomplicating things. Option B is better if the classes diverge significantly later.

### SQLite schema

**WorkspaceRoom** (unchanged from current YjsRoom):
```sql
CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL
)
```

**DocumentRoom:**
```sql
CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL
)

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL,        -- Y.encodeSnapshot() output (~7 bytes to ~1.5 KB)
  label TEXT,                 -- optional user-facing label ("Auto-save", "Before refactor")
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

No R2 needed. Everything fits in SQLite.

### Snapshot RPCs on DocumentRoom

```typescript
/** Save a lightweight metadata snapshot of the current doc state. */
async saveSnapshot(label?: string): Promise<{ id: number; createdAt: string }> {
  const snap = Y.snapshot(this.doc);
  const encoded = Y.encodeSnapshot(snap);
  // encoded is ~7 bytes to ~1.5 KB
  const row = sql.exec(
    `INSERT INTO snapshots (data, label) VALUES (?, ?) RETURNING id, created_at`,
    encoded, label ?? null
  ).one();
  return { id: row.id, createdAt: row.created_at };
}

/** List all snapshots (metadata only, no reconstruction). */
async listSnapshots(): Promise<Array<{ id: number; label: string | null; createdAt: string }>> {
  return [...sql.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC')];
}

/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
  const row = sql.exec('SELECT data FROM snapshots WHERE id = ?', snapshotId).toArray();
  if (row.length === 0) return null;

  const snap = Y.decodeSnapshot(new Uint8Array(row[0].data));
  const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
  return Y.encodeStateAsUpdateV2(restoredDoc);
}

/** Restore: apply a past snapshot's state as the current doc. */
async restoreSnapshot(snapshotId: number): Promise<boolean> {
  const past = await this.getSnapshot(snapshotId);
  if (!past) return false;

  // Save a "before restore" snapshot for undo
  await this.saveSnapshot('Before restore');

  // Apply the past state — Yjs merge semantics handle this correctly
  Y.applyUpdateV2(this.doc, past, 'restore');
  return true;
}
```

### Auto-snapshot triggers

Save snapshots automatically at natural quiescence points:

1. **On last client disconnect** — when the last WebSocket closes, save an auto-snapshot.
2. **On alarm** (optional, Phase 2) — periodic snapshots via DO alarms for long editing sessions. Configure interval per use case (e.g., every 10 minutes of activity).

The disconnect trigger is simplest and covers the common case: user edits, closes tab, snapshot is saved. Alarms add periodic safety for marathon sessions.

### Routes

```
GET  /workspaces/:room       → WorkspaceRoom (WebSocket upgrade or snapshot bootstrap)
POST /workspaces/:room       → WorkspaceRoom (HTTP sync)

GET  /documents/:room        → DocumentRoom  (WebSocket upgrade or snapshot bootstrap)
POST /documents/:room        → DocumentRoom  (HTTP sync)

POST /documents/:room/snapshots           → DocumentRoom.saveSnapshot()
GET  /documents/:room/snapshots           → DocumentRoom.listSnapshots()
GET  /documents/:room/snapshots/:id       → DocumentRoom.getSnapshot()
POST /documents/:room/snapshots/:id/restore → DocumentRoom.restoreSnapshot()
```

Keep `/rooms/:room` as a temporary alias for `/workspaces/:room` during the client rollout. Remove after all clients are updated.

### Wrangler migration

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "WORKSPACE_ROOM", "class_name": "WorkspaceRoom" },
    { "name": "DOCUMENT_ROOM", "class_name": "DocumentRoom" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["YjsRoom"] },
  {
    "tag": "v2",
    "renamed_classes": [{ "from": "YjsRoom", "to": "WorkspaceRoom" }],
    "new_sqlite_classes": ["DocumentRoom"]
  }
]
```

`renamed_classes` preserves all existing YjsRoom instance data. Existing workspace rooms continue working seamlessly. Existing document data that was stored in YjsRoom instances becomes orphaned in WorkspaceRoom — it won't be accessed by new clients (they'll connect to DocumentRoom), and Cloudflare auto-evicts inactive DOs.

### Client changes

The sync extension (`packages/epicenter/src/extensions/sync.ts`) needs a way to target the correct room type. The sync URL construction changes based on whether this is a workspace or document connection:

```typescript
// Workspace sync: /workspaces/{roomName}
createSyncExtension({ baseUrl: `${API_URL}/workspaces` })

// Document sync: /documents/{roomName}
createSyncExtension({ baseUrl: `${API_URL}/documents` })
```

The client already distinguishes workspace vs document Y.Docs at the extension layer — workspace extensions run on the workspace Y.Doc, document extensions run on content Y.Docs via `withDocumentExtension()`. The URL change slots in naturally.

### Client document `gc: false` alignment

The client already creates content Y.Docs with `gc: false` (`create-document.ts` line 235). The server's DocumentRoom now matches. WorkspaceRoom uses `gc: true`, matching the client's workspace Y.Doc (default gc). No client gc changes needed.

## Implementation plan

### Wave 1 — Extract base, split classes (server only)

- [x] **1.1** Create `base-room.ts` with the shared YjsRoom foundation, parameterized by `{ gc: boolean }`
  > Added `onInit()` and `onLastDisconnect()` hooks for subclass customization.
- [x] **1.2** Create `workspace-room.ts` extending base with `gc: true` (functionally identical to current YjsRoom)
- [x] **1.3** Create `document-room.ts` extending base with `gc: false`, adding `snapshots` table and snapshot RPCs
  > Auto-saves snapshot on last disconnect via `onLastDisconnect()` hook.
- [x] **1.4** Update `app.ts` with new routes (`/workspaces/:room`, `/documents/:room`, snapshot endpoints)
- [x] **1.5** Keep `/rooms/:room` as alias for `/workspaces/:room`
- [x] **1.6** Update `wrangler.jsonc` with v2 migration
- [x] **1.7** Re-export both classes from `app.ts` for wrangler types
- [x] **1.8** Delete `yjs-room.ts`

### Wave 2 — Client routing

1. Update sync extension to accept room type (workspace vs document)
2. Wire workspace extensions to `/workspaces/` and document extensions to `/documents/`
3. Remove `/rooms/:room` alias after client rollout

### Wave 3 — Snapshot UI (future, not in scope)

1. Auto-snapshot on last disconnect
2. Snapshot list/restore UI in the editor
3. Editor-layer diffing (CodeMirror `@codemirror/merge`, TipTap `prosemirror-recreate-steps`)

## Room key namespacing decision

> **Update (2026-03-13):** DO names now include a type segment: `user:{userId}:{type}:{name}` where `{type}` is `workspace` or `document`. The user-scoped decision and org-scoping rationale below are unchanged. See `20260313T201800-do-naming-convention.md`.


We keep user-scoped room keys: `user:{userId}:{workspaceId}`. We evaluated two alternatives and rejected both.

### Alternative 1: Org-scoped (`org:{orgId}:{workspaceId}`)

The Vercel/Supabase/PlanetScale model: every resource belongs to an org, users always have a personal org. Better Auth's organization plugin provides members, roles, invitations, `activeOrganizationId` on session.

Rejected because most Epicenter workspaces hold personal data. Whispering recordings, Entries, tab manager state: none of these should merge into a shared Y.Doc when two users are in the same org. Org-scoped would require a per-workspace `scope: 'user' | 'org'` flag, meaning you'd end up with `org:{orgId}:user:{userId}:{workspaceId}` for personal workspaces anyway. Two prefixing schemes instead of one, plus the org infrastructure overhead.

### Alternative 2: Org as outer boundary (`org:{orgId}:user:{userId}:{workspaceId}`)

Embeds org management in the application layer. Rejected because for self-hosted enterprise deployments, the server itself IS the org boundary. GitLab, Outline, and Mattermost all work this way: everyone who can authenticate to the server is implicitly in the org. No org table, no member table, no invitation flow. The deployment boundary provides the isolation that the org prefix would have provided.

This means org/tenant management is a platform-layer concern for our cloud multi-tenant offering, not an app-layer concern. Adding it at the routing/deployment layer later doesn't require changing room key construction or the app's data model.

### Chosen: User-scoped with future ACL sharing (Google Docs model)

Every workspace has an owner. Room key is always `user:{ownerId}:{workspaceId}`. Sharing (when implemented) grants other users access to the owner's DO via an ACL table, without changing the room key. This matches Google Docs: every document has a globally unique identifier (the owner's room key), sharing is an access control concern, and "transfer ownership" means updating the ACL plus migrating the DO key.

See `docs/articles/user-owned-rooms-not-org-scoped.md` for the full analysis.

## Risks and mitigations

**Risk: `gc: false` docs grow large for heavily-edited documents.**
Mitigation: The growth IS the version history — you'd store equivalent data as full snapshots under `gc: true`. For pathological cases (multi-MB docs), the segmented compaction note in the existing codebase applies. Monitor doc sizes in production.

**Risk: Compacted blob exceeds 2 MB for `gc: false` docs.**
Mitigation: Unlikely for practical content documents. A 2 MB Yjs blob represents enormous text with extensive edit history. If hit, the existing skip-compaction fallback works (individual update rows are small). Segmented compaction is the YAGNI escape hatch.

**Risk: Old document data orphaned in WorkspaceRoom after migration.**
Mitigation: Clients will create new DocumentRoom instances on first connect. Old WorkspaceRoom instances are auto-evicted by Cloudflare after extended inactivity. No manual cleanup needed. No data loss — the client's IndexedDB has a full copy.

**Risk: `Y.createDocFromSnapshot` performance on large `gc: false` docs.**
Mitigation: It iterates the struct store up to the snapshot's state vector — O(N) in number of structs. For a 500 KB doc, this is fast (milliseconds). Profile if docs approach multi-MB territory.
