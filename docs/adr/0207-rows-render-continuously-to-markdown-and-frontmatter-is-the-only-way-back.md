# 0207. Rows render continuously to markdown, and frontmatter is the only way back

- **Status:** Accepted
- **Date:** 2026-08-04
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 lands with this branch, so 0207 is the next free integer today. Reconcile at merge time (`docs/adr/README.md`).
- **Unbuilt:** nothing implements this. No renderer, no `epicenter push`, no snapshot table, and `defineTable` carries neither `materialize` nor `body`. The record decides the shape; the code does not exist.
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

The renderer holds back **exactly what you could still push, and shows current
state everywhere else**. A cell you changed is pending intent and is left alone.
A cell you did not touch is updated in place. A body you did not touch is
re-rendered. One rule with no exceptions, so no file ever drifts outside the
cells you are actively editing, and the folder never becomes a patchwork of
current and stale rows that look identical.

### `epicenter push` is the only write door

Nothing leaves the machine because a file changed. `status` and `push` are scans,
run when you type them; there is no watcher, so an edit made while the engine was
stopped is found exactly as if it had been running.

Push compares three values per unit, where a unit is one scalar field or the
body: `base`, the snapshot recorded when the file was written; `mine`, the file
now; `theirs`, the row now.

| condition | result |
| --- | --- |
| `mine == base` | untouched. Send nothing, and a peer's change to it survives. |
| `mine != base`, `base == theirs` | you changed it alone. **Patch** the field, or apply the body diff. |
| `mine != base`, `base != theirs` | you both changed it. **Show it and stop.** |

Fields and the body take the same three rows, which is what makes the design one
rule rather than two behaviors that resemble each other.

The snapshot lives in a table in `epicenter.sqlite3`, never in the folder, so the
directory holds no hidden state and `rm -rf` on it costs nothing. It records
`path`, the fields object, the body bytes, `mtime`, and `size`; a scan `stat`s
and parses only what moved. Where mtime and size cannot distinguish a same-second
edit from the renderer's own write, hash the bytes, as git does for the same
reason.

A stale file cannot silently revert anything, however long it has been sitting
dirty, because the comparison is per unit. A file untouched for a month pushes
only the cells you actually changed.

### The body is a declared text document, and it round-trips

`RowDocument` exposes `Y.Doc['get']`, so a row document is an arbitrary Yjs
document today and nothing types it. A `YXmlFragment` behind a rich text editor
has no honest markdown round trip. This record therefore adds the first
declaration of a document's shape, alongside the fields the Lens already types:

```ts
defineTable({ fields: { ... }, materialize: true, body: 'text' })
```

A table declaring `body: 'text'` owns one `Y.Text`, renders it as the file body,
and accepts edits back. A table declaring no body renders frontmatter and an
empty body. A table whose document is a `YXmlFragment` or any richer structure
declares no body and is never asked to round-trip through markdown, which is the
honest outcome rather than a lossy one.

**The declaration is a closed vocabulary of string tags, never a callback.**
`TableDefinition` round-trips through `serializeTableDefinition` and
`deserializeTable`, so `'text'` crosses the wire as-is while a render function
could not. Supporting a second document shape later means adding a tag and the
renderer behind it, in this repository, rather than opening a plugin surface that
every table definition would then have to carry.

A push diffs the file's body against the base bytes and applies the result to the
`Y.Text` as inserts and deletes inside one transaction. The document is **never
replaced**, so its update chain and publication revision (ADR-0174) survive the
round trip.

This is cheap for one reason worth stating, because it was mispriced twice during
design: the hard case, applying your edit to a document a peer already moved,
never reaches the merge code. Concurrent edits stop at push like any other
conflict. What remains is a document whose rendered body still equals the base
byte for byte, where a plain text diff's offsets are already correct.

### Each file is a claim, and claims are judged independently

The `id` in frontmatter binds a file to a row, so the filename is decoration and
renaming is never ambiguous. Absence of an id is a positive signal rather than an
accident: a file with no id creates a row, and the minted id is written back into
the file at push.

Duplicate ids are the failure this actually produces, because `cp a.md b.md`
makes one. Push refuses, names both paths, and asks which is the row. It never
guesses.

A malformed claim is refused **per file, never per push**. No transaction spans
rows, so a value that is a valid YAML scalar but wrong for its declared field has
nothing to do with a valid claim on a different row. Push names the file and the
field, applies everything else, and leaves the bad file for you to fix.

### Deletion is expressible, and always shown

A missing file whose path is in the snapshot is a pending row deletion. This is
the one place the folder's *absence* carries intent, so a backup tool, a bad
glob, or a disk fault becomes a queued deletion. It is therefore always listed in
`status`, and **no flag may skip the deletion section of a push**.

### Serialization is Matter's, and is not rewritten

`packages/matter-core` already publishes the round trip: value-identity rather
than byte-identity, YAML 1.2 core with no Norway coercion, the body carried
verbatim through a frontmatter write, and a nullish contract where clearing a
field deletes the key instead of writing `null`. `applyFieldEdit` is exactly the
in-place field write this needs, and it is what lets a peer's field change land
on a file whose body you are editing. A second serializer is refused.

Parsing is schema-directed by the Lens, so a value that is a valid YAML scalar
but wrong for its declared field is refused rather than coerced. The body diff is
this record's own concern and sits above that boundary; `matter-core` owns the
frontmatter fence and nothing else.

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
  contention question is answered by per-unit merge rather than by an owner.
- **One rule covers fields and bodies alike:** hold exactly what you could still
  push, show current state everywhere else. Two things that look alike in a file
  behave the same way, which is the property the read-only-body version could not
  offer.
- **The Lens now types a row document, which it never did before.** That is a new
  responsibility for `defineTable` and a new field in the serialized form, and it
  is the price of one universal projection rule instead of per-app rendering.
- **What this forecloses:** files as a durable form, a watcher that publishes on
  save, a second write path that bypasses `patch`, blob bytes on disk, a lock on
  any row, app-supplied render or parse callbacks in a table definition, and any
  promise that the layout is stable across versions.

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
- **Read-only bodies, with only frontmatter pushable.** Held briefly and
  rejected, because it is the one place two things that look alike in a file
  would behave differently: a changed field is held for you, a changed body is
  discarded. It was adopted on a mispricing. The expensive case, applying your
  edit to a document a peer already moved, never reaches the merge code, because
  concurrent edits stop at push like any other conflict. What was left is a text
  diff against a base that still matches byte for byte.
- **App-supplied render and parse functions on a table definition.** More
  expressive and immediately fatal: `TableDefinition` serializes to JSON, and a
  function does not cross that boundary. A closed vocabulary of string tags keeps
  the definition portable and keeps every renderer in one repository where it can
  be tested.
- **Guessing the document's shape at runtime** by opening it and looking for a
  `Y.Text`. Rejected: `Y.Doc['get']` coerces, so guessing wrong on a
  `YXmlFragment` corrupts rather than fails, and it would make what appears on
  disk a function of runtime state rather than the schema.
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
