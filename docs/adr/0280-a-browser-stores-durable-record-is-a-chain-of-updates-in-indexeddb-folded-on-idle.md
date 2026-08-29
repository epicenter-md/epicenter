# 0280. A browser store's durable record is a chain of updates in IndexedDB, folded on idle

- **Status:** Accepted
- **Date:** 2026-08-28
- **Supersedes:** [ADR-0275](0275-a-browser-stores-durable-record-is-sqlite-over-opfs-in-a-worker.md). SQLite over OPFS in a worker was sized for an update log that a whole-document write was about to delete, and then the whole-document write was itself deleted. Its OPFS half was already reverted in `7cf2e01b`; this record retires the rest, and `claims.ts` survives rather than being replaced by a filesystem fact.
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at the debt. Acceptance and durability still split, but the window between them is now one IndexedDB transaction rather than a queue, so the three-state debt machine is replaced by a single health bit.
- **Unbuilt:** all of it.

## Context

ADR-0238 made local persistence a visible debt carried in an ordered queue, because a durable entry had to land atomically with the cursor and the outbox that ADR-0217's positional log required. ADR-0277 deleted the cursor and the outbox: a replica asks the authority what it is missing rather than remembering what it owes. What was left was a durable record with no metadata, which invited the conclusion that a document is one value written whole on a debounce.

That conclusion was wrong in one specific way, and the way is measurable. A whole-document write is O(document) per edit, so it has to be debounced; the debounce in `document-handle.ts` cancels on every edit, so a person typing continuously has an unbounded window in which nothing is on disk. The outbox was never what made an edit durable. The chain under it was, and the chain was deleted alongside the bookkeeping that rode on it.

## Decision

**A document's durable record is its updates, appended eagerly, folded when the person stops typing.**

One IndexedDB database per store, opened through `idb`, holding one object store `updates` keyed by `['doc', 'seq']`. A record is `{ doc, seq, bytes }` where `bytes` is one `updateV2`. There is no separate state table: a fold writes `encodeStateAsUpdateV2` as a new record and deletes the ones it covers, in one transaction, so the folded state is simply the first record of a chain and no reader can tell it from an update. This is `y-indexeddb`'s shape, which appends every emitted update as its own record and squashes on a threshold; the divergence is deliberate and is the format, because this tree is `updateV2` throughout and `y-indexeddb` is v1.

- **The append is eager.** Every `updateV2` is one `put`. No timer, no cancel, no coalescing. The remote-application case is not an exception: bytes that arrived are bytes this device holds, and a reload that re-fetched them would ask for something it was already given.
- **The idle timer moves from the write to the fold.** The 1000 ms debounce `document-handle.ts` already owns keeps its cancel-on-every-edit shape, which is a bug when it gates durability and correct when it gates compaction. Folding late costs a longer replay; writing late costs a person's work.
- **The fold rule is the authority's rule**, shared rather than reimplemented: fold when the tail's bytes exceed the state's, above a 64 KB floor. Count-based thresholds fold a 10 KB tail of 500 tiny updates and skip a 5 MB tail of 50 fat ones, and load cost tracks bytes.
- **Compute the folded bytes before opening the transaction.** An IndexedDB transaction goes inactive the moment it awaits anything that is not an IDB request. `encodeStateAsUpdateV2` is synchronous, so this is free; it is written down because the failure it prevents is intermittent and only appears under load.
- **Delete by the exact keys read, never by clearing the store**, so a fold cannot drop an append that landed while it was deciding.
- **The IndexedDB version is pinned at 1 and there is no migration path.** The `upgrade` callback exists to create the store and throws if `oldVersion !== 0`; pinned, that throw is unreachable, which is the point. It reaches what `STORE_GENERATION` was written for, "a bad migration impossible to write rather than merely discouraged," without a path segment and without stranding data. `STORE_GENERATION` is deleted: IndexedDB already carries a version, this codebase has bumped that one three times, and never bumped the string once.
- **A store keeps one durability bit,** not three states. With eager appends there is no debt window to report, but a rejecting IndexedDB (quota, eviction, corruption) would otherwise fail every append with nothing watching. `durability.healthy` flips on a rejected transaction so an application can say that edits are not reaching disk.

Row documents and the application document use one record and one rule. Blobs, meaning attachment bytes, stay on OPFS and are out of scope here.

## Consequences

- `store/log.ts`, `store/persistence.ts`, `store/envelope.ts`, `store/blobs.ts`, `store/blobs.opfs.ts`, `store/test-opfs.ts`, `store/flush-on-hide.ts` and `store/port-conformance.test.ts` are deleted, along with `DurablePort`, `CreateStoreOptions.sqlite`, and `memory.ts`'s `bun:sqlite` dependency. `packages/data` stops linking SQLite on the client.
- `flush-on-hide.ts` goes with the debounce it was written for. Its docstring names its own premise: the window it closes is the one a whole-document write on a timer creates. Eager appends leave nothing pending at `pagehide` but an in-flight transaction, which no hide hook can accelerate. Losing that last transaction at teardown is the residual risk, and it is stated here rather than defended in code.
- `Blobs` does not survive as written. Its opening contract, "a document is one value... everything that used to sit above it, the update chain, the ids that ordered it, the fold that collapsed it, was machinery for storing a document in pieces," is the paragraph this record negates line by line.
- Per-document object stores are impossible rather than merely unattractive: object stores are created only in a version-change transaction, and the version is pinned. The single store is forced by the pin, and this is written down so it is not relitigated.
- A future on-disk shape change is an export and a re-import through the artifact, not a migration and not a wipe. The local database has no authority to refill from, so a wipe there is unrecoverable, which is what made the stranding model unsafe for exactly one of the two realms.

## Considered alternatives

- **A whole-document write on a debounce.** Simpler storage, an unbounded loss window during sustained typing, and no ecosystem precedent: no Yjs persistence provider debounces the durable write.
- **SQLite over OPFS in a worker (ADR-0275).** OPFS cannot express a multi-key commit, so a fold has to be made crash-safe by ordering rather than by a transaction; IndexedDB has the transaction, and `idb` is already a dependency used exactly this way.
- **Adopting `y-indexeddb` itself.** It stores v1 updates, manages its own document lifetime, and exposes no way to participate in its transactions. `browser.ts` rejected it for the last reason, which expired with the outbox; the first two did not.
