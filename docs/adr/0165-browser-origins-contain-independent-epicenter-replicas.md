# 0165. Browser origins contain independent Epicenter replicas

- **Status:** Accepted
- **Date:** 2026-07-20
- **Amended by:** [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md) — "origin" below names the ownership boundary imprecisely. The replica is owned by the storage partition the user agent resolves for the document paired with its origin, so two documents on the same origin in different partitions own independent replicas. Everything else here (one page, one DedicatedWorker, one Web Lock, immediate refusal, no coordination protocol) is unchanged.
- **Relates:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md)

## Context

The product says a person has one Epicenter, but browser storage is isolated by
origin. Synchronous OPFS SQLite also admits only one owner for an origin's local
database. Pretending that every application can open one literal device file
would make a false portability promise.

## Decision

Each browser origin stores its own complete local Epicenter replica. One page
owns one DedicatedWorker, which owns that replica's SQLite connection. A Web
Lock admits that owner or refuses it immediately when another page under the
same origin already owns the database.

The adapter does not coordinate, route, share, elect, or transfer ownership
among tabs. The page lifetime owns the worker lifetime. Graceful disposal closes
SQLite and releases the Web Lock; worker termination also releases the lock.

An origin cannot enumerate, open, migrate, or delete another origin's replica.
Signed-in origins converge through the same principal authority. Origin, page,
and worker ownership are adapter lifecycle details; none enters a namespace
key, table key, value key, row ID, document address, or public Lens.

## Consequences

- "One replica per device" may mean several physical replicas in one browser
  profile. This is an honest adapter constraint, not a second product concept.
- Cross-origin local-only data cannot be discovered centrally. Signing in is
  the only general convergence path.
- A second same-origin page is refused while the first owns the database. It
  can open after the first page disposes or its worker terminates.
- There is no background ownership election, takeover, retirement delay,
  heartbeat, or peer-liveness protocol to qualify.

## Acceptance evidence

The ADR-0161 physical mobile floor completes on a clean physical iOS Safari
origin and a clean physical Android Chrome origin. The conditional normal
profile runs only where measured storage availability admits it. A quota denial
does not prove capacity. It supplies honest refusal evidence only when the
previously committed prefix and durable progress survive restart unchanged.
Private or incognito storage is a negative refusal environment, never a durable
qualification environment. The maintained benchmark contract owns exact
footprint measurement and outcome classification.

Qualification must also cover immediate competing-owner refusal, graceful
disposal, Worker termination, lock release, backgrounding, restart, and a later
page opening after release. It must not claim that two same-origin pages can own
the database concurrently. Playwright WebKit does not replace physical Safari
evidence.

## Considered alternatives

- **One elected owner tab.** Rejected because suspension and crash handoff turn
  tab lifetime into a storage protocol.
- **SharedWorker ownership.** Rejected because synchronous OPFS access is not
  available there and compensating coordination recreates the ownership,
  routing, takeover, and peer-liveness protocol this design refuses.
- **BroadcastChannel as the state source.** Rejected because delivery is not
  durable or guaranteed.
- **Expose origin as a data owner.** Rejected because it leaks an adapter
  constraint into every application address.
