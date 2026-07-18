# Workspace document synchronization

This document describes the Proposed row-document destination and the Yjs 13
room service that remains deployed during the transition. The two protocols do
not interoperate.

## Proposed destination

An opened workspace has two independent synchronization planes:

```text
scalar rows and KV                 one opened row document
HTTP row-sync protocol             one Yjs 14 WebSocket
runtime-native SQLite              runtime-native Yjs update log
        |                                  |
        +---------- workspace authority ---+
```

Scalar synchronization keeps queryable JSON rows in SQLite. A row document is
lazy: opening it attaches local persistence, hydrates one `Y.Doc`, and then
opens one route-bound WebSocket for that document.

```text
/api/workspaces/:workspaceId/tables/:table/rows/:rowId/document
```

The route selects the workspace and row address. The client does not supply an
arbitrary room id, and the socket carries only that row document. If an
application opens three row documents, it owns three document sockets. Closing
the last local handle closes that document's socket and releases its in-memory
`Y.Doc`.

## Row document lifecycle

`table.document.open(rowId)` follows one order:

1. Check that the scalar row exists locally.
2. Create the Yjs 14 document and attach the runtime-native persistence
   provider before application writes can race hydration.
3. Replay the local update log and resolve local readiness.
4. Open the authenticated document socket for the structured route address.
5. Exchange a state vector and Yjs 14 `updateV2` bytes.

The returned handle exposes application-owned roots and transactions, local
durability, connection status, and disposal. It does not expose a room id,
provider ownership, or remote document settlement.

Local durability and network progress remain separate:

```ts
await document.whenDurable();
// Every document update observed before this call committed locally.

await workspace.sync.settle();
// Scalar rows and KV present at invocation settled through the authority.
// This does not wait for row-document sockets.
```

## Yjs 14 wire

The destination uses only `@y/y` 14. A new connection sends its state vector;
the authority returns the missing V2 state. Later edits travel as incremental
`updateV2` frames and apply with `applyUpdateV2`.

The document protocol has its own WebSocket subprotocol major. There is no Yjs
13 fallback, dual reader, provider peer override, or persisted-format migration.
Old Yjs 13 browser stores and server rooms may be discarded under the reset
policy.

Presence, when enabled, belongs to this one document socket. It is ephemeral,
never persisted into the `Y.Doc`, and never used as a correctness signal.

## Authority ownership

One account authority owns scalar state, row liveness, deletion markers, and
server document update logs for every workspace of one principal. The document
handler authenticates the upgrade credential and derives the authority address
from the principal alone; the route workspace id, table, and row id are
interpreted inside that authority. No catalog or authorization lookup exists.

Every connection and update checks row liveness:

- A live row may hydrate, connect, and append updates; admission rechecks
  liveness and loads committed state in one atomic snapshot.
- A row that is not live refuses or closes retryably with no reserved code
  and allocates no document state; the client's scalar plane owns the
  difference between "not yet synchronized" and "deleted" and revokes the
  open document when a deletion marker installs.
- There is no terminal document verdict. The authority enforces the compound
  document bound (canonical bytes and struct count, ADR-0146) exactly on the
  post-candidate state; the client estimates the same bound, reports one
  non-terminal `document-full` status, suppresses upstream frames while over
  it (downstream keeps applying), and resumes on its own when a measure comes
  back under. Close 1009 is a retryable backstop, not a verdict.

Row deletion removes the row, records a bounded deletion marker, and deletes
server document state in the same SQLite transaction. After commit, the
authority closes that row's sockets. Conforming runtimes never reuse a deleted
row id.

## Runtime-native persistence

The semantic provider contract is shared; the storage implementation is not.

| Runtime | Scalar storage | Document storage |
|---|---|---|
| Browser | OPFS SQLite in a Worker | One IndexedDB update-log database per workspace |
| Tauri/native | Native SQLite | Native SQLite or filesystem update log |
| Tests | In-memory SQLite | In-memory provider |

Browser documents live on the page because editors and Yjs shared types live
there. Scalar SQLite remains in the Worker. The independent durability barriers
avoid a page-to-Worker document-admission protocol.

## Deployed legacy during transition

Some applications still use the Yjs 13 root-document lane:

```text
openCollaboration(ydoc, { url: roomWsUrl(...) })
    -> /api/rooms/:roomId
    -> one principal-scoped room selected by ydoc.guid
```

That service currently uses unscoped `yjs`, `y-indexeddb`, lib0 framing, and
per-room server storage. It remains a description of deployed callers, not a
compatibility promise for the destination. Converted row-document clients use
the structured workspace route and Yjs 14 only. Once every caller moves, the
room route, providers, storage, protocol, and documentation are deleted
together.
