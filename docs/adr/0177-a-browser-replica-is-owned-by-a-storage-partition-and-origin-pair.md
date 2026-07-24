# 0177. A browser replica is owned by a storage-partition and origin pair

- **Status:** Accepted
- **Date:** 2026-07-24
- **Amends:** [ADR-0165](0165-browser-origins-contain-independent-epicenter-replicas.md) — the ownership boundary is the storage partition the user agent resolves for an origin, not the origin string alone. Every other part of ADR-0165 (one page, one DedicatedWorker, one Web Lock, immediate refusal, no coordination protocol) stands unchanged.
- **Relates:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md)

## Context

ADR-0165 says "each browser origin stores its own complete local Epicenter
replica" and scopes ownership to the origin throughout. That reads as though the
origin string identifies the replica. It does not, and the gap is not academic:
demonstrating two independent clients requires knowing exactly what makes two
browser replicas independent.

Nothing in our code names an origin. The Web Lock is the constant
`'epicenter-data-sqlite'`, the OPFS VFS directory is the constant
`.epicenter-data-sahpool`, and the database is the constant path
`/epicenter-data.sqlite3`. Both Web Locks and OPFS are scoped by the storage
partition the user agent resolves for the running document, which the page can
neither name nor observe. The origin is one input to that resolution, not the
whole of it.

## Decision

A browser Epicenter replica is owned by the pair of the storage partition the
user agent resolves for the document and that document's origin. The origin
alone does not identify the replica.

Two documents that resolve to different storage partitions own different
replicas even when their origin is identical. They hold different Web Locks over
the same lock name and different OPFS files at the same path, so both may be
open at once and neither can see the other's data. They converge only by
synchronizing through the authority, exactly as two devices do.

The adapter continues to name no partition and no origin. It claims the one
constant lock, opens the one constant path, and lets the user agent decide which
partition those constants land in. Partition identity is an ambient property of
where the document runs, never a value Epicenter reads, stores, or addresses.

This ADR governs top-level Epicenter documents. It makes no claim about
partitioned third-party embedding, and Epicenter does not run as an embedded
cross-site frame.

## Consequences

- "Independent replica" is provable without a second origin and without a second
  machine: a second storage partition on one origin is sufficient.
- ADR-0165's competing-owner refusal is unchanged and is now stated exactly: a
  second document is refused when it shares the first document's partition and
  origin, which is what "another tab for this origin" means in the refusal
  message.
- Storage-capacity and durability qualification remains per partition. Evidence
  gathered in one partition does not qualify another.
- Private or incognito browsing is a distinct partition, which is consistent
  with ADR-0165 continuing to treat it as a refusal environment rather than a
  durable one.
- No stored byte, wire field, namespace key, row ID, or Lens changes. Partition
  identity stays unrepresented, so there is nothing to migrate.

## Considered alternatives

- **Leave ADR-0165 saying "origin".** Rejected because it makes a false
  independence claim: it implies one origin holds one replica, which the OPFS
  and Web Locks scoping contradicts.
- **Say "one replica per browser profile".** Rejected because a profile is a
  browser-vendor product concept, not a web-platform boundary. It is one way to
  obtain a second partition, and belongs in a proof recipe rather than in the
  decision.
- **Name the partition in the lock name or database path.** Rejected because a
  document cannot read its own partition, and inventing a surrogate would create
  an addressable identity that ADR-0165 deliberately keeps out of every key.
