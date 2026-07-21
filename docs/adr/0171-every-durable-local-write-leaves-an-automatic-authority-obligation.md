# 0171. Every durable local write leaves an automatic authority obligation

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md)
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md), [ADR-0163](0163-latest-scalar-state-synchronizes-through-one-epicenter-exchange.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)

## Context

Scalar writes already become locally durable with a pending intent and clear
that intent only after an authority receipt. Row-document updates are durable
in SQLite, but their publication currently depends on an open document
connection. Blob replication is an explicit application action. These three
rules make identical user intent produce different durability outcomes and
force applications to know synchronization machinery.

## Decision

Epicenter owns one convergence law:

> Every write that Epicenter accepts durably records, in the same local
> transaction, durable evidence of what the authority is still owed. One
> Epicenter runtime owner drains those obligations automatically. It clears an
> obligation only after post-commit proof from the active authority lifetime.

Applications read and write through typed scalar lenses, row-document handles,
and row-owned blob operations. They do not call `sync`, `publish`, `upload`,
`download`, `purge`, or a remote-settlement barrier. Synchronization status is
observation, never an action.

The law has three independent protocol realizations:

| Plane | Durable local work | Authority proof |
| --- | --- | --- |
| Scalar | latest-state intent in the scalar outbox | matching accepted-batch receipt |
| Document | Yjs update log plus local publication state vector | post-commit authority state vector covering the local vector |
| Blob | immutable local bytes plus a row-addressed publication record | accepted content digest at the live row address |

These are independent convergence units, not one transaction. They share one
runtime lifecycle owner for attachment, credentials, wakeups, retry, backoff,
authority-lifetime changes, status, and disposal. They retain separate payload
stores, admission rules, bounds, acknowledgements, and wire versions. There is
no generic `outbox(kind, payload)` and no whole-Epicenter transport batch.

A local document update appends its Yjs V2 bytes and advances its local state
vector in the same SQLite transaction. Closing the last live handle destroys
the in-memory `Y.Doc` but leaves that publication obligation intact. A
background drain hydrates only dirty documents, sends the missing state, and
records the authority's state vector only after the authority commits. The
obligation is clear only when the authority vector covers the current local
vector; a concurrent local edit therefore remains pending without a revision
allocator or compare-and-clear race.

Document publication is outbound and automatic. Remote document state remains
lazy and arrives when the row document is next opened. A realtime connection
for an open document may reduce edit latency and carry ephemeral presence, but
it is an overlay, not the only durability path. Closing an application surface
must never strand accepted document work.

Every exchange is bound to one opaque authority-lifetime identity. Restore
creates a new lifetime, refuses old replicas, and invalidates prior authority
proof. Replicas reacquire scalar state, treat document authority vectors as
unknown, and reevaluate blob obligations against the restored live rows.
Backups contain accepted authority state only; pending work on an offline
device is not part of a Backup.

## Consequences

- Local durability has one meaning across scalars, documents, and blobs:
  accepted work survives process and handle closure and remains owed to the
  authority.
- Ordinary applications contain no networking policy, retry loop, upload
  bookkeeping, or settlement choreography.
- Scalar batching never becomes a semantic commit. Documents and blobs do not
  enter that batch merely to make the implementation look unified.
- Closed documents can converge without eager inbound hydration or permanent
  live `Y.Doc` instances.
- A realtime document socket may report connection and presence, but those
  observations do not prove authority durability.
- Oversized or otherwise refused work remains visibly pending or parked at its
  address. Epicenter never reports it as synchronized and never spins one
  failing address through a global retry loop.
- Row deletion remains terminal. Its local transaction installs scalar
  deletion state and removes document state and pending publication evidence;
  later byte cleanup cannot resurrect the row.
- A device that never reconnects can still lose its unpublished work during a
  user-authorized Restore. This is the accepted limit of an authority Backup,
  not a hidden synchronization mode.

## Considered alternatives

- **Require applications to publish explicitly.** Rejected because it makes
  authority durability depend on application policy and leaves closed
  documents and forgotten blobs stranded.
- **Publish documents only while their handles are open.** Rejected because
  handle lifetime is a UI resource boundary, not a durable-data boundary.
- **Use one generic outbox or one whole-Epicenter exchange.** Rejected because
  it duplicates document bytes, cannot carry large blobs efficiently, couples
  unrelated bounds, and suggests cross-plane commit semantics.
- **Eagerly mirror every remote document and blob.** Rejected because outbound
  durability does not require hydrating or downloading unopened row content.
