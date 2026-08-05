# Working copy delivery: three tiers over two functions

- **Status:** Draft
- **Decides nothing.** The decision is [ADR-0207](../docs/adr/0207-the-replica-is-the-truth-and-a-working-copy-is-a-temporary-locked-projection.md). This is the sequence for building it, and it is deleted when the work lands.

## The shape of the work

All three tiers are interfaces onto the same two functions:

```txt
materialize(addressPrefix) -> files      one row  -> one file
apply(file) -> patch + document transaction   one file -> one row write
```

Those two are the permanent asset. Git, a helper, and an HTTP endpoint are
packaging. Getting the pair right is the whole job; every tier after the first
is a better front door onto code that already exists.

The corollary matters for sequencing: **do not start at tier 2.** A remote
helper written before `apply` is proven is a protocol wrapped around a guess.

## Tier 1: shell out to real git

```bash
epicenter checkout so.epicenter.honeycrisp/notes ~/work/notes
#   ... edit in any editor, or with a coding agent ...
epicenter checkin ~/work/notes
```

**Checkout** materializes the prefix, runs `git init`, `git add -A`, and one
commit, writes `.epicenter-checkout.json` (address prefix, replica revision,
lock token, declined addresses), and locks the rows.

**Check-in** diffs the working tree against the checkout commit, applies each
changed file through `apply`, releases the lock, and removes the directory.

No git is implemented. The commands shell out to it.

Delivers external editors, agent editing, offline work, and review before
anything lands. Does not deliver `git pull`, cloning from another machine, or
server-side validation.

Open questions this tier must answer, and they are the real ones:

- Rendering a row document to markdown and applying the reverse as one Yjs
  transaction, without rebuilding the document.
- Which documents are declined, and how the working copy reports them.
- Whether a filename carries a decorative title slug beside the row id. Free to
  change later per ADR-0207, so pick the simple one first.
- What check-in does when the replica moved under an open copy. The lock should
  make this impossible; the code should still say what it does.

## Tier 2: a remote helper

An executable `git-remote-epicenter` on `PATH` makes any `epicenter://` URL work:

```bash
git clone epicenter://so.epicenter.honeycrisp/notes
git pull
git push
```

Declare the `import` and `export` capabilities, which let the helper exchange
`git fast-import` streams (line-oriented text) rather than packfiles. `fetch`
exports the current materialization as a commit; `push` receives a fast-export
stream and routes each changed path through `apply`.

Adds `git pull`, removes the explicit checkout step, and works from any
directory. Reuses tier 1's `materialize` and `apply` unchanged.

Blobs stay excluded, which is now load-bearing rather than tidy: a two megabyte
recording committed once sits in git history permanently and delta-compresses
badly.

## Tier 3: smart HTTP on the authority

```bash
git clone https://<host>/v/so.epicenter.honeycrisp/notes
```

Real `upload-pack` and `receive-pack` over HTTP against the authority, so any
machine clones with nothing installed and the server validates the push. A
rejected push is a line in the terminal:

```txt
! [remote rejected] main -> main (unknown field 'resonance' on table notes)
```

This is the tier that makes cloning against the synchronized database real, and
it is a genuinely different scale of commitment: the authority becomes a git
host, with auth, ref advertisement, and fast-forward-only enforcement.

Not scheduled. It earns itself when someone wants to clone from a machine that
has no Epicenter install, and not before.
