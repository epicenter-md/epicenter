# 0207. Rows render continuously to markdown, and frontmatter is the only way back

- **Status:** Accepted
- **Date:** 2026-08-04
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 lands with this branch, so 0207 is the next free integer today. Reconcile at merge time (`docs/adr/README.md`).
- **Unbuilt:** nothing implements this. No renderer, no `epicenter push`, no snapshot table. The record decides the shape; the code does not exist.
- **Relates:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md) (one fact relation and a path-safe row id, which is what makes one projection rule sufficient), [ADR-0010](0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md) (refused a continuous appdata sidecar and named the folder-the-user-controls shape this builds), [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) and [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) (Matter runs this same mapping at the opposite polarity and owns the serializer), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) (this adds no query surface), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (app data is machine-facing; this is not), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md), [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md), [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md)

## Context

Every durable fact this system holds is reachable only through an application.
A row's fields are JSON in one relation and a row document is a chain of Yjs
updates, so no editor, no shell tool, and no coding agent can read a body without
going through code written for the purpose. ADR-0176 keeps predicates out of the
typed surface and ADR-0162 gives ad hoc inspection to Home, but neither hands
anyone a directory.

ADR-0010 already refused one answer to this. A draft branch materialized each
recording to a hidden appdata sidecar, and the refusal named the reason
precisely: "a continuous producer with no consumer, paid on every edit." The
files were in `~/Library/Application Support`, where no human, agent, or CLI
would ever look. That same record then named the shape it would accept, a folder
the user controls alongside a SQLite surface the agent reads, and deferred it
until a real reader existed.

The reader exists now, and it is a coding agent with `ls`, `Read`, and `Edit`.

Two things changed what this costs. ADR-0206 collapsed the address space to one
relation, one depth, and a row id already safe in a path segment, so a projection
needs exactly one rule. And Matter (ADR-0065, ADR-0026) has been running this
exact mapping in production at the opposite polarity, which means the markdown
round trip is a solved, tested problem rather than a thing to invent.

## Decision

**Rows render continuously to markdown in a folder the user controls, and
frontmatter is the only way back.**

### One human-facing location

```txt
~/Epicenter/
  epicenter.sqlite3
  so.epicenter.honeycrisp/
    notes/
      <row>.md
```

Home directory, capitalized, no dot. That is the convention every tool in this
category converged on independently (`~/Dropbox`, `~/OneDrive`, and the same path
under `%USERPROFILE%` on Windows), and lowercase-with-a-dot is the signal for
hidden machine state, which this is not. Configurable, but the default has to be
typeable, because "point your agent at `~/Epicenter`" is the whole product.

This is **not** the app data root (ADR-0201). That directory holds the SQLite
partition, blob bytes, and caches, is explicitly not an inter-app API, and
putting a human surface in it recreates exactly the failure ADR-0010 refused.
Both representations sit in one directory on purpose: an agent that wants prose
reads the markdown, and an agent that wants a real query opens the database
beside it.

### Materialization is continuous, declared, and never destructive

A table opts in at schema time, not at use time:

```ts
defineTable({ fields: { ... }, materialize: true })
```

The app author knows which tables are prose and which are bookkeeping, so `ls`
shows everything that will ever be there and there is nothing to configure or
remember. `defineTable` takes a single `fields` key today, so this is an additive
option; `SerializedTableDefinition` grows the field too.

The renderer **never overwrites a file whose bytes differ from what it last
wrote**. When a field changes underneath a file you have edited, it applies that
one field edit in place, leaving the body and every other key untouched.

### `epicenter push` is the only write door

Nothing leaves the machine because a file changed. `status` and `push` are scans,
run when you type them; there is no watcher, so an edit made while the engine was
stopped is found exactly as if it had been running.

Push compares three values per field: `base`, the fields snapshot recorded when
the file was written; `mine`, the file's frontmatter; `theirs`, the row now.

| condition | result |
| --- | --- |
| `mine == base` | untouched. Send nothing, and a peer's change to it survives. |
| `mine != base`, `base == theirs` | you changed it alone. **Patch.** |
| `mine != base`, `base != theirs` | you both changed it. **Show it and stop.** |

The snapshot lives in a table in `epicenter.sqlite3`, never in the folder, so the
directory holds no hidden state and `rm -rf` on it costs nothing. It records
`path`, the fields object, `mtime`, and `size`; a scan `stat`s and parses only
what moved. Where mtime and size cannot distinguish a same-second edit from the
renderer's own write, hash the bytes, as git does for the same reason.

### The body is read-only

The body renders and is never applied back. Reading is the dominant use by a wide
margin, and one-way rendering costs no diff, no Yjs state vector, no operational
transform, and no merge. A body edit fails **loudly** in `status` rather than
vanishing.

