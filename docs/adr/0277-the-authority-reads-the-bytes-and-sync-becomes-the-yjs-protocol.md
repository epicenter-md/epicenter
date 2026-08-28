# 0277. The authority reads the bytes, and sync becomes the Yjs protocol

- **Status:** Accepted
- **Date:** 2026-08-28
- **Supersedes:** [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md) entirely, and [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md) at the opaque-append model, the client-owned merge, and the absence of state vectors from the transport. ADR-0217's chunking survives.
- **Supersedes:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md). A snapshot and a tail are what a byte-blind server keeps instead of a document; a reading one keeps the document.
- **Amends:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at the cursor: admission is still equality on the document identity, but a replica no longer holds a log position, because there is no log to be positioned in.
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at the outbox. Acceptance and durability still split; what a replica owes is no longer a durable queue.
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at what a generation holds: a set of documents rather than a log and a snapshot. The numbering, the two verbs, the retention rule, and the routes are unchanged.
- **Returns to:** [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md), which decided this on 2026-06-15 and has never been superseded.
- **Unbuilt:** all of it.

## Context

ADR-0004 decided that the relay is trusted and reads plaintext, and named the reason: server-blindness is a nice-to-have, and "the features that matter (collaboration, server-side materialization, search, recovery) all want the server to read plaintext."

Seven weeks later ADR-0217 and ADR-0218 built a byte-blind authority. Neither cites ADR-0004. `sync/authority.ts` lists among its reasons that reading "foreclosed end-to-end encryption, which is possible exactly as long as the authority never reads the bytes" — an option ADR-0004 had already declined to buy. The drift was reasonable in isolation: ADR-0218's measurements are real and its conclusion, that a validation *filter* is not worth 283 MB, is correct on its own terms. What was never weighed is what blindness costs everywhere else, because those costs are not in the authority.

They are large. A Yjs peer answers one question — "here is my state vector, what am I missing?" — and a byte-blind authority cannot. Every mechanism that replaced it is downstream of that single refusal: an integer log position, a cursor to hold it, an outbox because a position is not a receipt, contiguity and gap detection because positions must not skip, a resync path because a gap wedges a replica silently, a snapshot request-and-offer dance because the authority cannot compact what it cannot read, and an envelope format to batch documents into one positional entry.

## Decision

**The authority holds Yjs documents and speaks the Yjs sync protocol.**

`y-protocols/sync.js` is 131 lines and has three messages: a state vector, the updates missing against a state vector, and an update. That is the whole transport.

**The authority is one Durable Object per generation, holding every document that generation contains.** Not one per Yjs document. A Durable Object terminates one WebSocket, so a replica that wants a complete local copy of a thousand row documents would need a thousand sockets; and a generation that spans a thousand objects makes ADR-0276's `create` and `setCurrent` stop being single operations. Messages carry the document address they belong to, which is what ADR-0217's envelope already does.

**A document is hydrated when it is being synced and not otherwise.** Hibernation discards in-memory state while keeping sockets open and stops duration billing, so a warm document is a session-lifetime convenience rather than a resident cost. In practice that is the application document plus whatever row documents someone is editing.

**Validation becomes possible, so a poison entry is refused rather than repaired.** ADR-0218 is right that a filter over bytes "could not be a proof, only a filter", and right for a server holding no structs. A server holding the document proves it: an update that will not apply is refused at the door. The 13-byte no-op repair, `SyncClientError.Unapplyable`, and the reasoning around them go.

**What the client stops holding:** the cursor, the outbox, `authoritySeq`, gap detection, `needsResync`, and the durable record of what it owes. It sends its state vector and is told. Its durable record becomes the document bytes and nothing else.

**What stays:** the document identity and admission by equality (ADR-0231), which is what generations ride on; one Durable Object per principal and data definition (ADR-0225); the host supplying the socket (ADR-0222) and the blob store; chunking, because a document exceeds the 2 MB value cap.

## Consequences

- Roughly 3,300 lines of source and 2,800 of tests come out: `sync/frames.ts`, `sync/hub.ts`, `sync/authority.ts`, `sync/client.ts`, `sync/connection.ts`, `store/envelope.ts`, `store/log.ts`, `store/persistence.ts` and their suites, against a protocol of about 300.
- **The client's durable record loses its metadata entirely.** With no cursor there is nothing that must land atomically with the bytes, so the document identity moves into the storage path rather than a table, and `_identity`, `_tombstones` and `_updates` all go. A generation becomes a directory.
- `owed.ts` is deleted before it was ever wired. It computed what a replica owes from a vector it kept itself, which is the right answer against a server that cannot diff. Against one that can, a replica does not keep a vector.
- **The authority acquires a Yjs version.** ADR-0218 names this correctly: with no Yjs call, "a Yjs format change cannot make the server refuse a valid client's writes." That protection is spent. Server and client now upgrade together, and Yjs's v2 update format is the compatibility surface to watch.
- **The authority acquires a memory ceiling.** 128 MB per isolate, shared across the objects in it; exceeding it returns `Error 1102` and moves subsequent requests to a new isolate. `applyUpdateV2` into a document cost 108 MB on a 27.7 MB update, so a hydrated document is roughly four times its bytes. The 9/91 split is what keeps this comfortable: the application document holds scalar fields only and grows with row count rather than row size.
- Server-side compaction becomes trivial and stops being a product decision. The authority holds the state it would replace, so it owes nobody a proof that the replacement covers it. That is the joint four withdrawn authority designs failed at.
- End-to-end encryption is foreclosed, as ADR-0004 already accepted. Privacy remains a property of topology: a self-hosted instance is the answer for a person who needs the operator not to read.

## Considered alternatives

- **One Durable Object per Yjs document.** Refused. It fits `y-protocols` verbatim and bounds memory per object, and it loses on three counts that matter more: a replica needs one socket per document, a generation stops being one object so create, promote and delete stop being atomic, and per-object request billing multiplies by row count.
- **A hybrid: the application document in its own object, row documents in theirs.** Refused for the same socket and generation reasons, which apply to the row documents either way.
- **Keep the byte-blind authority and delete only the client's outbox.** This was the plan until this record, and `owed.ts` is its residue. It works, and it keeps every mechanism that exists because the server cannot answer a question the client could simply ask.
- **Encrypt client-side and keep both.** Refused by ADR-0004 with its reasoning intact: it taxes collaboration, server-side materialization, search and recovery to buy a property few people asked for.
