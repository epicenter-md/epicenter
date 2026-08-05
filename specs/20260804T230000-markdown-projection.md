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
markdown, or the filesystem. The only thing that lands in MIT is the `body` key
on `defineTable`, which is a field name and touches no AGPL code.

This is not a workaround. A filesystem projection is an application concern, and
the split falls exactly where the licenses already put it.

It lives at `apps/epicenter/src/folder/` rather than in a package. The host is
the only consumer: the command surface calls actions (ADR-0021) rather than
importing this, so a package would be speculative. Promoting it later is a
directory move.

## Owners in the final shape

| value | owner |
| --- | --- |
| row facts, outbox, sync | `packages/data` replica (unchanged) |
| the row document | `packages/data` documents runtime (unchanged) |
| a table's field types and which one is the body | `packages/lens` |
| markdown text of a row | `apps/epicenter/src/folder/` |
| what was last written to a file | the snapshot table, owned by the renderer |
| when files are written | the host process |
| applying a file back | `push`, through `patch` |

The receipt store is the one genuinely new owner. It is not the replica's (that
is sync state) and not the Lens's (that is schema), and it cannot live in
`epicenter.sqlite3` anyway: `createEpicenter` returns a frozen surface with no
database handle on it. It is the host's own store under the app data root.

## Waves

### Wave 1: the pure pair

The whole hard part, and it needs nothing that was deleted.

```txt
renderRow({ id, fields, definition }) -> string
parseRow(text, definition)            -> { id?, fields } | RefusedClaim
planPush({ claim, base })             -> create | patch | unbased
```

No filesystem, no SQLite, no host. Depends on `matter-core` and `lens` types.

Verification is a round-trip property: for any row conforming to a definition,
`parse(render(row))` returns the same values, and a claim matching its receipt
plans nothing to push. That second property is the one that protects a peer's
work, so it is the test that matters most.

Rollback point: nothing imports this yet.

### Wave 2: the declaration

`defineTable({ fields, body: 'content' })` in `packages/lens`, plus
`serializeTableDefinition` and `deserializeTable`. The value is one of the
table's own `string` fields, constrained to `keyof TFields` at authoring time and
stored as a plain `string` so `TableDefinition<TFields>` stays assignable to a
bare `TableDefinition`.

It changes where a value is written, never what the row holds.

### Wave 3: the receipt store and the scan (done)

`openReceiptStore` over `bun:sqlite` in the host's app data root: path, address,
fields. No `mtime` and no `size`; a scan reads and parses every file, which is
slower and has no racy-index edge case.

`scanFolder` produces one entry per path and writes nothing: `claim`, `new`,
`refused`, `gone`, `duplicate`, `unknown-table`. Deletions are the set difference
between the receipts and the directory listing. Duplicate ids name every path
rather than guessing.

### Wave 4: the renderer (done, except for the subscription)

`renderIntoFolder` brings one row's file up to date and records what it wrote.
Per field: if the file still holds what was written into it, take the row; if it
does not, you changed it, so leave your value alone. A touched field keeps its
OLD receipt value, so the edit stays visible to the next push.

Receipts are keyed by address rather than path, so a rename carries its receipt
and stays free (ADR-0207) instead of reading as a deletion plus a baseless
stranger.

Remaining: wire it to `subscribeCommittedAddresses`, which `@epicenter/data`
exports for exactly this caller, since the host is the process that constructed
the runtime. `desktop-owner.ts` is the precedent.

### Wave 5: push

Apply the plan: `patch` for fields, creation for a file with no id, deletion for
a missing file. Per-file refusal on a malformed claim, because no transaction
spans rows. Nothing here touches a row document.

### Wave 6: the command surface

`status` and `push`, in whatever form Wave 4's host decision produced.

## Deletion prize

**Near zero, and that is worth stating rather than manufacturing.** This is
additive: the mount and daemon this would have replaced were already deleted, so
there is no old path to stop importing.

The asymmetric refusals were all made during design and are already in the
record: no lock, no checkout, no git dependency, no watcher, no `materialize`
flag, no text merge, no ProseMirror, no second serializer, and above all no row
documents in the folder at all. Each one deleted a code family before it was
written. Looking for more deletion during
implementation would be looking in the wrong place.

## Recognition test

The destination exists when, with the host running:

```bash
cd ~/Epicenter/so.epicenter.skills/skills
rg "sync rewrite" .          # finds prose, no tool installed
$EDITOR $(rg -l "sync rewrite" . | head -1)
epicenter status             # names the changed fields
epicenter push
```

and the edit appears on a second device.

It is violated by: a file that stays stale after a peer's change to a field you
did not touch; a push that sends a field you did not edit; any file appearing
under an app data directory; a row document being read or written by the
renderer; a prompt asking you to resolve anything; or a lock anywhere.
