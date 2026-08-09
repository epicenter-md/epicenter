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

> **Related Skills**: See `svelte` for reading store data into a component, and `arktype` for the expression strings a Lens is written in.

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

## Store Connection

- Yjs is network-agnostic. It supplies CRDT state, state vectors, updates, and awareness behavior, not Epicenter's connection topology, authorization, or durability contract.
- One socket per application, not one per open document. A replica connects to `STORE_SYNC_ROUTE.pattern` (`/api/store/v1/sync`, in `packages/sync/src/store-route.ts`) with a `namespace` naming the Lens and a `cursor` naming its own durably applied position, so a reconnect is a catch-up rather than a fresh start (ADR-0222).
- Whose data it is never appears in the query. It comes from the resolved bearer, server-side, so there is no value a client can put in the URL that reaches another partition (ADR-0092).
- Browser upgrades authenticate through exactly one `bearer.<token>` subprotocol entry, because a browser upgrade cannot set `Authorization`; the mount echoes only the main subprotocol on the 101, so the token never round-trips. Non-browser clients may use an `Authorization` header. Do not use cookie-only upgrades, query-string credentials, or post-accept authentication frames.
- The wire is framing and nothing else: `push`, `ack`, `refuse`, `entry`, `offer`, `snapshot`, `wanted` (`packages/data/src/sync/frames.ts`). No frame knows what an update means, what a row is, or what Yjs is, which is exactly why chunking is safe at that layer.
- Large updates are chunked at `CHUNK_BYTES`, set by Cloudflare's documented Durable Object SQLite value cap rather than by anything about Yjs. Do not raise it to the measured wall; the documented limit is the one Cloudflare is entitled to enforce.
- Presence is deliberately absent until a concrete consumer earns awareness state and disconnect cleanup. If added later, awareness is ephemeral and must never be persisted into the Y.Doc or the SQLite update log as canonical data.

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

## Core Concepts

### Shared Types

Yjs provides six shared types. You'll mostly use three:

- `Y.Map` - Key-value pairs (like JavaScript Map)
- `Y.Array` - Ordered lists (like JavaScript Array)
- `Y.Text` - Rich text with formatting

The other three (`Y.XmlElement`, `Y.XmlFragment`, `Y.XmlText`) are for rich text editor integrations.

### Client ID

Every Y.Doc gets a random `clientID` on creation. Raw Yjs conflict ordering can
use this id, so concurrent writes to the same raw map key are not "latest
timestamp wins" unless the data structure adds its own timestamp policy.

```typescript
const doc = new Y.Doc();
console.log(doc.clientID); // Random number like 1090160253
```

From dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

