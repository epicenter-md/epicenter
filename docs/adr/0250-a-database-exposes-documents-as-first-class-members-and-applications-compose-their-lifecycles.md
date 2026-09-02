# 0250. A database exposes documents as first-class members and applications compose their lifecycles

- **Status:** Superseded
- **Date:** 2026-08-19
  open ADRs before merge.
- **Amends:** [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md)
  at the public namespace and lifecycle owner. Withdrawn: the table/database
  layer intrinsically retires a document when it deletes a row, and
  `table.document.open` is the fundamental document path. The independent
  document, derived address, and opaque manager remain.
- **Relates:** [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
  and [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md).
- **Amended by:** [ADR-0251](0251-one-transaction-coordinator-backs-direct-operations-and-explicit-compositions.md)
  at the transaction entry surface. Withdrawn: requiring callers to wrap
  every one-operation mutation and flattening transaction tables into names
  such as `tx.pages`.
- **Unbuilt:** the public `db.documents` namespace, the transaction-scoped
  document retirement operation, and the application actions that compose page
  deletion with document retirement.
- **Superseded by:** [ADR-0258](0258-row-documents-are-opened-through-their-owning-table.md)
  at the public document namespace and lifecycle owner.

## Context

Independent Yjs documents need one database-scoped runtime so local persistence
and optional synchronization can be shared. A page commonly has one document,
but that is an application convention rather than a fact the generic document
manager can know. Making the table own that relationship makes a convenient
page pattern into an architectural constraint and prevents applications from
composing different document lifecycles.

## Decision

**Documents are first-class members of a database namespace. A page commonly
owns one document by convention, but lifecycle coupling is an explicit
application action composed transactionally, not an intrinsic property of the
document manager.**

Every database exposes one document namespace alongside its scalar tables and
key-value state:

```ts
const document = await db.documents.open(address);
```

The namespace accepts opaque document addresses. `documentAddress` remains a
database or application convention for deriving an address from a page or row;
the manager does not parse it, infer ownership from it, or scan its prefixes.
The same database runtime contains the scalar application document, the
document manager for many independent Yjs 14 documents, shared local
persistence, and an optional synchronization adapter. Local and synced modes
differ by that adapter and their internal outbox/admission machinery, not by
their public composition model.

Opening and creating are separate lifecycle operations. `open(address)` only
opens an existing, non-retired document and never allocates one because of a
typo or an absent record. A separate explicit create/admit operation creates a
new address and returns its handle. Retirement is terminal and idempotent.
The exact error/result shapes are implementation work, but the distinction is
part of the namespace contract.

Lifecycle actions use a database transaction coordinator to compose scalar and
document operations. A page-delete action that means “delete the page and its
body” deletes the scalar row and retires its derived document through the
transaction context. A different action may delete the row while retaining or
transferring the document. Retirement is a durable tombstone that prevents late
updates from resurrecting an address; it is not an automatic consequence of a
generic scalar table delete. The retirement fact is part of the synchronized
database state, so peers learn the tombstone and reject late document bytes too.

“Transactionally” describes local durable composition of the operations. It does
not promise cross-Y.Doc rollback or that remote replicas observe independent
Yjs documents atomically, and it does not introduce distributed transactions
into synchronization. It does require one local durable batch, deferred
notifications, and a synchronized lifecycle fact that peers apply before
accepting later bytes for the retired address.

## Consequences

- `db.documents` is the uniform document entry point. `table.document.open`
  does not belong in the final public API.
- Tables remain scalar data primitives. Applications own domain actions such as
  `deletePage`, where the page/document lifecycle policy is visible and testable.
- A document can be shared by several rows, outlive a page, or be retired with
  another action. Those choices are explicit instead of being encoded in the
  manager.
- The common one-document-per-page pattern remains simple: derive the address
  with `documentAddress` and compose the page action in one database
  transaction.
- The design permits orphaned documents if an application omits its lifecycle
  policy. The application owns that trade-off, and retirement/garbage-collection
  tests must cover document-owning actions.
- The database still has one persistence and synchronization boundary. A
  multiplexed database transport may carry the scalar document, logical
  document-address sections, and retirement facts without changing the
  namespace decision.

## Considered alternatives

- **Keep `table.document` and table-owned retirement:** refused because it
  makes row ownership an intrinsic manager rule and cannot express shared,
  retained, or transferred documents.
- **Put documents outside the database namespace:** refused because local
  persistence, synchronization, and transaction composition would acquire a
  second ownership boundary.
- **Let the manager parse addresses and infer page ownership:** refused because
  it destroys the opaque-address boundary and moves application policy into a
  generic primitive.
