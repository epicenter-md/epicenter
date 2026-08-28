# 0238. The live document is the truth while open, and persistence is a visible debt

- **Status:** Accepted
- **Amended by:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) at the outbox. Acceptance and durability still split and durability is still a visible debt; what a replica owes the authority is no longer a durable queue, because it asks rather than remembers.
- **Date:** 2026-08-12
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0238 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0237](0237-nonconformance-is-a-reads-only-error-and-a-disposed-store-throws.md)
  at the storage arm: the `storage-failed` poison is withdrawn, and an unusable
  store now means only a disposed one. `QueryFailed` widens by one cause: a
  stale read index whose rebuild failed refuses the statement through the same
  error, because "this statement got no trustworthy answer" is one outcome
  however it came about.
  [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at
  the mechanism of two atomicity rules: bytes-with-cursor and stamp-before-push
  are now guaranteed by one ordered queue flushed whole, rather than by each
  verb owning its own SQLite transaction.
- **Relates:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md)
  (which documents exist and where), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)
  (the client owns the store).

## Context

The store treated a refused durable commit as the death of the process's data
plane: the first failed SQLite transaction poisoned the store and every later
verb threw `StoreUnusableError('storage-failed')`. ADR-0237 gave that
discipline its honest channel, and in doing so made it policy.

That lifetime model is rejected. A live Yjs document does not become untrust-
worthy because a disk write failed; the person's edit is in memory, every read
serves it, and every other replica can still receive it. Poisoning the store
converted a storage problem into forced data loss: the one copy that was
certainly good, the live document, was made unreachable.

Meanwhile the two runtimes disagreed about what a write even was:

- The browser store was already write-behind. Verbs committed into an
  in-memory SQLite, and a checkpoint of the whole file was copied into
  IndexedDB after each commit. A failed checkpoint set a sticky
  `durability(): { healthy: false }` that no later success cleared, and
  nothing in any app rendered it.
- The Bun store made the durable write synchronously inside the verb, so a
  refusal had a call site to poison.

So the browser already lived the truth this record adopts, without admitting
it: an open client's reads came from the live document, durability was
best-effort behind it, and a persistence failure lost nothing until the page
closed. What it lacked was an honest status, recovery, and a durable layout
that was more than a snapshot of somebody else's file format.

The truth to make explicit:

```text
live process: Yjs state is authoritative now
restart:      only successfully persisted state is recovered
```

If persistence stays unavailable and the client closes, edits that existed
only in memory are lost. That is accepted. Hiding it is not.

## Decision

**Accepting an edit and recording it durably are two steps. Acceptance is
synchronous and cannot fail for storage reasons: the live Yjs document and the
SQL projection update immediately. Durable recording is an ordered queue of
work the store owes its own storage, flushed whole and atomically, with one
observable status. Sync sends only what is durably recorded.**

### Two debts, never conflated

```text
local-persistence debt: has this client written the update durably?
  private in-memory queue -> durable update log

sync-delivery debt: has the authority accepted an already durable local update?
  durable outbox -> server acknowledgement
```

A local edit is never offered to the authority merely because it is visible in
memory. The sender reads only the durable outbox, and acknowledgement removes
only durable outbox work. Offline is a sync fact; blocked is a persistence
fact; the two statuses never share a channel.

### The persistence surface

```ts
type PersistenceStatus = 'saved' | 'pending' | 'blocked';

store.persistence.get(): PersistenceStatus;
store.persistence.subscribe(listener: () => void): () => void;
store.persistence.flush(): Promise<void>;
```

`saved`: nothing accepted remains only in memory. `pending`: a flush is
requested or in flight. `blocked`: the latest flush failed and a restart would
lose the retained work. `flush()` requests one attempt over everything
outstanding and resolves when the controller settles, whatever the outcome;
the outcome is `get()`'s answer. `subscribe` fires on status change.

Deliberately absent: queued-update counts, a `retrying` state, raw causes, and
storage-engine detail. The cause of a failed flush goes to the store's logger.
The status is document-wide, not per table, because the queue is one ordered
sequence for the whole document. This surface replaces the browser store's
`durability()` and `whenDurable()`, which are deleted.