The actual comparison in source ([updates.js#L357](https://github.com/yjs/yjs/blob/main/src/utils/updates.js#L357)):

```javascript
return dec2.curr.id.client - dec1.curr.id.client; // Higher clientID wins
```

This is deterministic (all clients converge to the same state) but not
intuitive: a later edit can lose. Design document roots around that fact.

It is also why a row's document container and its named roots are allocated when
the row is created rather than on first access: a write at a well-known address
lets two devices each mint their own type there, and map LWW discards one along
with everything written into it.

### Shared Types Cannot Move

Once you add a shared type to a document, **it can never be moved**. "Moving" an item in an array is actually delete + insert. Yjs doesn't know these operations are related.

## Critical Patterns

### 1. Single-Writer Keys (Counters, Votes, Presence)

**Problem**: Multiple writers updating the same key causes lost writes.

```typescript
// BAD: Both clients read 5, both write 6, one click lost
function increment(ymap) {
	const count = ymap.get('count') || 0;
	ymap.set('count', count + 1);
}
```

**Solution**: Partition by clientID. Each writer owns their key.

```typescript
// GOOD: Each client writes to their own key
function increment(ymap) {
	const key = ymap.doc.clientID;
	const count = ymap.get(key) || 0;
	ymap.set(key, count + 1);
}

function getCount(ymap) {
	let sum = 0;
	for (const value of ymap.values()) {
		sum += value;
	}
	return sum;
}
```

### 2. Fractional Indexing (Reordering)

**Problem**: Drag-and-drop reordering with delete+insert causes duplicates and lost updates.

```typescript
// BAD: "Move" = delete + insert = broken
function move(yarray, from, to) {
	const [item] = yarray.delete(from, 1);
	yarray.insert(to, [item]);
}
```

**Solution**: Add an `index` property. Sort by index. Reordering = updating a property.

```typescript
// GOOD: Reorder by changing index property
function move(yarray, from, to) {
	const sorted = [...yarray].sort((a, b) => a.get('index') - b.get('index'));
	const item = sorted[from];

	const earlier = from > to;
	const before = sorted[earlier ? to - 1 : to];
	const after = sorted[earlier ? to : to + 1];

	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	// Add randomness to prevent collisions
	const index = (end - start) * (Math.random() + Number.MIN_VALUE) + start;
	item.set('index', index);
}
```

### 3. Nested Structures for Conflict Avoidance

**Problem**: Storing entire objects under one key means any property change conflicts with any other.

```typescript
// BAD: Alice changes nullable, Bob changes default, one loses
schema.set('title', {
	type: 'text',
	nullable: true,
	default: 'Untitled',
});
```

**Solution**: Use nested Y.Maps so each property is a separate key.

```typescript
// GOOD: Each property is independent
const titleSchema = schema.get('title'); // Y.Map
titleSchema.set('type', 'text');
titleSchema.set('nullable', true);
titleSchema.set('default', 'Untitled');
// Alice and Bob edit different keys = no conflict
```

## Storage Optimization

### One Document, Nested Roots

An application is one `Y.Doc` (ADR-0215). Its roots are `tables:<name>` and `kv`,
and nothing else at the top level, so dumping `doc.share` reads as a description
of the application. SQLite holds the same facts as a query projection, never as a
second source of truth: every read a person makes comes from the `Y.Doc` already
in memory.

A row **is** a nested `Y.Type` attribute on its table root, and a field is an
attribute on the row. Holding one is what it means to exist, and removing it is
what deletion does; there is no second fact that can disagree.

The nesting is not stylistic. `Item.write` calls `findRootTypeKey`, a linear scan
of `doc.share`, so one root per row makes encoding quadratic in rows: measured at
5,417 ms for 20,000 rows against 13 ms nested.

```typescript
// Scalar fields are attributes on the row, written through the table.
db.notes.update(noteId, { title, pinned: true });
db.kv.update({ 'theme.mode': 'dark' });

// Prose never lives in a field. Each row owns a reserved container holding
// application-named roots, declared at create time so there is one creator.
db.notes.create({ title: '' }, { document: ['body'] });
const body = db.notes.document(noteId)?.get('body'); // a Y.Type an editor binds to
```

Only `Doc.get` mints. It is `setIfUndefined`, and a root can never be removed, so
every key reaching it must be a table name the Lens declares. Never pass a row id
to it: reading an unknown row through `getAttr` costs nothing, while a misspelled
table name costs a permanent root.

Use raw `Y.Map` for bounded, rarely changing structures inside a document root.
`Y.Map` tombstones retain the key forever, and every `ymap.set(key, value)`
creates a new internal item and tombstones the previous one, which is why
`gc: true` is what collapses a field edited 5,000 times down to two structs.

### Epoch-Based Compaction

If your architecture uses versioned snapshots, you get free compaction:

```typescript
// Compact a Y.Doc by re-encoding current state
const snapshot = Y.encodeStateAsUpdateV2(doc);
const freshDoc = new Y.Doc({ guid: doc.guid });
Y.applyUpdateV2(freshDoc, snapshot);
// freshDoc has same content, no history overhead
```

## Common Mistakes

### 1. Assuming Raw "Last Write Wins" Means Timestamps

It doesn't. Raw Yjs conflict ordering can use clientID, not wall-clock time.
Design document state around this or use single-writer keys. Scalar row and KV
conflicts belong to the SQLite row plane, not a Yjs LWW wrapper.

### 2. Using Y.Array Position for User-Controlled Order

Array position is for append-only data (logs, chat). User-reorderable lists need fractional indexing.

### 3. Forgetting Document Integration

Y types must be added to a document before use:

```typescript
// BAD: Orphan Y.Map
const orphan = new Y.Map();
orphan.set('key', 'value'); // Works but doesn't sync

// GOOD: Attached to document
const attached = doc.getMap('myMap');
attached.set('key', 'value'); // Syncs to peers
```

### 4. Storing Non-Serializable Values

Y types store JSON-serializable data. No functions, no class instances, no circular references.

### 5. Expecting Moves to Preserve Identity

```typescript
// This creates a NEW item, not a moved item
yarray.delete(0);
yarray.push([sameItem]); // Different Y.Map instance internally
```

Any concurrent edits to the "moved" item are lost because you deleted the original.

### 6. Working with Raw Y.js Types Outside Their Owning Module

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
import { parseSheetFromCsv } from './internal/sheet.js';
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

## Debugging Tips

### Inspect Document State

```typescript
console.log(doc.toJSON()); // Full document as plain JSON
```

### Check Client IDs

```typescript
// See who would win a conflict
console.log('My ID:', doc.clientID);
```

### Watch for Tombstone Bloat

If documents grow unexpectedly, check for:

- Frequent Y.Map key overwrites
- "Move" operations on arrays
- Missing epoch compaction or a runtime doc accidentally created with `gc: false`

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
- `packages/data/src/store/document.ts`: the document grammar (roots, row types, field reads, and the reserved document container)
- `packages/data/src/store/persistence.ts`: the SQLite relations that durably store the update log and the projection
- `packages/data/src/sync/`: the Yjs 14 wire (frames, connection, client, authority)
- [ADR-0215](../../../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md): one document per application, and the container a row owns
- [ADR-0221](../../../docs/adr/0221-a-table-names-the-rows-a-commit-touched-and-says-so-after-the-projection-commits.md): what `subscribe` reports and when it fires
- [ADR-0146](../../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only persistence decision
- [ADR-0159](../../../docs/adr/0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md): one owner-side SQLite update log and shared attachment seam
