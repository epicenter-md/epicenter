# 0279. An application has two databases, and copying a row is the verb

- **Status:** Accepted
- **Date:** 2026-08-28
- **Supersedes:** [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md). Two of them stay and both stay visible; what changes is the verb. A move is not a primitive, it is a copy and a delete, and the store ships only the first.
- **Relates:** [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md) (why a chosen id is normally unsafe, and why it is safe here), [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the codec a copy carries a document through), [ADR-0169](0169-row-references-are-non-enforcing-table-interpretations.md) (what a reference is, and is not).
- **Unbuilt.**

## Context

ADR-0270 named moving a row the primitive, and then described it as adding to the destination and removing from the source. A primitive that is defined as two things is two things, and calling it one hides the window between them: for a moment the row is in both places, and someone has to decide what that means.

It also gave the wrong reason for keeping the row's id. "The row keeps its id, so anything referring to it still does" is not true of the source, where the referrers are and the row no longer is. It is true of a *set* moved together, which is a different and better argument.

## Decision

**An application opens two databases: one local to this device, one for the account. Both stay visible in one surface, and the store still hands over both.** Unchanged from ADR-0270, including its refusal to collapse to one.

**The store's verb is `copy`. There is no `move`.**

- A copy adds a row to the destination and leaves the source alone. It is one row, additive, and it fails without having done anything.
- A move is a copy and then a delete, composed by the application, which already has both.
- The middle state is real and now belongs to whoever caused it. A copy that succeeded and a delete that failed leaves the row in both places, which a person can see and fix. ADR-0270's "reported and left where it started" contract was describing that window from inside a verb that pretended not to have one.

**A copy carries the document through the table's `file` codec**, `serialize` out and `deserialize` in, exactly as ADR-0270 specified and for the same reason (ADR-0268).

**The row keeps its id, and here is why that is safe.** A chosen id is normally the unsafe case: a row is a nested type addressed by its struct id, so two devices creating one at the same key converge by last-writer-wins and one device's fields are silently gone — measured at 96/104 over 200 runs, decided by a random `clientID` (`store/document.test.ts`). What makes it safe here is that **every copy between these two databases has an unsynced end.** The local database is per-device and syncs with nobody, so two devices can never hold the same local row to copy, and two devices copying out of the account into their own local databases write into databases that meet no one. There is no pair of writers to collide.

**Keeping the id is what makes a multi-row copy preserve its links.** A note carries `folderId`, a reference in ADR-0169's sense: non-enforcing metadata naming a target table. Copy a folder and its notes with minted ids and every `folderId` points at nothing; copy them with their ids and the set arrives intact, with no reference rewriting anywhere.

**The first copy into an account asks once**, naming the server. Unchanged from ADR-0270: the moment private rows first leave the machine is a consent moment.

## Consequences

- The store gains one verb rather than one, and loses a contract. `copy` either happened or did not; there is no partial-move semantics, no "left where it started", and no per-row failure report inside a single operation.
- **Duplicating a row into the other database becomes possible**, and it was not before. A verb that always removed the source refused a thing people want for no reason other than its name.
- Bulk is still selection plus repetition, with no migration mode, wizard, importer, or progress model.
- The application owns the window where a row exists twice. That is more honest than a verb that owned it silently, and it is the only new thing an application has to think about.
- The codec stays load-bearing in a third direction (export, restore, and now copy), and a lossy round trip is still a bug report rather than an accepted loss.

## Considered alternatives

- **Keep `move` as the primitive.** Refused. It is a copy and a delete under one name, the window exists either way, and owning it inside the verb is what forced the partial-failure contract that this record deletes.
- **Mint a new id in the destination.** Refused. It is the safer-sounding option and it buys nothing here, because the collision it protects against needs two synced writers and every copy between these two databases has an unsynced end. It costs reference rewriting on every multi-row copy, or dangling `folderId`s.
- **Ship `copy` and `move` both.** Refused as the shape that produces two ways to do one thing. `move` is two calls an application can make in the order it wants, and the order is sometimes the interesting part: copy-then-verify-then-delete is a reasonable thing to want, and a `move` verb forbids it.

## Naming, unresolved

This record says **database** for what an application opens two of, and the code says `AccountStore` and `LocalStore`. That is one word too many again, of exactly the kind ADR-0270's "workspace" was. It is left open deliberately rather than swept in passing: `store` is defensible as the runtime handle and `database` as the tables and rows it reaches, but nothing yet forces that distinction to be real, and a rename that is not forced is a rename that will be re-argued.
