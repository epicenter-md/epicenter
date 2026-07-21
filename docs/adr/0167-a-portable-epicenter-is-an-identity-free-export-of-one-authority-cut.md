# 0167. A portable Epicenter is an identity-free export of one authority cut

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md) and [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)

## Context

One Epicenter must remain portable without exposing a private live replica file
or turning export into another synchronization system. A synchronized authority
may not own changes or blobs that remain only on an offline device, so
"complete" must name one real durability boundary rather than imply global
coordination across every device.

## Decision

A portable Epicenter is an identity-free, provider-independent export of one
selected owner's complete accepted current logical state at one durability cut.
It represents the same logical Epicenter as the live system, but it is a
separate inert artifact, not a live authority database or replica database.

For a synchronized Epicenter, the selected owner is the principal authority.
The artifact contains every scalar row and value, accepted compact row-document
state, and remotely owned blob byte present at the authority cut. It does not
contain pending changes or local-only blobs that another offline device has
never uploaded. For a local-only Epicenter, the selected local store is the
authority and exports its own durable cut.

The logical artifact contains:

```txt
portable Epicenter
├── scalar rows and values
├── compact current row-document states
├── blob inventory
└── every blob byte owned by the selected owner at the cut
```

Its scalar relations expose the stable structured logical addresses:

```sql
rows(namespace_key, table_key, row_id, fields_json)
values(namespace_key, value_key, value_json)
```

The artifact always represents the complete selected authority. Namespace
filtering is an inspection operation, never a partial portable-Epicenter export.

It excludes principal identity, authentication, deployment identity, replica
identity, pending work, transport grouping, receipts, cursors, checkpoints,
authority sequences, synchronization lineage, mutation history, and private
runtime indexes. Terminal tombstones from the source authority are not logical
user data and do not enter the artifact.

The portable representation must be inspectable with ordinary tools. The
leading encoding is a documented SQLite file plus blob files and integrity
metadata, carried as a directory or archive. The exact container, auxiliary
relations, and physical encodings remain implementation decisions until a
round-trip proof chooses them. Neither encoding may become the private schema
of a live store.

The platform exposes three portability verbs:

```txt
Export current logical state
Inspect the artifact
Initialize an empty Epicenter
```

Initialization validates the complete artifact, preserves logical row and blob
identities, and creates a fresh authority and synchronization lifetime. It does
not preserve a relationship with the source.

## Consequences

- Export from a synchronized Epicenter reports the authority's accepted state,
  not every unsynchronized edit or byte on every device.
- The same logical data can move between hosted, self-hosted, and local-only
  owners without carrying account or synchronization identity.
- A live store may change its private SQLite schema without changing the
  portable contract.
- Portability needs a stable logical schema, versioning, validation,
  failure-atomic initialization, blob integrity, and round-trip equivalence.
- Export does not require exact-checkpoint semantics for ordinary live replicas.
  The selected authority owns the stable export cut.

## Considered alternatives

- **Use the live SQLite file as the portable Epicenter.** Rejected because it
  mixes logical data with adapter layout, pending work, indexes, identity, and
  synchronization state.
- **Coordinate every device before export.** Rejected because it creates a
  distributed settlement and backup system and cannot complete while a device
  remains offline.
- **Import into a nonempty Epicenter.** Rejected because schema-opaque state has
  no generic merge law. Application-specific imports remain application logic.
- **Preserve synchronization lineage across initialization.** Rejected because
  the artifact moves logical data, not an authority lifetime.
