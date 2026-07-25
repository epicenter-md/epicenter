# 0162. Epicenter Home owns relational inspection; applications receive no SQL

- **Status:** Accepted
- **Date:** 2026-07-20 (revised 2026-07-25: native-only V1 over a dedicated
  read-only connection; documents and blobs deferred out of inspection;
  structured coordinates and `presence` in the raw relations)
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

V1 is native only. Native Home reaches the Bun-owned store; there is no browser
inspection command and no browser worker protocol for it. Under ADR-0118, every
desktop catalog SPA already shares one trusted origin and authority, so
"applications receive no SQL" is an API and product boundary there rather than a
per-SPA security sandbox. A browser Home surface is deferred, not designed:
omitting inspection from the typed application API would not be a security
boundary against a same-origin script that can construct Worker messages, so
that surface needs its own trusted-origin decision before it is built.

Applications receive no SQL by the shape of the object graph rather than by a
check. Inspection is a method on the store owner object, which only the native
host holds; application surfaces hold a message port into the operation RPC, and
no operation in that union carries SQL.

Every inspection connection exposes two reserved relations:

```sql
_epicenter_rows(namespace, table_name, row_id, presence, fields_json)
_epicenter_values(namespace, value_name, presence, content_json)
```

Their natural keys are `(namespace, table_name, row_id)` and
`(namespace, value_name)`. The column names are the structured address
coordinates (ADR-0178), so a raw query addresses data the same way the protocol
and storage do. This is a logical contract, not a promise that the private live
store uses these physical relations.

`presence` is exposed because absence is real state, not missing data: a row
tombstone and an unset value both appear here, which is what makes the raw
relations the honest fallback when a Lens interpretation cannot represent what is
stored. They preserve unknown and nonconforming data exactly and remain
available when no Lens is selected.

Row documents and blobs are deliberately absent from V1. There is no
`document_update_v2` column, no `blob_sha256` column, and no document projection.
Consequently the raw relations are not a complete portable artifact and must not
be described as one.

One inspection connection has zero or one selected Lens interpretation. This is
a naming-coherence rule for one unqualified SQL namespace, not a capacity limit.
Selecting a Lens creates one explicit-column `TEMP VIEW` per declared table,
named by the Lens's durable local table name, so `SELECT * FROM notes` works
verbatim. All of those views belong to the same interpretation; the rule limits
interpretations, not view count.

Friendly views project present rows only. `SELECT * FROM notes` answers "what are
my notes", and a tombstone is not a note. Deleted rows stay inspectable through
`_epicenter_rows`, where absence is stated as data rather than hidden by a
filter. There are no `includeDeleted` flags and no alternate view flavors.

Friendly columns are Lens-addressed extraction, not validation. Each declared
field projects `json_extract(fields, '$.<name>')` under its own name, so values
appear as stored even when they do not conform to the selected Lens. The typed
Lens API remains the sole conformance authority and can return structured issues
instead of collapsing nonconformance into SQL `NULL`.

SQLite extraction maps both a missing key and explicit JSON null to SQL `NULL`.
The raw relation remains the honest fallback when that distinction matters:
`json_type(fields_json, '$.<name>')` returns SQL `NULL` for a missing key and the
text `'null'` for explicit JSON null. Arrays and objects project as JSON text and
remain composable with SQLite JSON functions.

The owner quotes every generated identifier. Beyond quoting, a Lens table name
must be usable as a bare relation with no quoting at all, so admission refuses
the SQLite keywords that cannot parse as a relation name, `sqlite_` names, and
the relation names Epicenter storage occupies. Every private relation is
`_`-prefixed and a table name must begin with a letter, so a Lens cannot name one
by construction. Case-insensitive duplicate table names are still refused.

A Lens is selected explicitly because several installed Lenses may interpret the
same namespace or address differently, and Home never merges incompatible
definitions into one unqualified namespace. Selecting a different Lens drops the
previous friendly views first, so a stale `notes` cannot outlive the
interpretation that defined it. Installed Lenses are never auto-mounted.

