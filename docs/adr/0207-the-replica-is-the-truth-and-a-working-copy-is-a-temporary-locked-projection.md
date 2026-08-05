# 0207. The replica is the truth, and a working copy is a temporary locked projection

- **Status:** Accepted
- **Date:** 2026-08-04
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 lands with this branch, so 0207 is the next free integer today. Reconcile at merge time against other open ADR branches (`docs/adr/README.md`).
- **Relates:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md) (one fact relation and a path-safe row id, which is what makes one projection rule sufficient), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) (this adds no query surface and is untouched by it), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md), [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md)

## Context

Every durable fact this system holds is reachable only through an application.
A row's fields are JSON in one relation and a row document is a chain of Yjs
updates, so no editor, no shell tool, and no coding agent can read a body
without going through code written for the purpose. ADR-0176 keeps predicates
and ordering out of the typed application surface, and ADR-0162 gives ad hoc
relational inspection to Home, but neither of them hands anyone a body they can
edit.

That is the gap. A person who wants to fix ten notes in vim, and an agent asked
to write the spoken edition of an article, both need the same thing: a
directory. Nothing here provides one.

The obvious answer, making files the durable form and treating the database as
a rebuildable index, was considered at length and is rejected below. It moves
the truth to the weaker representation, gives up write-time validation, and
abandons a replica, a merge, and a browser and phone story that already work.

ADR-0206 changed what the cheap answer costs. With one fact relation, one
address depth, and a row id whose grammar is already safe in a path segment,
a projection needs exactly one rule and has no second shape to special-case.

## Decision

**The replica is the truth. A working copy is a temporary, locked, address-scoped
materialization of it, and no file is ever authoritative.**

### Shape

A working copy covers one address prefix, a namespace and a table, never the
whole replica.

```txt
<namespace>/<table_name>/<row_id>.md

  frontmatter   the row's `fields`, verbatim
  body          the row document, rendered
```

One rule, no exceptions. A row with no document projects frontmatter and an
empty body.

### Check-in never replaces

An incoming file is applied as a `patch` against the row's fields and, for the
body, as one Yjs transaction that moves the document to match. The document is
never rebuilt from the file. Its update chain and its publication revision
(ADR-0174) are untouched by the round trip, so content returns and history stays
where it lives.

`patch` does not create (ADR-0206), so a file naming a row that does not exist
is refused rather than seeded. A working copy edits what it checked out.

### The lock is the honesty

Rows under an open working copy are locked, and the application steps back from
them for its duration. Two writers and no arbiter is the condition ADR-0203
requires an owner for, and the owner here is whoever opened the copy.

The window is minutes and it is opened deliberately. A permanently writable
projection racing the application that owns it is the outcome this refuses.

### Blobs never enter

A row's blob (ADR-0173) is not materialized and cannot be edited through a
working copy. Frontmatter carries the blob id and nothing else. Bytes are reached
through the blob store as they always were.

This is not a limitation to lift later. A working copy exists for bodies.

### The layout is derived, and is not a compatibility surface

Nothing durable records how a working copy was laid out. The filename scheme,
the frontmatter serialization, and the rendering of a document are all functions
of the replica, and changing any of them is re-materializing rather than
migrating.

Concretely: a row id must not carry content (ADR-0206), so a minted row projects
to an opaque filename. Adding a decorative title slug beside the id, dropping it,
or changing its shape are all free, because the id in the path is what check-in
reads and the slug is never authoritative. Nothing is owed to a previous layout.

### What a working copy declines

A row whose document is not prose has no honest markdown rendering. The
materializer skips it and the working copy records which addresses it declined,
because a silently missing row reads as a deleted one.

## Consequences

- An agent reads and edits a body with `cd`, `Read`, and `Edit`, with no tool
  to install, no schema to discover, and no capability to grant. That was the
  gap this record exists to close.
- A change is reviewable before it lands, because a working copy is a directory
  and a directory diffs.
- **ADR-0176 is untouched.** This adds no predicate, ordering, page, or cursor
  to any typed read. A working copy is a whole-prefix materialization, which is
  `scan` with a different output, and it declares no index and owns no access
  pattern.
- One projection rule survives contact with every shipped Lens, because
  ADR-0206 already collapsed the second address kind. A chosen-id row projects
  to a readable filename for free; a minted one does not.
- Blobs stay unreachable from a working copy, so a two megabyte recording never
  enters a directory someone is about to edit or a history someone is about to
  push.
- The lock is a real constraint on the application, visible in its UI, not an
  implementation detail that can be hidden.
- **What this forecloses:** files as a durable form, a working copy that outlives
  its check-in, a second write path that bypasses `patch`, blob bytes in a
  working copy, and any promise that a working copy's layout is stable across
  versions.

## Considered alternatives

- **Files as the truth, with SQLite as a rebuildable index.** The vault
  direction, and genuinely attractive: it needs no lock, no check-in, and no
  materializer, and every editor works all the time. Rejected because it moves
  the truth to the weaker representation. A file round-trips a database only
  while the schema holds nothing markdown cannot express, so the mapping stops
  being total the first time a relation or a computed field appears. It also
  trades write-time validation for lint-time validation, and discards a replica,
  a field-level merge, and a browser and phone story that already work, in
  exchange for indexing code that does not exist yet.
- **A permanently materialized read-only tree, with no working copy.** Rejected
  as insufficient rather than wrong. It serves reads well and is compatible with
  this record, but the marking is advisory: an agent's `Write` succeeds and the
  next materialization discards it, silently. A checked-out copy that is
  genuinely writable, and locked while it is, fails loudly instead.
- **A CLI or MCP server as the only write path, with no editable files at all.**
  Rejected: it is the friction difference between "point your agent at this
  folder" and "install our integration," and it gives up external editors
  entirely for a validation guarantee `patch` already enforces on the way in.
- **Mounting the replica as a filesystem (FUSE or FSKit).** The correct idea at
  the wrong cost. It removes materialization, staleness, locking, and check-in
  in one move, and every tool works against live data. Rejected because it is a
  different implementation per platform, sits in kernel-extension territory on
  macOS, and is a category of failure this team cannot absorb. Worth reopening
  if that changes.
- **Projecting the whole replica rather than one address prefix.** Rejected: it
  makes every working copy carry every app's data, and the lock would then span
  the whole system for the duration of an edit to one note.
