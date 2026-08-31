# 0241. A store is truth plus debts, and SQL is a composed follower

- **Status:** Accepted
- **Amended by:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at the operation this record reserved: the authority gains one destructive whole-document replacement, owned explicitly by restore. Root-document compaction remains refused.
- **Date:** 2026-08-14
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0241 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md)
  at the projection half: the built-in SQL read index and the `query` verb are
  deleted from the store. The other half of that record (acceptance versus
  durability, the visible persistence debt) stands unchanged.
- **Relates:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md)
  (one definition per runtime), [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md)-era
  invalidation laws in `@epicenter/workspace` (unchanged; this record adds a
  phase-order contract beside them).

## Context

The store carried a SQL projection inside the engine: an in-memory SQLite
written synchronously with every accepted edit, so `db.query` and every
subscriber could never observe the document ahead of SQL. That machinery had
its own failure vocabulary (`ProjectionFailed`, a stale flag, a whole-index
rebuild before the next statement), a `projection` option on both
construction seams, and a rule about sharing a Durable Object's one database.

An audit found the guarantee had no consumer. **No application code calls
`db.query`.** Honeycrisp, the reference app, renders everything from `list()`
and `get()` plus `subscribe`; the `query`-shaped surfaces elsewhere in the
repository (local-mail, local-books, Matter) are different stacks over CDC
mirrors. Every caller of the low-level `createAccountStore` was itself test
infrastructure. The store was paying for a synchronous-SQL law that protected
nobody, in its hottest path, with its most intricate containment story.

The design conversation that produced this record generalized the finding.
Sort a store's contents by the question each thing answers:

- **The document answers: what is true now?** Anything derived from it (SQL,
  FTS, Markdown, embeddings) answers the same question, so a crash costs
  nothing: recompute from truth.
- **The log, outbox, cursor, and identity answer: what has passed between me
  and someone else?** Disk, or the account authority. A counterparty's state
  is not observable from here, so a record separated from its act cannot be
  reconstructed afterward. A debt must be written in the same atomic act that
  incurs it, which is why the outbox claim rides inside the append batch and
  can never be a subscriber.

One sentence: **the document is what's true; the ledgers are what's owed.
Truth recomputes; a lost debt is silently forgiven, and forgiven debt is data
loss.**

## Decision

**The store keeps exactly the ledgers a crash cannot reconstruct. Everything
downstream of truth is a follower an application composes outside, and SQL is
the first one.**

1. **The projection and `query` leave the core.** `WorkspaceView` is `tables`
   plus `kv`. `QueryFailed` and `ProjectionFailed` leave `StoreError`; the
   `projection` option leaves both construction seams. The browser opener
   loads no WASM SQLite; the Bun opener allocates no in-memory database.

2. **SQL ships as `@epicenter/data/projection`.** `createSqliteProjection({
   data, workspace, database })` hydrates from `list()`, marks itself dirty on
   `store.onCommitted`, and rebuilds the whole database at the next `query`.
   The caller supplies and owns the database (in-memory by convention), so
   construction is synchronous on every runtime; the one async step in a
   browser (WASM init) stays in the caller's boot path. The helper touches
   nothing package-internal, which is the proof that the follower seam
   (`list`, `get`, `onCommitted`, `subscribe`) is complete for any derived
   artifact.

3. **The lazy contract replaces the ordering law.** The old promise was "SQL
   is current when you are notified." The new one is stronger and cheaper:
   SQL is current when you *read*, always, because reading is what repairs
   the cache. Per-row patching is refused; it may return later as an
   optimization behind the same `query` contract. What makes the promise
   structural is a phase order the store now documents as a contract:
   within one flush, `onCommitted` listeners run before KV and table
   notifications, so a follower marked dirty in the first phase is dirty
   before any subscriber can read through it.

4. **The constructors are demoted.** `createAccountStore` and
   `createDeviceStore` leave the public barrel for `@epicenter/data/engine`,
   documented as the construction seam for runtimes with no named opener
   (today: exclusively `workerd` test fixtures). Applications enter through
   the openers, which own address, claim, format, and deletion.

5. **Sync stays inside, and the reopening condition is recorded.**
   Externalizing sync is possible: publish the update log as a stable,
   position-addressed stream and let sync be an external consumer with a
   durable offset, replaying the tail after a crash. The price is consumer
   bookkeeping inside every client: compaction becomes a contract (the log
   may only fold entries every consumer has passed), entries grow provenance,
   and every cross-store ordering discipline (cursor after bytes, identity
   before first push) becomes a convention rather than a structural
   impossibility. With exactly one exchange partner (the account authority,
   fixed at birth by ADR-0233), that generality has no consumer. **Refused
   until a second exchange partner exists** (peer-to-peer sync, a second
   authority, or any consumer that must durably track log positions); that
   arrival is what reopens this decision, not implementation preference.

## Consequences

- The store engine loses roughly 900 lines of projection machinery, its
  subtlest containment story, and one whole failure vocabulary. Its
  irreducible job is now statable in one sentence: keep the document live and
  write every debt in the atomic act that incurs it.
- A nonconforming row projects raw in the follower, so SQL still shows what
  failed; a conforming row projects exactly what `list()` reports, so SQL and
  the typed surface can no longer disagree about defaults (the old projection
  stored written payloads, and unwritten fields read `NULL` through SQL while
  `list` reported declared defaults).
- Whole-rebuild-at-read costs ~2 ms on the real vault per dirty read, the
  same figure that already justified rebuilding wholesale on every remote
  update. A surface that queries in a hot loop after every commit pays it
  repeatedly; that is the signal to add per-row patching inside the helper,
  not to move SQL back into the store.
- An FTS index, Markdown exporter, or embedding pipeline composes the same
  way, and no plugin framework, chaining API, or `with...` registration
  exists to maintain. Composition at the call site is the extension model.
