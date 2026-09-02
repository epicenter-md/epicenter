# 0337. The folder is a working copy, and pull and push are the whole cycle

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) by withdrawing the continuous render and the one-way rule; [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md) by making the folder a working copy rather than only a mint source; [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the return path's mechanism, keeping its rule that values round-trip and a body does not
- **Relates:** [ADR-0234](0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md) (which invented this shape for one table and never generalized it), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (the backup), [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (who edits and who pushes)
- **Unbuilt:** all of it. `renderArtifact` and `readArtifact` exist; the manifest, the three verbs, and the deletions below do not.

## Context

`~/Epicenter` was asked to be four things at once: a durable copy, a place to
grep and run an agent, a git artifact, and a surface external tools could edit.
Three of those are reads and get along. The fourth is a write, and it is where
every hard question came from.

Two prior records had already taken the frame apart without finishing it.
ADR-0289 withdrew the premise that an always-current folder is the product,
said "Epicenter has no always-current agent-facing surface," and left deleting
`packages/data/src/artifact/mirror.ts` as an available decision it did not take.
ADR-0234 replaced continuous rendering with "an explicit checkout of a page row
and its prose document," with one local base record per materialized page, for
the Ark alone.

The continuous render's last justification went with ADR-0336. ADR-0271 promoted
the folder because `navigator.storage.persist()` is refused in the Tauri WebView
(ADR-0275), so the folder was the copy that outlived a reclamation. An account is
required now, so the authority holds the rows and an eviction is a cache miss
(ADR-0292), not a loss.

What was left was the write direction, and a filesystem cannot carry the fact it
needed. A changed file proves someone typed those bytes. A new file proves the
same. A missing file proves nothing: a person deleting a note, `git checkout`, a
half-finished Dropbox sync, and a Time Machine restore all produce one signal.

## Decision

**`~/Epicenter` is a working copy. `pull` fills it, `push` sends it back, and
nothing happens in between.**

```txt
~/Epicenter/<data-id>/
  .epicenter/manifest.json     what pull handed over, and from where
  <table>/<row-id>.md          one row, frontmatter and body
```

```txt
pull    render rows into the folder and write the manifest
diff    print the push plan and change nothing
push    show the plan, apply on confirm, then re-render
```

The three verbs are actions in the application's window. The application
renders, diffs, and decides; the host does one thing per verb through a route
under `MIRROR_PATH` (`apps/epicenter/src/routes.ts`), writing the files `pull`
hands it or returning the folder's files for `push`. There is no CLI.

**The manifest is the base.** There is no per-file base store and no watcher,
because `pull` already wrote down what it handed over.

```txt
{ baseURL, principalId, dataId, generation, pulledAt,
  rows: { "<table>/<row-id>": { values: { ... }, bodyHash } } }
```

**Absence is unambiguous at push, because the manifest says what was pulled and
a person chose the moment.** A missing file is a deletion in the plan. Where a
table names a trash field it lands there, as a value. How a table names one is
unbuilt; Honeycrisp's is `deletedAt` (`apps/honeycrisp/src/lib/data/index.ts`),
so a deleted file trashes a note and never removes a row, and until a table can
name one, a missing file for any other table is refused in the plan. Removing a
row stays the dialog in
`apps/honeycrisp/src/routes/components/NoteCard.svelte` that reads "This action
cannot be undone."

**A person whose manifest is stale resolves it inside the push they asked for,
and nothing on disk is rewritten to hide that.** Each field has three values:
`base` from the manifest, `file` from disk, and `store` now.

| base, file, store | what happens |
| --- | --- |
| `file == base` | the person did not touch it; the store's value stands and the plan says nothing |
| `store == base` | apply the file's value |
| `store == file` | already converged; nothing to do |
| all three differ | a conflict on that field, resolved in the plan |

```txt
push 412 files: 41 values, 1 deletion, 2 conflicts

  notes/9f2c.md   status   draft -> shipped
  notes/8a11.md   deleted  -> trashed
  notes/4d70.md   title    yours "Q3 plan" / theirs "Q3 planning"   [mine|theirs]
```

A body is not merged. An edited body pushes as ADR-0329's whole-value replace
only while the store's body still hashes to what `pull` rendered; otherwise the
person picks one. No conflict marker is ever written into a file, no `.orig` is
left behind, and the unit is always a field.

**`pull` refuses a dirty folder**, one whose files no longer match the manifest.
It shows the unpushed edits, and discarding them is the way past.

**`push` ends by re-rendering**, so a folder is never dirty after a successful
one.

**An agent edits; a person pushes.** `pull` writes an `AGENTS.md` at the folder
root from `compileData`'s output (`packages/data/src/definition/compile.ts`):
the tables, their fields and types, and the three rules an agent needs. A
missing file is a deletion. A body is replaced whole or not at all. An agent
never pushes. ADR-0330 makes the diff the thing that
makes an agent's work reviewable, and an agent that pushes its own work deletes
the review.

## Consequences

- **Deleted, once this ships:** `packages/data/src/artifact/mirror.ts` and its
  test, `apps/epicenter/src/mirror.ts` and its test, `MIRROR_ROUTE` in
  `apps/epicenter/src/routes.ts` and its handler in
  `apps/epicenter/src/server.ts`,
  `parseMirrorPass` in `packages/data/src/artifact/protocol.ts`, and the
  `attachMirror` wiring in `apps/honeycrisp/src/lib/databases.ts`. About 740
  shipping lines and 500 lines of test.
- **Never built:** ADR-0329's folder watcher, its echo suppression, its per-file
  base store, and the absence policy that watcher would have needed. Finishing
  the continuous design needed all four; the manifest replaces them.
- `renderArtifact` is `pull`'s half and `readArtifact` is `push`'s; `layout.ts`
  and `frontmatter.ts` serve both and are unchanged. `readArtifact` also stays
  the reader a mint uses (ADR-0293), which reads the folder as it is and
  consults no manifest.
- **The host gains a route that reads the folder**, which
  `apps/epicenter/AGENTS.md` refused under ADR-0271. That refusal served the
  one-way rule and goes with it. The host still holds no rows: it writes and
  reads files, and the application does the diff.
- **A person loses the incidental edit.** Fixing a typo in vim no longer lands by
  itself; it waits for a push. The application is one window away and was always
  faster for one field. Pulling a clean folder is safe in a way pushing never
  was, so freshness can return later without the watcher.
- The backup is the generation (ADR-0281), and it was already, since ADR-0289.
  A folder is current as of its `pulledAt` and says so.

## Considered alternatives

- **Keep the continuous mirror and add a watcher.** Rejected. It needs a base
  store, echo suppression, a debounce, and a policy for absence that no
  filesystem signal can justify, and it makes every `git checkout`, Dropbox
  sync, and Time Machine restore into an edit nobody made.
- **Refuse deletion through the folder.** Rejected. It makes a folder that resurrects files a person deleted, which is the
  behavior people already distrust in iCloud Drive, and it is unnecessary: the
  manifest makes absence a fact, and a trash field makes it cheap.
- **A threshold that refuses a push with too many deletions.** Rejected as a
  heuristic standing in for a fact. The confirmation is already the guard.
- **Two folders: a read-only mirror plus checkouts elsewhere.** Rejected. It asks
  a person to know which copy reverts and which one pushes, and the failure is
  editing the wrong one.
- **`export` and `import` as the verb names.** Rejected: those name re-homing
  between authorities (ADR-0325). ADR-0207's `push` was a continuous scan against
  host-owned receipts; this one is a deliberate cycle against a manifest that
  `pull` wrote, and the word is free.