Deferred, not refused. Making bodies writable means diffing against the bytes
last written and applying the result as Yjs operations, which is sound but
requires storing a state vector beside each file. Reopen it when someone has
actually tried to edit a body in the folder and been stopped.

### Deletion is expressible, and always shown

A missing file whose path is in the snapshot is a pending row deletion. This is
the one place the folder's *absence* carries intent, so a backup tool, a bad
glob, or a disk fault becomes a queued deletion. It is therefore always listed in
`status`, and **no flag may skip the deletion section of a push**.

A new file with no id in frontmatter creates a row; the id is minted at push and
written back into the file. Because the id lives in frontmatter rather than the
path, renaming a file is free and never ambiguous.

### Serialization is Matter's, and is not rewritten

`packages/matter-core` already publishes the round trip: value-identity rather
than byte-identity, YAML 1.2 core with no Norway coercion, the body written
verbatim and never reparsed, and a nullish contract where clearing a field
deletes the key instead of writing `null`. `applyFieldEdit` is exactly the
in-place field write this needs. A second serializer is refused.

Parsing is schema-directed by the Lens, so a value that is a valid YAML scalar
but wrong for its field is refused at push rather than coerced.

### Blobs never enter

A row's blob (ADR-0173) is not materialized. Frontmatter carries the id and
nothing else. This is not a limitation to lift.

### The layout is derived, and is not a compatibility surface

Nothing durable records how the folder was laid out. Filenames, frontmatter
serialization, and body rendering are all functions of the replica, and changing
any of them is re-rendering rather than migrating. The row id in frontmatter is
what binds a file to a row; the filename is decoration and owes nothing to a
previous version.

## Consequences

- An agent reads and edits with `cd`, `ls`, `Read`, and `Edit`, with no tool to
  install, no schema to discover, and no capability to grant.
- **ADR-0010's test is the one this must keep passing.** A continuous producer
  needs a consumer. The consumer here is a coding agent in a directory the user
  can name, which is precisely what appdata was not. If `~/Epicenter` stops being
  where people look, ADR-0010's objection returns and is correct.
- **Push is not a second sync path.** A patch lands in the replica and travels by
  the outbox that already exists. Markdown never touches sync.
- **ADR-0176 is untouched.** No predicate, ordering, page, or cursor is added.
  Rendering a table is `scan` with a different output.
- **Matter and this share a serializer, not a polarity.** Matter is disk-as-truth
  with a disposable SQLite projection; this is SQLite-as-truth with a disposable
  folder. ADR-0065 forecloses merging them, since sync and accounts are out of
  Matter's definition by design.
- No lock, so no application ever has to implement a frozen state, and ADR-0203's
  contention question is answered by field-level merge rather than by an owner.
- **What this forecloses:** files as a durable form, a watcher that publishes on
  save, a second write path that bypasses `patch`, blob bytes on disk, a lock on
  any row, and any promise that the layout is stable across versions.

## Considered alternatives

- **Files as the truth, with SQLite as a rebuildable index.** Matter's polarity,
  and it genuinely works, which is why it ships. Rejected here because it moves
  the truth to the weaker representation: the mapping stops being total the first
  time a schema holds something markdown cannot express, and it discards a
  replica, a field-level merge, and a browser and phone story that already work.
- **A temporary checked-out copy, locked for its duration.** The previous version
  of this record. Rejected once the comparison was done honestly: a checkout has
  the *same* conflict surface as a continuous folder, because two writers touched
  one row either way, and it adds staleness on every file you did not edit. The
  lock it needs would also have to be implemented as a visible frozen state in
  every application.
- **A watcher that publishes every save.** Rejected: no review before anything
  lands, and `rm` reaches the synced database instantly. The read/write asymmetry
  is real, and one mechanism cannot serve both.
- **A read-only tree with no write path at all.** Rejected as insufficient. An
  agent's `Write` would succeed and the next render would discard it silently.
- **A CLI or MCP server as the only write path.** Rejected: it is the difference
  between "point your agent at this folder" and "install our integration," and it
  gives up every external editor for a guarantee `patch` already enforces.
- **`git clone epicenter://` via a remote helper.** Attractive and genuinely
  supported by git, but redundant. The folder is a real directory, so `git init`
  in it gives you log, diff, and branches today with no code from us, and your
  other machines already have the folder because they sync. Cloning only serves a
  machine that will never run Epicenter, which `git push` to any host solves.
- **Mounting the replica as a filesystem (FUSE or FSKit).** The correct idea at
  the wrong cost: a different implementation per platform, kernel-extension
  territory on macOS, and a category of failure this team cannot absorb. Worth
  reopening if that changes.
- **Materializing into the app data root.** Rejected by ADR-0010 already, for the
  reason that record gives.