Inspection opens its own `bun:sqlite` connection to the same database path with
`readonly: true`, and never borrows the store owner's writable connection. The
open mode is the write boundary: there is no `query_only` toggle to restore in a
`finally`, and no window in which submitted SQL meets a writable handle. A
read-only connection cannot promote itself either, since `PRAGMA journal_mode`
is itself a write.

That connection owns its own TEMP views, which live in its private `temp`
schema. The owner connection cannot see them, so nothing mounted for inspection
can redirect an internal owner read; closing the connection discards them with
no cleanup step. A TEMP view creates no second database, snapshot mirror,
materialization, copied rows, synchronization scope, or Lens lifecycle. There are
no `INSTEAD OF` triggers, Lens-declared indexes, materialized TEMP tables,
virtual tables, or persisted view definitions, and no per-query view churn.

The replica keeps its ordinary rollback journal. A second read-only connection
does not require WAL: a writer holds an exclusive lock only for the brief moment
of a commit, and a bounded busy timeout absorbs it. Switching the replica to WAL
would change the shape of the `.sqlite3` artifact and its checkpointing for every
consumer, which is far more than a read-only console should cost.

One submitted statement means one statement. The host prepares the SQL, which
compiles the first statement and ignores anything after it, so a trailing
statement never executes; the read-only connection refuses a write anyway, so the
guarantee holds on two independent grounds. Results are bounded by both row count
and encoded size, and report when a bound truncated them.

Read-only prevents mutation, not expense. A submitted query can still be slow or
scan the whole store. This is a trusted-host capability with bounded results, not
a sandbox for hostile SQL, and it must not be described as one.

Inspection observes continuing live state rather than a durable snapshot. Each
statement receives SQLite's ordinary consistent read, but successive statements
may observe intervening committed writes or synchronized facts.

## Consequences

- Typed application reads may use private SQL and the canonical address index
  internally. Additional index-backed reads require the separately owned
  decision described by ADR-0176.
- Home can offer a table browser and SQL console without granting applications
  arbitrary SQL or stabilizing the private live schema.
- Friendly queries can use table-shaped relations without making release-local
  Lens columns durable storage schema.
- Friendly view generation depends only on durable field names, so release-local
  schema refinements do not change what inspection displays.
- Raw queries can always address honest namespace, table, value, and row
  coordinates, including unknown and nonconforming data.
- Multiple application Lenses remain independent from the one Home inspection
  interpretation because application binding creates no SQL state.
- The live store gains a second connection, read-only and short-lived, rather
  than a second writer or a second owner. The replica's journal mode, backup
  shape, and export semantics are unchanged.
- Documents and blobs are not inspectable in V1, so the raw relations cannot be
  described as a complete export of an Epicenter.
- A portable artifact and a live Epicenter expose the same logical scalar model,
  while only the live Epicenter has an owner and active runtime behavior.

## Considered alternatives

- **No live relational inspection.** Rejected because trusted human and agent
  inspection is a core Epicenter Home responsibility, not merely an offline
  recovery operation.
- **Expose the private live SQLite file.** Rejected because a physical adapter
  layout is not the logical Epicenter and may change independently.
- **Read-only `sql()` guarded by parsing or `EXPLAIN`.** Rejected because it is
  still a second application query language over private storage.
- **`PRAGMA query_only` on the owner's writable connection.** Rejected because
  the safety property then depends on restoring a toggle on every path,
  including the ones that throw, and submitted SQL can turn it off. Opening
  read-only makes the boundary a property of the handle instead.
- **Switching the replica to WAL to allow a second connection.** Rejected
  because it is unnecessary: an ordinary rollback-journal database serves a
  concurrent reader with a bounded busy timeout. It would also change the
  artifact and checkpointing story for every consumer to buy nothing.
- **Expose only the raw relations.** Rejected because making every human and
  agent query repeat JSON extraction hides the relational interpretation Home
  already possesses.
- **Guard friendly columns by declared field kind.** Rejected because a base-type
  guard is a second, partial validator beside the compiled Lens validator. It
  cannot enforce refinements such as enum membership, formats, patterns, or list
  constraints, and it must be kept synchronized with every field kind. It also
  confuses a materialized column's storage class with the JSON value type being
  inspected, which incorrectly mapped array and arbitrary-JSON fields to text.
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
