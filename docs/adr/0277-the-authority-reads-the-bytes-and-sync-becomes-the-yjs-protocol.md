# 0277. The authority reads the bytes, and sync becomes the Yjs protocol

- **Status:** Superseded
- **Date:** 2026-08-28
- **Supersedes:** [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md) entirely, and [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md) at the opaque-append model, the client-owned merge, and the absence of state vectors from the transport. ADR-0217's chunking survives.
- **Supersedes:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md). A snapshot and a tail are what a byte-blind server keeps instead of a document; a reading one keeps the document.
- **Amends:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at the cursor: admission is still equality on the document identity, but a replica no longer holds a log position, because there is no log to be positioned in.
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at the outbox. Acceptance and durability still split; what a replica owes is no longer a durable queue.
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at what a generation holds: a set of documents rather than a log and a snapshot. The numbering, the two verbs, the retention rule, and the routes are unchanged.
- **Returns to:** [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md), which decided this on 2026-06-15 and has never been superseded.
- **Superseded by:** [ADR-0298](0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md) entirely. ADR-0295 deleted the split that made a document-granular server worth its price; the byte-blind positional log this record retired is what actually deploys, and the implementation written for this one was never routed to.
- **Unbuilt:** all of it, and now permanently. Nothing here shipped.
- **Amended by:** [ADR-0282](0282-the-authority-hydrates-the-document-and-one-object-per-document-bounds-the-blast-radius.md) at three stated reasons, not at its decision. Withdrawn: refusal at the door, "128 MB per isolate, shared" as the mechanism, and request count as the argument against per-generation. The granularity stands on blast radius, measured.
- **Amended by:** [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at the address surface, which moves under `/api` and gains explicit non-existence.
- **Amended by:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses-from-one-snapshot.md) at bulk bootstrap, which uses one complete envelope before the incremental socket.
- **Amended by:** [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) at the envelope's surviving role in bulk generation transfer.
- **Amended by:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) at the object granularity and the per-row HTTP surface: one object holds one database, not one document per row. This record's own refused alternative, one object per generation, is the chosen shape there.

## Context

ADR-0004 decided that the relay is trusted and reads plaintext, and named the reason: server-blindness is a nice-to-have, and "the features that matter (collaboration, server-side materialization, search, recovery) all want the server to read plaintext."

Seven weeks later ADR-0217 and ADR-0218 built a byte-blind authority. Neither cites ADR-0004. `sync/authority.ts` lists among its reasons that reading "foreclosed end-to-end encryption, which is possible exactly as long as the authority never reads the bytes" — an option ADR-0004 had already declined to buy. The drift was reasonable in isolation: ADR-0218's measurements are real and its conclusion, that a validation *filter* is not worth 283 MB, is correct on its own terms. What was never weighed is what blindness costs everywhere else, because those costs are not in the authority.

They are large. A Yjs peer answers one question — "here is my state vector, what am I missing?" — and a byte-blind authority cannot. Every mechanism that replaced it is downstream of that single refusal: an integer log position, a cursor to hold it, an outbox because a position is not a receipt, contiguity and gap detection because positions must not skip, a resync path because a gap wedges a replica silently, a snapshot request-and-offer dance because the authority cannot compact what it cannot read, and an envelope format to batch documents into one positional entry.

## Decision

**The authority holds Yjs documents and speaks the Yjs sync protocol.**

`y-protocols/sync.js` is 131 lines and has three messages: a state vector, the updates missing against a state vector, and an update. That is the whole transport.

**One Durable Object per Yjs document, and bulk transfer is not the socket's job.** The two are the same decision: a socket carries live editing, and HTTP carries getting a copy.

```txt
  principals/<p>/data/<id>                    the pointer and the generation list
  principals/<p>/data/<id>/generations/3      the application document
  principals/<p>/data/<id>/generations/3/notes/<rowId>   one row document each
```

