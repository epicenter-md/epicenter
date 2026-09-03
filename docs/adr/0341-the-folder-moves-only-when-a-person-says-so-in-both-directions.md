# 0341. The folder moves only when a person says so, in both directions

- **Status:** Proposed
- **Date:** 2026-09-02
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at its verb table, where `push` no longer ends in a re-render, and at `pull`'s refusal, which becomes an approval. Its cycle, its manifest, its completeness rule, and absence as a fact are unchanged. [ADR-0338](0338-the-folder-wins-and-a-push-is-one-approval.md) at "a file that cannot be read: rewritten from the store", which becomes kept as the person left it, and at its Consequences claim that a push ends by re-rendering the whole folder. Its one approval, its refusal to validate, and its ranking of the overview are unchanged, and this record gives the second verb the same shape.
- **Relates:** [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (who edits and who pushes), [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md) (why an admitted file is renamed, which is the one write a push owes the folder), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) (why there is no remote in this picture), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) and [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (the lens)
- **Built:** the writer both verbs share (`writeFolder`, whose one parameter is whose set of paths the checkout is), a push that sends the folder back with only what it touched replaced, `pull`'s approval, `FolderState` from `diff`, `FolderChanged`, and the deletion of `discardEdits` and `WorkingCopyDirty`.
- **Unbuilt:** `PlannedDiscard` is still called a discard rather than a keep, and `row-gone` is still one of its reasons rather than an admission, so an edited file whose note was deleted in the application does not yet come back as a note.

## Context

ADR-0337 gave the folder two verbs and one asymmetry nobody chose: `pull` asks
before it destroys, and `push` destroys without asking. A push ends by
re-rendering the whole folder, so a file it could not carry is overwritten in
the same act that pushes. The overview warns about it, which is the only reason
`PlannedDiscard` exists: it is not a description of a file, it is a notice that
your own push is about to delete something.

The worst case is a person who broke a frontmatter fence and pasted three
paragraphs under it. The push says "rewritten from your notes", they press
Enter, and the paragraphs are gone. In one arm it is worse: with the row deleted
in the application, the re-render never names that path, so the host's sweep
**removes the file** rather than rewriting it, and the word in the overview is
false.

Making an unreadable file mean nothing does not work, because absence is already
load-bearing. ADR-0338 made a missing file delete its row. If a file the app
cannot read is treated as a file that is not there, then one line too many in a
text editor deletes a note for good, and the overview reports it under "gone for
good" as though it had been asked for.

## Decision

**The folder is a working copy of this device's notes, and there is no third
place.** A store is bound to one authority (ADR-0325) and a socket keeps it
converged whether or not anybody opens the folder. So the folder is never
behind, a push is never rejected, and the local-versus-remote problem git spends
its complexity on does not exist here. Only two parties ever meet: the folder,
and the notes on this device.

**Both verbs show a list and take one approval.**

```txt
pull    here is what changes in your folder     confirm  →  every file is rewritten
push    here is what changes in your notes      confirm  →  what it could not read is left alone
```

`diff` prints either without changing anything. Neither verb runs on its own,
and between them the folder holds still. That is the whole cycle, and the same
renderer prints both lists.

**A push writes the folder back as it was, with the files it touched replaced.**
It is not a re-render. The set of paths sent is still the whole checkout
(ADR-0337's completeness rule is unchanged, and the host sweeps what a checkout
does not name), but every path the push did not touch is sent with the bytes the
folder already holds and keeps its existing manifest entry. The host skips a
write whose bytes already match, so nothing churns.

Three consequences fall out of that sentence, and none of them is a mechanism:

- **A file the push could not read is untouched**, because the push only
  replaces what it touched. Nothing decided to spare it.
- **Its manifest entry is carried forward**, which is not optional. A base that
  advanced past a file that did not move would read every value the store
  changed since as an edit the person made, and the next push would write stale
  values over newer ones.
- **The folder does not update itself.** A change another device made reaches
  the folder at the next pull, and not before.

**`pull` takes a plan and gives up `discardEdits`.** Confirming the list IS the
discard, so a refusal that printed what it refused over was an approval dialog
wearing another hat. Like `push`, it refuses a plan that stopped being true, so
neither verb can apply a list nobody read.

**A file the push cannot read is kept, and says so at every push until it is
fixed.** `PlannedDiscard` becomes `PlannedKeep`: a report of what did not go,
not a warning about what is about to be destroyed. The folder is dirty exactly
where the overview said it would be, and the one verb that can clear it is the
one a person picks.

**An edited file whose row is gone comes back as a note.** The folder wins
(ADR-0338), so a file somebody typed into and a store with nowhere to put it is
an admission, minting a new id like any other file nobody pulled. It fires only
because the file was touched: a file identical to its base says nothing, whatever
the store did, which is what keeps this from being the resurrecting folder
ADR-0337 refused.

**A push applies everything it can read.** Keeping a file is about the folder,
never about the store: a file whose body a codec refuses still has its
frontmatter values applied, because the values and the body are separate regions
and only one of them is unreadable.

## Consequences

- **Nothing a person typed is destroyed by a push.** The one destructive verb is
  `pull`, it is the one that already said so, and it is chosen.
- **"The folder is never dirty after a successful push" is withdrawn.** It is
  never dirty except at the files the overview named as kept, which is a promise
  a person can check by reading the list they approved.
- **What deletes:** `discardEdits`, `WorkingCopyDirty`, the `row-gone` reason,
  and `push`'s call to `pull`.
- **A person who never breaks a file never meets any of this.** Every new
  concept here is reachable only by editing a file into a state the folder's own
  `AGENTS.md` documents as wrong.
- **An agent gets a folder that holds still.** ADR-0330 gives an agent the
  surfaces a person uses; a surface that rewrites itself under a working agent
  is one an agent cannot reason about, and a file it left half-written survives
  a push it did not make.
- **The `kv.json` edit is kept rather than reported and overwritten**, which is
  honest and also permanent until kv becomes pushable (ADR-0338's `Unbuilt:`).
  A person editing settings in the folder now has a file that nags forever, and
  that is the argument for finishing kv rather than an argument against this.

## Considered alternatives

- **A push sets the file aside as `<id>.md.kept` and rewrites the original.**
  Rejected. The host writes only paths that pass `isCheckoutPath`, so it would
  drop the file silently, and widening that rule costs a second exception to the
  sweep. Worse, the natural repair is fatal: an agent that finds
  `notes/9f2c.md.kept` fixes the frame and renames it back, and now two files
  claim one row, so the push mints a duplicate note.
- **A file the push cannot read is treated as absent.** Rejected, and it is the
  reason this record exists. Absence means deletion, so a broken fence would
  delete a note for good.
- **A push re-renders only the rows it changed and leaves the rest stale.**
  Rejected as indistinguishable in effect and worse in wire shape: it needs a
  second host mode that writes without sweeping, where sending the folder back
  with substitutions needs none.
- **Keep the re-render and print the file's bytes in the overview before
  destroying them.** Rejected. It makes the warning honest and the act no less
  destructive, and the bytes can be a megabyte.
- **`pull` keeps its refusal and gains a preview.** Rejected as the same dialog
  twice. A refusal that lists what it refused over, beside a button that
  proceeds anyway, is an approval.
