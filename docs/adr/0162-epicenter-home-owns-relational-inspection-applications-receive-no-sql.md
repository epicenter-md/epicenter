# 0162. Epicenter Home owns relational inspection; applications receive no SQL

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)

## Context

Applications need typed local reads. People and agents also need to inspect one
Epicenter as familiar tables and issue ad hoc relational queries across them.
Giving every application a SQL escape hatch would couple product code to
private storage and create a second untyped application API. Refusing all live
inspection, however, would make Epicenter Home unable to explain the data that
the platform exists to curate.

## Decision

Application-facing `Epicenter` APIs expose typed tables and values only. They
expose no `sql()` method, raw SQLite connection, query builder, projection DTO,
CTE injection, inspection session, TEMP view, persistent application view, or
native-reader contract. Binding any number of application Lenses creates no SQL
state.

Epicenter Home owns relational inspection as a trusted host capability. It can
inspect a live Epicenter through that Epicenter's storage owner, or inspect an
inert portable Epicenter artifact. It does not hand Home, applications, or
agents a connection to a private live file. The owner executes read-only SQL
over the logical inspection surface and returns ordinary result rows.

Home is a capability owner, not a desktop-only storage assumption. Native Home
reaches the Bun-owned store. Under ADR-0118, every desktop catalog SPA already
shares one trusted origin and authority; “applications receive no SQL” is a
supported API and product boundary there, not a per-SPA security sandbox.

A future standalone browser Home may send the same inspection operations to
its existing storage-owner Worker, but only from a dedicated trusted
first-party Home origin that does not cohost untrusted application code.
Omitting inspection from the typed application API is not a web security
boundary against a same-origin script that can construct Worker messages. The
owner must therefore gate the command at the trusted host or origin boundary.
Browser Home never opens another OPFS connection. This decision permits that
surface but does not require the product to ship it.

Every inspection session exposes two reserved lossless relations:

```sql
_epicenter_rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL,
  blob_sha256 TEXT NULL
)
_epicenter_values(namespace_key, value_key, value_json)
```

Their natural keys are `(namespace_key, table_key, row_id)` and
`(namespace_key, value_key)`. This is a logical contract, not a promise that the
private live store uses these physical tables. A live implementation may use a
different schema, compact identifiers, or another adapter representation.

`document_update_v2` contains one self-contained compact Yjs V2 update produced
from the complete document, never a state vector or concatenated live update
log. `NULL` means no document state has ever been persisted for the row.
`blob_sha256` records the accepted bytes in the row's universal zero-or-one blob
slot. Both columns are platform-owned structural state outside Lens fields.
The raw relations preserve unknown and nonconforming data exactly and remain
available when no Lens is installed.

One Epicenter store owner supports zero or one active Home inspection session.
That session has zero or one selected Lens interpretation. This is a naming-
coherence rule for one unqualified SQL namespace, not a SQLite or OPFS capacity
limit. Selecting a Lens creates one explicit-column, read-only `TEMP VIEW` per
declared table, using
the Lens's durable local table key as the view name. All of those views belong
to the same interpretation; the rule limits interpretations, not view count.
They project live rows from `_epicenter_rows`, use base JSON type guards, and
store no rows. Missing, JSON null, and wrong base types project to SQL `NULL`.
The reserved raw relation remains the honest fallback.

The owner quotes every generated identifier. The `_epicenter_` prefix and
SQLite internal names are reserved. Selection fails with a typed refusal when
two declared table keys collide under SQLite's ASCII case-insensitive
identifier comparison; it never silently renames a durable local key.

A Lens is selected explicitly because several installed Lenses may interpret
the same namespace or address differently. Home never merges incompatible
definitions into one unqualified SQL namespace. Switching interpretation closes
or replaces the current session's friendly views. A concurrent second session
receives a typed busy refusal. Cross-namespace and unknown-data inspection
remain possible through the reserved raw relations; V1 does not introduce
prefixed friendly aliases or several simultaneous view namespaces.

The store owner creates, drops, and queries the views on its existing SQLite
connection, serialized with its other operations and never while a statement
is stepping. In a browser this is the one Worker-owned connection already
holding the OPFS storage lease. That single-connection fact is a physical
storage constraint; it is not the reason only one interpretation is active. A
TEMP view creates no OPFS owner, database file, copied rows, synchronization
scope, or Lens lifecycle. Replacing or closing the inspection session drops
its raw and friendly views. Closing the store connection removes any remaining
TEMP views automatically. There are no
`INSTEAD OF` triggers, Lens-declared indexes, materialized TEMP tables, or
persisted view definitions.

Inspection observes continuing live state rather than a durable snapshot.
Each statement receives SQLite's ordinary consistent read, but several
statements may observe intervening committed writes or synchronized facts.
Portable-artifact inspection uses the same logical and selected-Lens surfaces
over its inert point-in-time contents.

## Consequences

- Typed application reads may use private SQL and the canonical address index
  internally. Additional index-backed reads require the separately owned
  decision described by ADR-0176.
- Home can offer a table browser and SQL console without granting applications
  arbitrary SQL or stabilizing the private live schema.
- Friendly queries can use table-shaped relations without making release-local
  Lens columns durable storage schema.
- Raw queries can always address honest namespace, table, value, and row
  coordinates, including unknown and nonconforming data.
- Multiple application Lenses remain independent from the one Home inspection
  interpretation because application binding creates no SQL state.
- Browser OPFS retains one database owner. Home adds a connection-local query
  interpretation inside that owner rather than another SQLite connection.
- A portable artifact and a live Epicenter expose the same logical data model,
  while only the live Epicenter has an owner and active runtime behavior.

## Considered alternatives

- **No live relational inspection.** Rejected because trusted human and agent
  inspection is a core Epicenter Home responsibility, not merely an offline
  recovery operation.
- **Expose the private live SQLite file.** Rejected because a physical adapter
  layout is not the logical Epicenter and may change independently.
- **Read-only `sql()` guarded by parsing or `EXPLAIN`.** Rejected because it is
  still a second application query language over private storage.
- **Expose only the raw relations.** Rejected because making every human and
  agent query repeat JSON extraction hides the relational interpretation Home
  already possesses.
- **Open one SQLite connection per Lens.** Rejected because Lens interpretation
  does not deserve another database owner. Browser SAH-pool storage also
  permits only one simultaneous connection, but the one-interpretation rule
  remains a semantic naming rule on runtimes that could open more connections.
- **Install several incompatible friendly interpretations together.** Rejected
  because unqualified view names would hide which release-local Lens defines a
  column. One explicit selection keeps the interpretation honest.
- **Persist Lens views or physical Lens tables.** Rejected because a
  release-local, partial, overlapping interpretation cannot own durable schema,
  migration, or unknown data.
- **Generate CTEs, materialize TEMP tables, or implement virtual tables.**
  Rejected because ordinary connection-local views already provide named live
  relations without query rewriting, copied state, invalidation, or a custom
  SQLite module.
- **Make inspection desktop-only.** Rejected because trust and storage
  ownership, not renderer technology, define the capability. A future browser
  Home can route through its existing origin owner, provided Home has a
  dedicated trusted first-party origin and the owner gates inspection there.
- **Treat the desktop application boundary as a sandbox.** Rejected because
  ADR-0118 deliberately gives every desktop catalog SPA one trusted origin and
  authority. Withholding SQL remains a supported API boundary until a future
  untrusted application model earns real isolation.
