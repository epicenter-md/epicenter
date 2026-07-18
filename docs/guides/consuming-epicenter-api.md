# Consuming the Epicenter API

> **Transition status.** The SQLite row API is landing under
> `@epicenter/workspace/sqlite`. The Proposed row-document network path uses
> Yjs 14 and is not yet the only deployed path. Some applications still use the
> Yjs 13 `/api/rooms/:roomId` service described at the end of this guide. That
> service is replacement work, not a destination compatibility layer.

## Workspace model

An Epicenter workspace contains queryable scalar rows, one reserved KV row, and
one lazy collaborative document for each ordinary row.

```text
workspace
|-- table row
|   |-- stable row id
|   |-- queryable JSON fields
|   `-- lazy Yjs document
`-- workspace KV
```

Use scalar fields for facts that must remain queryable without hydrating a
CRDT. Use the row document for rich or collaborative structure whose concurrent
edits must merge. Use workspace KV for declared singleton values without row
identity or query needs.

Row deletion ends both the scalar row and its document lifetime. Deleted row
ids are never reused.

## Opened API

An imported workspace definition binds to one runtime:

```ts
const workspace = await runtime.open(definition);

const row = await workspace.tables.notes.create({ title: 'First note' });
using document = await workspace.tables.notes.document.open(row.id);

document.transact(() => {
	document.get('content').insert(0, 'Hello');
});

await document.whenDurable();
```

The opened handle exposes:

- `tables`: release-local validation and row operations over schema-opaque JSON;
- `kv`: declared singleton values;
- `sql`: arbitrary read-only SQL and runtime TEMP views over scalar state;
- `sync`: scalar synchronization status and a fixed-cut `settle()` barrier;
- `table.document.open(rowId)`: a lazy row-owned Yjs document.

`document.whenDurable()` covers local document persistence. `sync.settle()`
covers scalar rows and KV present when called. Neither promise impersonates the
other.

## Network addressing

Scalar row sync and row-document sync are independent protocols served by one
workspace authority.

```text
scalar rows
  /api/records/:workspaceId/...

one opened row document
  /api/workspaces/:workspaceId/tables/:table/rows/:rowId/document
```

Each open row document owns one authenticated Yjs 14 WebSocket. The route binds
the socket to a single structured row address; the connection does not carry an
arbitrary room id or any other document.

The bearer authenticates the principal, and the account authority derives
deterministically from that principal alone; the route workspace id is a name
inside the requester's own partition, and the remaining route selects the
table and row. The server checks row liveness before hydration and before
every persisted update. A row that is not live closes retryably with no
reserved code; the client's scalar plane owns the difference between "not yet
synchronized" and "deleted", and revokes the document when a deletion
installs. The only terminal document verdict is `too-large` (1009).

## Browser and native storage

The API contract is shared across runtimes, but the storage owners differ.

- Browser scalar rows live in OPFS SQLite inside a Worker. Open Yjs documents
  live on the page and persist through one Epicenter-owned IndexedDB update-log
  database per workspace.
- Tauri and other native hosts use native SQLite for scalar rows and a native
  Yjs update-log provider. Both stores may use SQLite without promising one
  cross-plane transaction.

The destination uses `@y/y` 14 `updateV2` storage and synchronization only. It
does not read old Yjs 13 IndexedDB stores or room logs.

## Deployed Yjs 13 lane

Applications awaiting conversion may still construct a root `Y.Doc`, attach
`y-indexeddb`, and call `openCollaboration()` with `roomWsUrl()`:

```text
ydoc.guid
  -> roomWsUrl({ baseURL, guid, nodeId })
  -> /api/rooms/:roomId
  -> principal-scoped Yjs 13 room
```

This is current deployment history, not the API to build new row-document
features against. Converted applications use SQLite for scalar rows and open
Yjs 14 documents through `table.document.open(rowId)`. The final cut removes
the room route and old provider family rather than maintaining dual wires.

## Canonical references

- [`packages/workspace/README.md`](../../packages/workspace/README.md): workspace
  API and runtime ownership.
- [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md):
  document lifecycle and wire boundary.
- [`docs/adr/0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md`](../adr/0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md):
  independent client planes.
- Proposed ADR-0145: workspace authority ownership. Its socket topology is
  being reconciled to one route-bound socket per open document.
- [`docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md`](../adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md):
  Yjs 14-only storage and wire.
