# 0174. Row documents project as nullable compact cells and persist as bounded live chains

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** the document-plane persistence, exact-byte retention, no-cache, and presence mechanics of [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md), plus [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)'s statement that remote authority mechanics remain unchanged. ADR-0161 already removes the workspace ownership axis; the principal authority and fixed-address-socket proposals remain independent.
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md) (the authority is the trusted document joiner and compactor), [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md) (every live owner uses the same bounded baseline-plus-tail law), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) (the update log is a private physical representation of one logical row cell), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md) (document publication stores exact retry evidence rather than authority vectors)
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

## Context

A row document is part of its row, but its live write mechanics differ from
small scalar fields. Replacing one complete encoded document after every edit
would turn a small Yjs update into a large SQLite rewrite, while retaining every
incremental update forever would make storage and hydration unbounded. Client
checkpoints cannot safely replace authority state because one client cannot
prove that its snapshot includes every concurrent branch the authority already
accepted.

## Decision

Every Epicenter row logically contains scalar fields and zero or one persisted
Yjs document. The document has no identity or lifecycle outside its row. Blob
membership remains independently owned by the blob ADRs.

Inspection, Backup, and every portable Epicenter project the document directly
on the logical row:

```sql
rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL
)
```

`document_update_v2` is one self-contained compact Yjs V2 update for the
complete accepted document. `NULL` means that no document state has ever been
persisted for the row. Visually empty application content may still encode
causal deletion state or unresolved dependencies and therefore need a non-null
cell.

Every live owner stores that logical document privately in the same SQLite
database as its scalar row, using a sparse one-to-one document relation with:

```txt
zero or one compact gc:true baseline
plus a short ordered tail of accepted V2 updates
```

The chain is a physical write optimization, not document history, an
acquisition floor, a portable representation, or a checkpoint exposed to
replicas. The row-liveness transaction owns its deletion. Scalar fields remain
small in their scalar relation; storing the document separately does not create
a second logical aggregate or weaken atomic local deletion.

Each owner bounds the tail by both entry count and total encoded bytes. Crossing
either threshold hydrates the covered baseline and tail into a fresh `gc: true`
`Y.Doc`, encodes one complete update, and atomically replaces the covered chain
with that baseline. The concrete thresholds are adapter-tested implementation
constants, not protocol or product promises. An offline replica does not pin
the tail: a compact full state continues to join later valid Yjs updates from
that replica.

The authority is not an editing peer. It authors no application operations,
has no collaborative identity, and carries no awareness or presence state. It
is the trusted Yjs joiner, validator, and compactor for the accepted authority
state. Both background publication and an open document's low-latency carrier
enter the same acceptance operation, which rechecks row liveness, applies the
candidate, enforces the canonical post-candidate byte and struct bounds from
ADR-0146, commits the bounded representation, and only then acknowledges and
best-effort fans out the update.

A wire-valid candidate may be too large for one adapter's tail-entry limit even
when the resulting canonical document is within its product bounds. In that
case the owner hydrates and validates the candidate, then atomically stores the
resulting compact baseline instead of appending the transient bytes. It does not
reject valid document state solely because the transport encoding is a poor
physical tail row.

An in-memory `Y.Doc` is always derived from SQLite. An owner may retain derived
hot documents or discard them after an operation; cache size, eviction, and
hibernation behavior are implementation tuning and cannot change durability or
receipt semantics.

## Consequences

- One logical row shape serves typed access, inspection, Backup, download, and
  restore without exposing live update logs or a document inventory.
- Small edits append small records on the live path, while count and byte
  thresholds bound storage fragmentation and rehydration work.
- Compaction reduces retained encodings and deleted content. It does not
  coalesce Yjs struct clocks, so the 131,072-struct product bound remains an
  independent refusal even when encoded bytes are below 1 MiB.
- Bound state is durably observable. Local editing and persistence continue
  while publication is parked, and Epicenter never claims the parked document
  is synchronized. Byte fullness may recover after edits shrink the compact
  state; structural fullness requires moving the content to a fresh row.
- Data owns one address-scoped synchronization-status surface. A document-bound
  observation distinguishes encoded bytes from decoded structs and reports the
  measured value and limit. Epicenter Home must surface parked work; an
  application may observe the same status, but an accepted local editor mutation
  does not throw merely because authority publication is parked.
- Restore intentionally abandons unpublished document state from superseded
  replicas. Back up before Restore preserves the outgoing accepted authority
  state only; it never captures unpublished work from a replica.
- The authority can produce one compact accepted document for Backup without
  trusting a client checkpoint or waiting for every replica to reconnect.
- Realtime fanout lowers latency but never proves durability. ADR-0171's exact
  post-commit publication receipt owns that proof.
- A single principal authority remains the lifecycle and transaction owner.
  Per-document Durable Objects are not introduced merely to host live sockets.

## Considered alternatives

- **Store the complete document directly beside live scalar fields.** Rejected
  because each small edit rewrites the complete BLOB and makes scalar updates
  share a physical record with potentially large document bytes. The nullable
  cell remains the correct logical and portable projection.
- **Keep an unbounded update log.** Rejected because authority storage, Backup
  capture, and cold hydration would grow with edit history instead of current
  accepted state.
- **Let clients compact and replace authority state.** Rejected because a
  client cannot prove its replacement covers concurrent authority branches.
  Verifying that claim requires the same trusted Yjs join the authority already
  performs.
- **Make the authority an opaque update mailbox.** Rejected because it gives up
  bounded accepted state, canonical bounds enforcement, and one complete
  authority document for Backup.
- **Use one Durable Object per document.** Rejected because it separates the
  document from row deletion and account Backup, requiring revocation,
  enumeration, and cross-object lifecycle machinery.