There is no autonomous retry loop. Every accepted edit requests one coalesced
flush attempt; a blocked store is retried by the next edit, by an explicit
`flush()`, or by whatever lifecycle moment an application chooses to wire.

### One queue, flushed whole

Each store owns a private controller: an ordered queue of durable operations
(append update to the log, also enqueue it in the outbox, advance the cursor,
drop or replace outbox entries, stamp the document identity) and a mirror of
what the durable engine has confirmed. A flush hands the entire queue to the
storage port as one atomic batch: all of it commits or none of it does. On
success the ops leave the queue and the mirror advances; on failure everything
stays queued, in order, and the status reports blocked. Ops accepted during an
in-flight flush join the next batch.

Whole-queue atomicity is what carries ADR-0231's two invariants without
per-verb transactions:

- **Bytes with cursor.** A remote entry's log append and its cursor advance
  are adjacent ops in one batch, so durable state never holds a cursor ahead
  of the bytes it accounts for. A remote update may be live before it is
  durable; a crash then simply re-receives it, and updates are idempotent.
- **Stamp before push.** The identity stamp is queued before any append that
  follows it, and the sender reads only the durable outbox, so no push can
  leave before the stamp is durable: a durable outbox entry structurally
  implies a durable identity. The old browser checkpoint left this window
  open (the stamp was durable only when the next checkpoint happened to
  land); the queue closes it.

On a synchronous storage port (Bun's file SQLite, a Durable Object's SQLite)
the flush attempt runs inside the accepting verb, so a successful write is
durable when the verb returns, exactly as before. On an asynchronous port
(IndexedDB) the attempt starts immediately and bursts coalesce into the next
batch. `onLocalWork` fires when a flush durably grows the outbox, because that
is the moment the transport has something it may send.

### The read index rebuilds or refuses

The SQL projection is the third surface acceptance touches, and it gets the
same discipline as durability: its failure is contained, never the verb's.

```text
projection write succeeds -> index stays fresh
projection write fails    -> keep the Yjs edit, log the cause, mark stale
next query(...) on stale  -> rebuild the WHOLE index from live Yjs, then run
rebuild fails             -> QueryFailed; nothing served from the stale cache
```

A failed projection write cannot fail a table or KV verb, cannot keep the
edit's bytes (or a remote update's bytes and cursor) out of the durable
queue, and cannot poison anything. While stale, per-edit projection writes
are skipped rather than patched into a distrusted cache: they coalesce into
the one rebuild the next `query` runs, synchronously, covering schema, every
declared table, and KV. The rebuild is one code path, shared with a remote
update's projection refresh, so a stale index can never serve rows the live
document has moved past; SQL is allowed to fail explicitly rather than lie.
There is no public `ProjectionStale` error and no cache state in table/KV
`Result`s: `QueryFailed` remains SQL's one refusal, whatever refused.

Opening seeds the index through the same containment, so construction cannot
fail for projection storage reasons and the openers treat only an unparseable
workspace declaration as a declaration failure (ADR-0240).

### What still throws, what still returns

`StoreUnusableError` narrows to disposal: a use-after-dispose programmer
error. No storage outcome poisons a store or throws from a verb mid-life.
Boot stays fallible: an opener that cannot load or create durable storage
returns `StoreError.StorageFailed`, because a store that cannot READ its
durable record has nothing trustworthy to hydrate from. Reads keep ADR-0237's
surviving rule: a `Result`'s error arm is declaration conformance and nothing
else.
Write validation, absent rows, undecodable remote bytes and refused SQL keep
their caller-actionable `Result`s.

### Runtime storage

One logical durable record everywhere: the update log, the outbox, the
cursor, and metadata (format certificate, document identity).

