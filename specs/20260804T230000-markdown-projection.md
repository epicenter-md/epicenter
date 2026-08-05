# Markdown projection: working ADR-0207 backward

- **Status:** Draft
- **Decides nothing.** The decision is [ADR-0207](../docs/adr/0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md). This is the sequence for building it, and it is deleted when the work lands.

## Two blockers found before any wave

### The host that ADR-0207 assumes does not exist

The record says rendering is *continuous*. Continuous needs a process. ADR-0010
pointed at "the daemon materializes the workspace to Markdown," and that daemon,
`epicenter.config.ts`, mounts, and `apps/fuji` are all gone: `rg` finds no
`epicenter.config`, no `defineMount`, no `createMount`, and no `apps/fuji`.

The `epicenter` CLI is gone too. `apps/local-books/package.json` is the only
`package.json` in the repo with a `bin` entry, so ADR-0065's `epicenter matter
check` no longer ships anywhere.

So ADR-0207 needs a renderer host and a command surface, and neither is a small
detail: "continuous" is only true while something runs.

Leaning, not decided: `apps/epicenter` is the host. It already runs, already
holds the replica open, and already has filesystem access. `status` and `push`
are actions on it (ADR-0021 already makes actions the only surface that crosses a
process boundary), which also avoids two processes writing one SQLite file.

**Stop and ask before Wave 4.** This is a lifecycle owner decision, not an
implementation detail.

### The serializer is AGPL and the natural home is MIT

| package | license |
| --- | --- |
| `packages/data`, `packages/lens`, `packages/field`, `packages/sqlite` | MIT |
| `packages/matter-core` | AGPL-3.0-or-later |

ADR-0207 decides that serialization is `matter-core`'s and a second serializer is
refused. That decision **cannot be implemented inside `packages/data`**.
Importing AGPL into MIT is exactly the edge `bun run check:licenses` guards, and
copying the source across is a relicensing act.

Resolution, and it is better architecture anyway: **the renderer is AGPL and
lives outside the MIT toolkit.** `packages/data` never learns about YAML,
markdown, or the filesystem. The only thing that lands in MIT is the `body:
'text'` tag on `defineTable`, which is a string and touches no AGPL code.

This is not a workaround. A filesystem projection is an application concern, and
the split falls exactly where the licenses already put it.

## Owners in the final shape

| value | owner |
| --- | --- |
| row facts, outbox, sync | `packages/data` replica (unchanged) |
| the row document | `packages/data` documents runtime (unchanged) |
| a table's field types and `body: 'text'` | `packages/lens` |
| markdown text of a row | the renderer (AGPL, new) |
| what was last written to a file | the snapshot table, owned by the renderer |
| when files are written | the host process |
| applying a file back | `push`, through `patch` and one `Y.Text` transaction |

The snapshot table is the one genuinely new owner. It is not the replica's (that
is sync state) and not the Lens's (that is schema), so it gets its own reserved
prefix beside `_replica_*` and the renderer owns it alone.

## Waves

### Wave 1: the pure pair

The whole hard part, and it needs nothing that was deleted.

```txt
render(fields, body, definition) -> string
parse(text, definition)          -> { id?, fields, body } | RefusedClaim
plan(base, mine, theirs)         -> units to patch, body diff, conflicts
```

No filesystem, no SQLite, no host. Depends on `matter-core` and `lens` types.

Verification is a round-trip property: for any row conforming to a definition,
`parse(render(row))` returns the same values, and `plan(base, base, theirs)`
returns nothing to push. That second property is the one that protects a peer's
work, so it is the test that matters most.

Rollback point: nothing imports this yet.

### Wave 2: the declaration

`defineTable({ fields, body: 'text' })` in `packages/lens`, plus
`serializeTableDefinition` and `deserializeTable`. A closed vocabulary of string
tags; a callback here would break the JSON round trip and is refused by
ADR-0207.

Metadata only. It does not change `RowFor<T>`, since documents are reached
through `openDocument`.

### Wave 3: the snapshot table and the scan

`path`, address, fields object, body hash. Four columns, no `mtime`, no `size`,
no body bytes: a scan reads and parses everything, and the base body is
recoverable from the current render in the only case that ever needs it.

Produces a plan and writes nothing. Deletions are the set difference between the
table and the directory listing. Duplicate ids are detected here, and refused by
naming both paths.

### Wave 4: the renderer (blocked on the host decision)

Subscribe to row changes, write files, hold back exactly the cells with pending
edits, apply a peer's field change in place with `matter-core`'s
`applyFieldEdit`.

### Wave 5: push

Apply the plan: `patch` for fields, one `Y.Text` transaction for the body,
creation for a file with no id, deletion for a missing file. Per-file refusal on
a malformed claim, because no transaction spans rows.

### Wave 6: the command surface

`status` and `push`, in whatever form Wave 4's host decision produced.

## Deletion prize

**Near zero, and that is worth stating rather than manufacturing.** This is
additive: the mount and daemon this would have replaced were already deleted, so
there is no old path to stop importing.

The asymmetric refusals were all made during design and are already in the
record: no lock, no checkout, no git dependency, no watcher, no `materialize`
flag, no state vector, no text merge library, and no second serializer. Each one
deleted a code family before it was written. Looking for more deletion during
implementation would be looking in the wrong place.

## Recognition test

The destination exists when, with the host running:

```bash
cd ~/Epicenter/so.epicenter.honeycrisp/notes
rg "sync rewrite" .          # finds prose, no tool installed
$EDITOR $(rg -l "sync rewrite" . | head -1)
epicenter status             # names the changed fields and the changed body
epicenter push
```

and the edit appears on a second device.

It is violated by: a file that stays stale after a peer's change to a cell you
did not touch; a push that sends a field you did not edit; a body edit that
replaces the document rather than transacting on it; any file appearing under an
app data directory; or a lock anywhere.
