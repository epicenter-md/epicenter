# 0290. A mint is a foreground job the client owns, and it cannot outlive a page

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amends:** [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) at three points. Its invariant 5 said a `409` means abandon; a resumable mint would also need `409` to mean "skip, already sent", and this refuses resumption so the status keeps one meaning. Its invariant 7's pacing gains an owner and loses a deadline. And its Decision bullet 1 still names ADR-0267's layout (`tables/<table>.json` + `documents/<table>/<row>.<ext>`) where its own invariant 2 names the shipped one; **`<table>/<rowId>.md` plus `kv.json` is correct**, per ADR-0268 and `packages/data/src/artifact/layout.ts`.
- **Relates:** [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) (the routes a mint calls), [ADR-0284](0284-the-application-document-is-an-index-and-a-rows-remaining-fields-live-in-its-own-document.md) (the row ceiling this lands beside), [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md).
- **Unbuilt:** all of it. `renderArtifact`, `readArtifact`, and `record.documents()` exist; the completeness precondition, the two routes, and the upload loop do not.

## Context

ADR-0286 says a generation is minted from an artifact and that the mint paces itself, because creating tens of thousands of Durable Object stubs in a burst is rate-limited. It does not say who runs the loop, what happens when that party goes away, or what a device must hold before it is allowed to start.

Those gaps are load-bearing. Pacing is what makes a mint take minutes, and a mint that takes minutes has to survive something. Either the client stays present for the duration, or the bytes are handed to a server that finishes without it, and the second option is a different system: it needs a container format for many documents in one body, which is `envelope.ts` returning; it gives the ledger a second job as a bytes store; and it introduces the first thing in this design that outlives a page.

The gap about what a device holds is worse, because it is silent. Row documents are lazy, and a replica that never fetched one is indistinguishable from one whose document is genuinely empty. So a phone that never opened 4,000 notes renders 4,000 files with correct frontmatter and empty bodies, and mints a generation that is complete, well-formed, joinable, and blank.

## Decision

**A mint is a foreground job owned by the client, bounded by one page lifetime, never resumed, and never refused for taking too long.**

- **The client runs the whole loop.** It parses the artifact, runs the codec, allocates the number, uploads every row document, and puts the application document last. The authority receives encoded bytes at addresses it does not interpret. There is no server-side drain, no job, no queue, and no bundle: `POST /generations` still carries no data (ADR-0286 invariant 1), and each document is still its own `PUT` (ADR-0283).
- **A mint refuses to start unless the device holds every body.** Before the first request, the client compares the rows that should have documents against `record.documents()` and stops on any difference. The client is the only party that can make this check, because the row list lives inside the application document, which the authority has no codec to read and which arrives last in any case. A device that is missing bodies must sync first.
- **A mint is never resumed.** If the page goes away, the mint is over. The partially filled number keeps whatever landed, has no application document, and is therefore unreachable by construction. A person mints again at a fresh number, and ADR-0287's refusal to delete means the abandoned one is inert rather than in the way.
- **There is no duration ceiling and no estimate a mint enforces.** Restore is the one path that exists to get a person's data back, and an escape hatch that refuses to run is worse than a slow one. The mint paces itself against the platform, reports progress, and takes as long as it takes.
- **A mint may hold an exclusive lock.** Being foreground and client-owned means it rides the Web Lock mechanism `claims.ts` already uses, so two tabs cannot mint at once without a server-side lease.

## Consequences

- **`409` has one meaning again**, which is the concrete payoff: abandon. No skip-and-continue arm, no record of which documents were already sent, no cross-session idempotency.
- **A generation still has two states, both derived**: allocated, and complete because its application document exists. No `minting` flag, no progress resource, no alarm. Progress is a bar in a window.
- **The ledger holds no bytes**, as ADR-0283 designed it. Allocator, browse list, address register.
- **The artifact may be held in memory for the duration**, so nothing needs streaming or chunked upload. The ceiling is a browser tab, which is the ceiling ADR-0284 already declares.
- **Minting is effectively a desktop verb.** iOS suspends backgrounded tabs, so "keep this window open" is a stronger demand on a phone. Stated here rather than discovered.
- **Abandoned mints cost storage forever**, at ADR-0287's ~12 KB per-object floor for whatever rows landed. Noise at a few; worth watching if someone retries a failing mint repeatedly.
- **The duration is unmeasured and deliberately so.** The client half is cheap: encoding 30,000 row documents measured 0.4 s and 39.8 MB, about 1.3 KB per document. The unknown is Cloudflare's rate limit on creating objects that have never existed, which cannot be measured without a real namespace. If it is ever low enough that a mint takes hours, this record is what a successor supersedes, and the server-drained mint is the fallback whose costs are named above.

## Considered alternatives

- **`POST` the zip and let a Worker fan out.** A stateless Worker genuinely can fan out; the documented paid subrequest budget is 10,000, configurable far higher, so the topology objection this record originally leaned on does not hold. It loses on the codec: `file.deserialize` is a function in an application's bundle closing over its editor schema, so a server that reads Markdown runs application code, which is the coupling ADR-0277 spent the redesign refusing. Once the client must run the codec anyway, the only question left is transport.
- **Upload a bundle so a server can finish without the client.** This is the honest case for a batch, and it is a handoff of responsibility rather than an optimisation. Refused because it would be the first thing here that outlives a page, and because it costs a container format, a second home for a document's bytes, and a drain lifecycle.
- **Batch to reduce round trips.** Undercut by pacing: if the destination's object-creation rate is the bottleneck, a fan-out creates the same objects and relocates the throttle without relieving it.
- **Enforce a duration ceiling from a pre-flight estimate.** All the inputs exist. Refused because it turns a patience estimate into a wall on the recovery path.
