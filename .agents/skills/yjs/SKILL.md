---
name: yjs
description: 'Yjs 14 CRDT patterns for Epicenter row documents: @y/y shared types, transactions, updateV2 persistence, row-addressed synchronization, awareness, conflict resolution, and document storage. Use when mentioning Yjs, Y.Doc, CRDTs, collaborative editing, awareness, owner-side SQLite document persistence, row documents, or Yjs providers.'
metadata:
  author: epicenter
  version: '1.0'
---

# Yjs 14 CRDT Patterns
## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework for shared editing and offline-first data
- [Yjs Protocols](https://github.com/yjs/y-protocols): algorithmic grounding for sync and awareness

## Upstream Grounding

When conflict semantics, transaction origins, shared-type behavior, update encoding, storage growth, or shared-type APIs affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `yjs/yjs`; for sync and awareness algorithms, ask against `yjs/y-protocols`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against the locally pinned `@y/y` types and source before changing code.

Epicenter targets `@y/y` 14 only. Do not add `yjs` 13, `y-indexeddb`, a compatibility reader, a package alias, a dual wire, or a fallback. Existing Yjs 13 code is replacement material, not a compatibility surface.

Skip DeepWiki for stable basics and repo-local patterns already documented below.

Read [references/document-design.md](references/document-design.md) before
choosing how a new row document is structured. Counters, user-controlled
ordering, and nested shapes each have a conflict behavior that is expensive to
change once data exists.

Read [references/debugging.md](references/debugging.md) when a document
converges to unexpected state or grows faster than its content.

> **Related Skills**: See `workspace-api` for the workspace abstraction built on Yjs.

## Transactions, Origins, And Undo

- Yjs updates are commutative and idempotent. Custom sync and persistence layers should use state vectors instead of inventing ordering guarantees.
- Use `Y.encodeStateVector(doc)` to describe local clocks, then `Y.encodeStateAsUpdateV2(doc, remoteStateVector)` to send only missing updates.
- Persist and transmit bytes from the `updateV2` event. Replay them with `Y.applyUpdateV2(doc, update, origin)`.
- Wrap multi-write user actions in `doc.transact(() => { ... }, origin)`. This reduces observer churn and gives persistence, providers, and undo logic a useful origin.
- Treat transaction origins as the boundary for filtering provider echoes, app-authored operations, and undo tracking.
- Scope `Y.UndoManager` to concrete shared types. Set `trackedOrigins`, tune `captureTimeout`, and call `stopCapturing()` between logically separate commands.
- Use relative positions for collaborative cursor and selection anchors. Raw numeric indexes drift under remote edits.
- `Y.snapshot()` is a historical marker that depends on retained delete history. `Y.encodeStateAsUpdateV2(doc)` is the self-contained checkpoint format.
- Prefer separate top-level docs over Yjs subdocuments unless Epicenter owns the whole provider lifecycle for the subdoc path.

## Row Document Connection

- Yjs is network-agnostic. It supplies CRDT state, state vectors, updates, and awareness behavior, not Epicenter's connection topology, authorization, row lifecycle, or durability contract.
- Each currently open row document uses one authenticated WebSocket at `/api/workspaces/:workspaceId/tables/:table/rows/:rowId/document`. Do not create an arbitrary room id or a mutable multiplex subscription set.
- Authenticate the bearer into a principal. The account authority derives deterministically from that principal alone (ADR-0092: the principal is the partition and the actor); the route workspace id is a name inside the requester's own partition. There is no catalog, grant, or authority key.
- The structured `(workspaceId, table, rowId)` route address selects one lifecycle-bound document inside the account authority. The address is a name, not a secret or capability. Check row liveness atomically with committed-state load on admission and again on every persisted update.
- Select the exact `epicenter-document-v3` WebSocket subprotocol. Binary messages carry only `sync-request(stateVector)`, `sync-response(updateV2)`, and `update(updateV2)`. Both peers request missing state. Do not add an envelope fact already owned by the route, subprotocol, WebSocket boundary, close code, state vector, or update bytes.
- There is no terminal document close verdict. The authority enforces the shared compound bound (`DOCUMENT_BOUND`: canonical encoded bytes and decoded struct count) exactly on the post-candidate state; the client measures the same bound, suppresses every upstream update-bearing frame while over it (including its deferred handshake reply), keeps applying downstream, and resumes automatically when a measure comes back under. Close 1009 is a retryable defensive backstop, never a product state. A row that is not live refuses or closes retryably with no reserved code; the client's scalar plane owns pending-versus-deleted knowledge and revokes the document when a deletion marker installs. Do not encode lifecycle verdicts as Yjs binary frames.
- On Cloudflare, serialize the socket's complete fixed address within the 16,384 byte hibernation attachment limit and fan out by enumerating the actor's sockets and comparing complete attachment addresses. No tag index until measured socket counts earn one. The server retains no live Y.Doc; hydrate disposable committed state per admission and acceptance.
- Reconnect with the same structured route and repeat state-vector exchange. Do not add durable subscription recovery or multiplexing until measured open-document socket pressure earns that machinery.
- Use state-vector exchange followed by incremental `updateV2` messages instead of exchanging complete documents by default.
- Presence is deliberately absent from document v3 until a concrete consumer earns awareness state, disconnect cleanup, and a later protocol major. If added later, awareness is ephemeral and must never be persisted into Y.Doc or the SQLite update log as canonical data.
- Browser upgrades authenticate through exactly one `bearer.<token>` subprotocol entry. Non-browser clients may instead use an `Authorization` header. Do not use cookie-only upgrades, query-string credentials, or post-accept authentication frames.
- Authentication, deterministic authority resolution, and row liveness are three distinct facts with one surface. Row liveness is a lifecycle invariant, not a second per-row authorization system.

## Owner-Side SQLite Persistence

Row documents persist beside scalar facts in the same Data-owned SQLite
database. `document_updates` stores the Yjs 14 update chain at the exact
`(namespace, table_name, row_id)` address. `document_publication` stores the
durable outbound obligation for locally authored document work. The browser
Worker owns its OPFS SQLite database, the Bun runtime owns its native database,
and the desktop WebView borrows the Bun owner over the Data desktop protocol.
Do not add a separate IndexedDB provider or a second document store.

- `createDocumentRuntime` owns live `Y.Doc` handles, durable append and compaction, explicit pull, capture, publication settlement, and revocation.
- Attach the `updateV2` listener before hydration. Replay stored updates with a private hydration origin so loading cannot append the same bytes again.
- A locally authored append stores copied update bytes and advances `document_publication.revision` in the same SQLite transaction. Authority-accepted bytes use `acceptedDocumentOrigin` and create no outbound obligation.
- Check row liveness inside the append transaction. A late write after scalar deletion must fail rather than resurrect document content.
- Scalar row deletion removes the update chain and publication obligation in the same replica transaction, then revokes any live handle.
- Compact a bounded chain by replaying it into a fresh `gc: true` document and replacing the covered updates with one complete V2 state update. Compaction does not remove modeling costs inside the encoded document.
- Pull and publication are separate operations. Pulling accepted state never marks it as local work; publishing captures current complete state with the revision it covers and settles only that revision.
- Treat replay corruption or transaction failure as storage failure. Revoke the live handle rather than allowing memory to diverge from durable SQLite state.

## Storage Optimization

### Y.Map vs Scalar Rows

`Y.Map` tombstones retain the key forever. Every `ymap.set(key, value)` creates a new internal item and tombstones the previous one.

Do not use one workspace-wide Y.Doc as the row or KV database. Scalar tables and
KV live in runtime-native SQLite so large record sets remain queryable without
hydrating one CRDT graph into memory. Yjs is reserved for lazy row documents.

```typescript
// Scalar data stays on the row plane.
workspace.tables.notes.set(note);
workspace.kv.set('theme.mode', 'dark');

// Keyed collaborative content may live inside one opened row document.
using messages = workspace.tables.conversations.docs.messages.open(id);
messages.set(message.id, message);
```

Use raw `Y.Map` for bounded, rarely changing structures inside a private
attachment. Use workspace tables and KV for scalar keyed data. Existing
`YKeyValueLww` table and KV code is legacy replacement work; do not extend it or
describe it as the final scalar storage model.

## Working with Raw Y.js Types Outside Their Owning Module

Y.js shared types (`Y.Map`, `Y.Text`, `Y.XmlFragment`, `Y.Array`) are implementation details that should stay behind typed APIs. When consumer code reaches through an abstraction to manipulate raw shared types, it creates coupling that's hard to change later.

**The pattern**: If a module returns Y.js shared types for editor binding (e.g., `handle.asText()` returns `Y.Text`), that's intentional: the consumer needs the live CRDT reference. But if consumer code is *constructing*, *casting*, or *mutating* Y.js types that the owning module should encapsulate, that's a leak.

```typescript
// BAD: consumer reaches through handle to do raw Y.Text mutation
const entry = handle.currentEntry;
if (entry?.type === 'text') {
    handle.batch(() => entry.content.insert(entry.content.length, text));
}

// GOOD: timeline owns the append operation
handle.append(text);
```

```typescript
// BAD: consumer constructs Y.Maps to call an internal CSV helper
import { parseSheetFromCsv } from '@epicenter/workspace';
const columns = new Y.Map<Y.Map<string>>();
const rows = new Y.Map<Y.Map<string>>();
parseSheetFromCsv(csv, columns, rows);

// GOOD: use the handle's write method, which encapsulates CSV parsing
handle.write(csv);  // mode-aware, handles sheet internally
```

### How to Spot Abstraction Leaks

These are code smell indicators that Y.js internals are leaking:

- **Type assertions**: `as Y.Map`, `as Y.Text`, `as Y.XmlFragment` outside the owning module means someone is working with untyped data and forcing it into shape. The typed API is incomplete.
- **Mode branching**: `if (entry.type === 'text') ... else if (entry.type === 'sheet')` in consumer code means the consumer knows about internal content modes that the abstraction should handle.
- **Raw mutations in batch callbacks**: `handle.batch(() => ytext.insert(...))` means the consumer is doing CRDT operations that should be a method on the handle.
- **Internal helper re-exports**: Functions that take `Y.Map<Y.Map<string>>` parameters on a public API force consumers to have raw Y.js references to call them.
- **`ydoc.getArray()`/`ydoc.getMap()` outside infrastructure**: Consumer code accessing the raw Y.Doc to read/write data bypasses the table/kv/timeline APIs.

### The Boundary Rule

Three layers, each with clear Y.js exposure:

```
┌──────────────────────────────────────────────────────┐
│  Consumer Code (apps, features)                      │
│  • Uses row document handles and typed root APIs     │
│  • MAY bind to Y.Text/Y.XmlFragment from as*()      │
│  • NEVER constructs Y.js types                       │
│  • NEVER casts to Y.js types                         │
│  • NEVER calls .insert()/.delete() on raw types      │
├──────────────────────────────────────────────────────┤
│  Format Bridges (markdown, sheet converters)          │
│  • Accepts Y.js types as parameters (they're bridges)│
│  • Converts between Y.js ↔ string/JSON               │
│  • Lives close to the owning module                   │
├──────────────────────────────────────────────────────┤
│  Row Document Internals                               │
│  • Constructs and manages Y.js shared types           │
│  • Owns the Y.Doc layout (array keys, map structure)  │
│  • Exposes typed APIs that hide the CRDT details      │
└──────────────────────────────────────────────────────┘
```

When reviewing code, ask: "Could this consumer do its job with only the typed API?" If yes and it's using raw Y.js types instead, that's a leak worth fixing.

See the article `docs/articles/yjs-abstraction-leaks-cost-more-than-the-abstraction.md` for the full pattern with real examples.

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
- `packages/data/src/documents.ts`: the row-document runtime (load, append, compaction, capture, deletion, and publication obligations)
- `packages/data/src/replica/schema.ts`: the SQLite relations that durably store document updates and publication state
- `packages/sync/src/document-v3/`: the Yjs 14 row-document wire
- [ADR-0145](../../../docs/adr/0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md): workspace authority and document connection ownership
- [ADR-0146](../../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only persistence decision
- [ADR-0159](../../../docs/adr/0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md): one owner-side SQLite update log and shared attachment seam
