# 0286. Every generation is minted from an artifact, and compaction is an export then an import

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amends:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) at compaction, which stops being its own path.
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) by withdrawing the Restore/Rebuild split and the lease Rebuild required. There is one verb, it is always additive, and there is nothing to compare and swap.
- **Amended by:** [ADR-0290](0290-a-mint-is-a-foreground-job-the-client-owns-and-it-cannot-outlive-a-page.md) at who runs the mint and what a `409` means. Invariant 5's `409` keeps only its abandon meaning, because a mint is never resumed; invariant 7's pacing gains an owner and loses any deadline. That record also corrects Decision bullet 1 below, which names ADR-0267's layout where invariant 2 names the shipped one: `<table>/<rowId>.md` plus `kv.json` is correct.
- **Unbuilt:** all of it.

## Context

ADR-0281 decided compaction is client-side and in memory: walk the live rows, serialize each document out through its codec, deserialize into fresh documents, mint. Four paragraphs later the same record made rollback artifact-based, "exporting that generation and minting a new one from it." Two byte sources feeding one mint, which is the shape ADR-0276 already had as Restore and Rebuild and which this record retires.

The decisive detail is that the in-memory path was never codec-free. It runs the same `serialize` and `deserialize`, so it pays the codec's declared losses (ADR-0268) identically. The difference between the two paths was never fidelity. It was the container.

## Decision

**A generation is minted from an artifact. There is one mint verb and one traversal.**

- **An artifact is a parsed folder structure, not necessarily a file.** `kv.json`, `tables/<table>.json`, `documents/<table>/<row>.<ext>` (ADR-0267). A zip a person picked is one place an artifact comes from; `export()`'s in-memory output is another. Nothing is written to a Downloads folder unless a person asked for a file.
- **Compaction is `export()` then `mint()`.** Not a second path that resembles the first.
- **Row ids are preserved by construction**, because the artifact addresses rows by id (`<table>/<rowId>.md`) and frontmatter round-trips scalars exactly. ADR-0279's reference preservation needs no separate rule.
- **The lease is withdrawn.** ADR-0276 required Rebuild to hold a lease on `(generation, head)` so it "must still be current when it lands". ADR-0281 deleted `current` and promotion, so a mint is always additive and there is nothing for a lease to protect.

**The invariants a mint holds.** Named here because the shape invites a wrong
assumption: that `POST /generations` carries the artifact.

1. **`POST` allocates a number and carries no data.** The artifact never
   reaches the authority, which has no codec and decodes no field (ADR-0283).
   A client parses the folder and uploads documents.
2. **The artifact is `kv.json` plus `<table>/<rowId>.md`** (ADR-0268): raw
   scalar fields as YAML frontmatter, and the codec's serialization as the
   body. A table with no document block exports frontmatter-only files. Under
   ADR-0284 both halves of a row's scalars, index and record, share the one
   frontmatter block, because the key sets are disjoint by parse rule.
3. **Row ids are preserved**, because the artifact addresses rows by id and
   frontmatter round-trips scalars exactly. ADR-0279's reference preservation
   needs no separate rule.
4. **Row documents are uploaded before the application document**, which is the
   seal: a generation without one has no entry point and is unreachable rather
   than hidden. The ordering is a client convention and deliberately
   unenforced; a bad mint is a visible row a person deletes.
5. **`PUT` is birth and happens once.** A second `PUT` to a document that
   exists is `409`, and a `409` during a mint means abandon it.
6. **A mint iterates the chains that exist, not the rows that do.** A row whose
   document has no content is never uploaded, so its object is never
   instantiated and costs nothing: a Durable Object that is never written to
   ceases to exist. `record.documents()` is the enumeration this needs, and
   iterating rows instead would mint an empty object per row (ADR-0287).
7. **The mint paces itself.** Creating tens of thousands of new object stubs in
   a burst is rate-limited, so the upload backs off and retries rather than
   discovering the limit in production (ADR-0287).

## Consequences

- One traversal, one id-preservation rule, one loss boundary, one test surface. The second of each goes.
- **The restore path is exercised on every compaction**, which is the point. A recovery path that only runs when a person is already in trouble is the classic broken path.
- Compaction inherits the codec's declared losses, which was already true and is now true for one reason instead of two.
- Memory is not the reason to prefer either: a corpus serialized to strings and back is small beside hydrating the same corpus as Yjs documents, which both paths do.

## Considered alternatives

- **Keep both paths.** The second is perhaps twenty lines of savings and a permanent second answer to "how does a generation come to exist". One canonical path is worth more than the twenty lines.