- **WebSocket, for what is being edited.** A single-page application holds the application document open for its whole life, and opens one row document when a person opens a note. That is one or two sockets, not a thousand, because a person reads one note at a time and `openDocument` is already lazy (ADR-0248).
- **HTTP, for getting a complete copy.** A device backfills documents it does not have with ordinary `GET`s, which are parallel, resumable, cacheable, and need no protocol. A `GET` with no state vector is the stored bytes verbatim, with no Yjs call on the server at all.
- **The change feed already exists.** Every edit to a row document writes into the application document: `store.ts`'s `deriveOnCommit` stamps `updatedAt` on the row and notes that "a body edit is an edit to the row&hellip; the write always happens on a local body edit". So the one socket a device always holds already tells it which row documents moved, and it re-fetches those over HTTP. Nothing new is needed to keep an unopened note current.
- **A generation is still atomic, through the pointer rather than through the object count.** `create` writes N objects and nothing reads a generation before `setCurrent` names it, so a half-written generation is invisible rather than broken. The two verbs stay two verbs.

**Validation becomes possible, so a poison entry is refused rather than repaired.** ADR-0218 is right that a filter over bytes "could not be a proof, only a filter", and right for a server holding no structs. A server holding the document proves it: an update that will not apply is refused at the door. The 13-byte no-op repair, `SyncClientError.Unapplyable`, and the reasoning around them go.

**What the client stops holding:** the cursor, the outbox, `authoritySeq`, gap detection, `needsResync`, and the durable record of what it owes. It sends its state vector and is told. Its durable record becomes the document bytes and nothing else.

**What stays:** the document identity and admission by equality (ADR-0231), which is what generations ride on; the host supplying the socket (ADR-0222) and the blob store; chunking, because a document exceeds the 2 MB value cap. ADR-0225's one object per principal and data definition becomes one object per principal, definition, generation and document address; the partition rule it exists for, that the resolved bearer and not a query selects the partition, is unchanged.

## Consequences

- Roughly 3,300 lines of source and 2,800 of tests come out: `sync/frames.ts`, `sync/hub.ts`, `sync/authority.ts`, `sync/client.ts`, `sync/connection.ts`, `store/envelope.ts`, `store/log.ts`, `store/persistence.ts` and their suites, against a protocol of about 300. `envelope.ts` goes rather than survives: it batched several documents into one positional log entry, and one document per object with one socket per open document has nothing to batch.
- **The client's durable record loses its metadata entirely.** With no cursor there is nothing that must land atomically with the bytes, so the document identity moves into the storage path rather than a table, and `_identity`, `_tombstones` and `_updates` all go. A generation becomes a directory.
- `owed.ts` is deleted before it was ever wired. It computed what a replica owes from a vector it kept itself, which is the right answer against a server that cannot diff. Against one that can, a replica does not keep a vector.
- **The authority acquires a Yjs version.** ADR-0218 names this correctly: with no Yjs call, "a Yjs format change cannot make the server refuse a valid client's writes." That protection is spent. Server and client now upgrade together, and Yjs's v2 update format is the compatibility surface to watch.
- **The memory ceiling stops being a design constraint.** It is 128 MB per isolate, shared, and a hydrated document is roughly four times its bytes (`applyUpdateV2` cost 108 MB on a 27.7 MB update). One object per document means the largest thing any object ever hydrates is one document: the application document at a few hundred kilobytes, or one note. This is the whole reason the granularity went this way rather than the other, and it is why the collapse costs nothing that lands on a neighbour.
- Server-side compaction becomes trivial and stops being a product decision. The authority holds the state it would replace, so it owes nobody a proof that the replacement covers it. That is the joint four withdrawn authority designs failed at.
- End-to-end encryption is foreclosed, as ADR-0004 already accepted. Privacy remains a property of topology: a self-hosted instance is the answer for a person who needs the operator not to read.

## Considered alternatives

- **One Durable Object per generation, holding every document in it.** Refused, and it was this record's first answer. The argument for it was that a replica wanting a complete local copy would otherwise need a socket per document, and that a generation spanning many objects loses atomicity. Both dissolve once bulk transfer is HTTP rather than the socket: a device sockets only what it is editing, and a generation nothing reads until the pointer names it cannot be observed half-written. What is left on that side is one object per person per definition for billing, against a shared memory ceiling that becomes a real blast radius the moment one person's data is large. The ceiling is worth more than the request count.
- **Keep the byte-blind authority and delete only the client's outbox.** This was the plan until this record, and `owed.ts` is its residue. It works, and it keeps every mechanism that exists because the server cannot answer a question the client could simply ask.
- **Encrypt client-side and keep both.** Refused by ADR-0004 with its reasoning intact: it taxes collaboration, server-side materialization, search and recovery to buy a property few people asked for.