```text
projection (both runtimes)
  An in-memory SQLite, written synchronously with every accepted edit and
  rebuilt from the live document at open. Never durable: the durable
  projection was already discarded at every open, because opening rebuilds
  unconditionally. `query(...)` therefore follows accepted edits even while
  persistence is blocked, and sees only projected tables, not the log.

Bun / desktop / Durable Object
  SQLite owns the durable facts directly (_updates, _outbox, _cursor, _meta),
  with the existing snapshot fold and the optional history shelf. The port's
  commit is synchronous.

browser
  IndexedDB owns the durable facts directly: an `updates` store, an `outbox`
  store, and a `meta` store, written in one multi-store readwrite transaction
  per flush, with the same fold threshold applied inside the transaction. The
  whole-checkpoint snapshot of an in-memory SQLite file is deleted. On open,
  the durable updates hydrate the Yjs document and the projection is rebuilt
  from it.
```

y-indexeddb was evaluated and rejected for the browser engine: it exposes no
public way to participate in its transactions, so the outbox and cursor could
never commit atomically with the updates it stores, and its own debounce and
compaction make its update store unreadable as a stable log (verified against
the y-indexeddb source via DeepWiki, 2026-08-12). The existing `idb`
dependency talks to IndexedDB directly instead.

### Restart is honest

Reopening reconstructs exactly the last durable state: durable updates replay
into the document, the durable outbox is what is owed, the durable cursor is
where reading resumes. Work that was accepted but never flushed is gone, which
is the loss the status made visible while the client was open. Closing while
`blocked` is the one way to lose data, and it is a choice the application can
surface (warn, retry, export) rather than a corruption.

## Consequences

- The poison discipline, its `poisoned` state, the `read()` fail-closed helper
  in the client log, and the test pinning terminal storage failure are
  deleted. Their replacement is the failable-port test family: accept while
  blocked, retry preserves order and lands exactly once, restart recovers the
  durable prefix.
- The browser checkpoint (`BrowserCheckpoint`, `state`/`durable` record) is
  deleted; its data migrates into the new object stores in the IndexedDB
  upgrade transaction, so nothing already durable is wiped.
- `query()` no longer sees `_updates`, `_outbox`, `_cursor`, `_meta`. The one
  outside reader (the test-only server replica's wipe) owns its database
  handle and is unaffected as a wipe, but any diagnostic SQL over the log now
  belongs to the port, not the projection.
- The store constructors take the durable port and the projection database as
  separate things; the SQLite convenience path keeps one-database construction
  for the Durable Object replicas, whose synchronous port preserves their
  write-then-read test shape.
- Every commit notification (`onCommitted`, table and KV invalidations) fires
  at acceptance, after the projection write, no longer gated on durability.
  Boot gates that wait for the identity stamp via `onCommitted` are unchanged.
- Memory holds the retained queue while blocked. Unbounded in principle,
  bounded in practice by the person's editing rate; if it ever matters, the
  queue can merge adjacent appends without changing the contract.

## Considered alternatives

- **Keep the poison (status quo, ADR-0237's storage arm).** Rejected by the
  owner: it forces the loss of live, good data to punish a storage failure,
  and the browser runtime never actually lived under it.
- **Return storage failure from each verb.** Rejected in ADR-0237 for reasons
  that still hold: no call site can act on it, and it invites `?? []`
  mis-defaults. The channel for a storage problem is status, not a per-call
  error.
- **A process-wide persistence agent.** Rejected: each document's queue,
  mirror, retry lifecycle and disposal belong to its store; a shared agent
  adds a lifetime that owns nothing else.
- **Expose retry/queue detail in the status.** Rejected: no consumer acts on
  it, and three states name every decision an application can make (nothing,
  wait, warn/retry).
- **y-indexeddb as the browser engine.** Rejected above: no transaction
  surface for the outbox and cursor, private compaction.
- **Keep the checkpoint but fix its status.** Rejected: it snapshots one
  runtime's file format into another's storage, pays a whole-file write per
  commit, and leaves the stamp-before-push window open.
- **An autonomous backoff retry loop.** Rejected for now: the retry triggers
  that exist (next edit, explicit flush, app lifecycle) cover the real cases
  without a timer that can spin against a full disk; revisit only with
  evidence.
