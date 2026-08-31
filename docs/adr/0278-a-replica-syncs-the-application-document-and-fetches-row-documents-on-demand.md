# 0278. A replica syncs the application document and fetches row documents on demand

- **Status:** Superseded
- **Date:** 2026-08-28
- **Superseded by:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) entirely; a new generation receives one complete bootstrap envelope rather than the application document first and row documents on demand.
- **Relates:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) (one Durable Object per document, and HTTP for bulk, which is what makes this a choice at all), [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) (the row document and its lazy open), [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) (the local workspace, which this does not touch).
- **Unbuilt.**

## Context

ADR-0277 separates the two transports: a socket carries live editing, HTTP carries getting a copy. That leaves a question it does not answer. On a fresh device, or on a new generation, what does a replica fetch, and when?

Doing everything up front is what "a complete copy on the device" sounds like it means, and it is a minute of waiting before the first note renders. Doing nothing up front cannot work: the application document holds every row's scalar fields, so without it there is no list to show and no way to know what else exists.

## Decision

**The application document is synced first and completely. Row documents are fetched on demand.**

- **The application document opens at boot and holds a socket for the life of the page.** It is the only thing a replica needs before it is useful: the row list, every scalar field, and the change feed.
- **A row document is fetched when it is opened**, and re-fetched when the application document says it moved. That signal already exists and needs nothing built: `deriveOnCommit` writes `updatedAt` onto a row on every edit to its document, unconditionally, so the one socket a replica always holds already names which row documents changed.
- **Completing the copy is an explicit action, not a default.** A "download everything" verb walks the row list and fetches what is missing. It is ordinary paced `GET`s, and it can be interrupted and resumed because each document is independent.
- **The local workspace is unaffected.** It has no authority, so nothing about it is remote and nothing about it is lazy (ADR-0270).

## Consequences

- A fresh device is usable as soon as the application document lands, which is hundreds of kilobytes rather than megabytes.
- **"A complete copy on the device" becomes available-on-request rather than automatic**, and that is a real weakening worth stating plainly. Opening a note never opened on this device, while offline, fails. The remedy is the explicit action, taken before going offline.
- It is safe to be lazy here precisely because the authority holds everything and can always be asked again. The workspace with no authority is the one this rule does not apply to, so the case with nothing to refill from is also the case that never defers.
- A full backfill of a thousand notes is a thousand `GET`s, one per Durable Object, at a few kilobytes each: single-digit megabytes, and a thousand object wake-ups paced by the browser's own connection limit. That is seconds, and it is the cost of the granularity ADR-0277 chose. A bundled first sync was considered and refused below.
- Nothing here is a cache. A fetched row document is durable local state that stays until its generation is discarded; the laziness is about when it arrives, never about whether it is kept.

## Considered alternatives

- **Fetch everything at boot.** Refused: it is the whole corpus before the first paint, for a guarantee only useful to someone about to go offline, and it is exactly the action this record keeps as an explicit verb.
- **Stream row documents behind the application document automatically.** Refused, though it is close and might return. It makes a device eventually complete with no action, at the cost of a background process with its own progress, failure and retry story, and a first session that competes with itself for bandwidth. The explicit verb is the same machinery without the ambiguity about whether it is running.
- **One bundled first sync, assembled by the server.** Refused. It is one round trip instead of a thousand, and it puts resumption, ordering and partial failure in one place that has to get all three right; a thousand independent fetches degrade gracefully on a bad connection and need no server-side assembly, no Yjs call, and no new endpoint shape.
- **Treat unfetched row documents as a cache that may be evicted.** Refused, and it is the distinction that keeps this record small: absent-until-asked-for is not the same as droppable, and only the first is being adopted.
