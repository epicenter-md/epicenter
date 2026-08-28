# 0274. A workspace's history is a generation, and restore creates one rather than overwriting

- **Status:** Superseded
- **Superseded by:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md). The proposal was right that a restore should create rather than overwrite, and wrong about where a generation lives: it becomes its own Durable Object, addressed by a number, which this record explains.
- **Date:** 2026-08-27
- **Would amend:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at how the authority replaces a workspace: create and re-point, rather than overwrite and rotate.
- **Relates:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) (the document identity this renames rather than replaces), [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (the authority's address), [ADR-0241](0241-a-store-is-truth-plus-debts-and-sql-is-a-composed-follower.md) (which reserved the destructive whole-document operation).
- **Unbuilt, and deliberately so.** Restore-over-live is deferred until a second device makes it matter (ADR-0272 splits restore; the cheap half needs none of this). This record exists so the expensive half is not designed from scratch under pressure, and so the retention argument below is not lost.
- **Proposed status is a decision to revisit, not a decision made.** `scripts/check-doc-hygiene.ts` will flag this if it sits here unresolved, which is the intended pressure.

## Context

ADR-0272 specifies restore as replacing a workspace under a new document identity, and describes the authority side as installing an envelope and renaming what it holds. That is overwrite-and-rotate: the previous history is gone the moment the new one lands.

Two things make that worth reconsidering before it is built.

**The identity is already a generation, in all but name.** ADR-0231 calls it "the opaque name of the history this log describes." A new history is a new generation, and the client already implements generation-switching: a replica whose stamped identity differs from the one its authority announces discards its record whole and refills. That code exists, is tested, and needs no change under either design.

**The argument against server-side retention was wrong.** It was refused during design on the grounds that keeping the previous state hands Epicenter readable plaintext of everything a person owns. That is true of the ARTIFACT, which is legible Markdown by construction (ADR-0268), and false of a generation, which is opaque CRDT bytes the authority already holds and never decodes (`sync/authority.ts`: "There are no Yjs imports in this file, and that is the design"). Retaining a generation spends none of the end-to-end encryption option the authority protects.

With that correction, the question is only where the previous state lives, and "in a generation that was never deleted" is cheaper than "copied into a second table before being overwritten."

## Proposal

**A workspace's history is a generation with its own identity and its own lifetime. Restore creates the next one and re-points; it never overwrites.**

```txt
  pointer, one per (principal, application)
    current = gen-3
    registry  gen-1  pruned
              gen-2  retained
              gen-3  current

  each generation owns its log and its snapshots.
  restore creates gen-4, fills it, and moves the pointer.
  gen-3 is untouched and still restorable.
```

**Nothing changes on the client.** It compares the identity it holds against the one announced and discards on a mismatch. Under this proposal that identity is the generation, so supersession becomes what it always described.

**A current replica pays nothing to connect.** It goes straight to the generation it holds. A stale one is told where the current generation is, once, and then discards and refills as it does today.

**Retention becomes a deletion policy rather than a copying step.** "Keep the previous state" is "do not delete the previous generation," and pruning is deleting one.

## What this record does not decide

Named rather than glossed, because they are the reasons this is Proposed:

- **One Durable Object per generation, or one object with generation-scoped storage.** Per-generation gives free deletion and isolation and costs a pointer hop; one object keeps the pointer beside the data and costs a scoping rule on every read.
- **How many generations are kept.** "Live plus one" mirrors `SNAPSHOTS_KEPT = 2` and the reasoning beside it ("the previous one is the only way back"), and gives exactly one undo. Keeping all of them turns a restore into a storage commitment nobody chose.
- **What creates a generation.** Restore certainly. Whether a Compact workspace action does too (ADR-0256, ADR-0267) is a separate product question, and if it does, generations stop being rare.
- **What a generation carries besides bytes.** A created-at, a reason, a size, if any of it is ever shown to a person choosing which one to go back to.
- **Blobs.** A generation holds rows that reference blobs by opaque content-addressed id (ADR-0148). Blobs are write-once and are not part of a generation, so restoring an older one should find its blobs still present, and pruning a generation should not collect them. That is probably already true and has not been checked.

## Why it is not built now

Restore-over-live is what needs it, and restore-over-live is deferred: it matters when a second device holds the workspace you are replacing, and until then the cheap half of restore (into an empty workspace, ADR-0272) covers migration and a fresh machine with no server change at all.

Nothing today forecloses this. The identity is already opaque, already compared rather than looked up, and belongs to no registry, so the day it becomes a generation is a change on the authority and nowhere else.

## Considered alternatives

- **Overwrite and rotate, as ADR-0272 describes.** Simpler on the server today, and it makes retention a copy-before-destroy step whose failure mode is losing the thing it was copying. Still viable, and this record exists to be compared against it rather than to have already won.
- **A global registry of document identities.** Refused. The identity is compared, never resolved: it lives in the authority's own metadata and in each replica's, and admission is equality between those two values. A registry would be a third copy of a fact that has exactly two, and a thing to keep in sync.
- **Keep the previous state as an artifact rather than a generation.** Refused on the correction above, in the other direction: an artifact is legible, so retaining one on the server is the plaintext problem a generation does not have.
