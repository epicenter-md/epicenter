# 0287. The authority does not delete a generation, and erasure is an account operation

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amends:** [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at most of its decision. The ledger survives as an allocator, a browse list, and a register of addresses. Withdrawn: the tombstone, severing sockets, the per-generation sweep, the on-wake check as an admission gate, `410`, and `DELETE` on a generation.
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at its route table, which loses `DELETE`, and at "nothing is ever deleted except by a person", which becomes true of the authority without exception and remains true of a device.
- **Unbuilt:** all of it.

## Context

ADR-0283's hardest machinery exists for one reason: a Durable Object has no existence check, so a device still holding a deleted generation would push its copy back and resurrect it. Defending against that needed a tombstone, an explicit severing of live sockets, a resumable sweep, a register of every address ever admitted, an on-wake check in every document object, and a `410` a browser cannot read from a failed upgrade and so has to go and ask for.

All of it defends a person's ability to delete one generation from the server. Measured against what that saves, it is the wrong trade, and the measurement is not close.

## Decision

**The authority never deletes a generation. A person deletes their local copy.**

- **Deleting a local copy is `indexedDB.deleteDatabase`**, which is complete, has no lazy re-creation, and therefore has no resurrection hazard. That is where storage pressure is actually felt: a phone is full, a server is not.
- **The ledger stops gating.** A document object still tells the ledger it exists, once, on first wake. That is registration rather than admission: nothing is refused, no memo is permission, and there is no tombstone to invalidate it.
- **`404` survives and `410` goes.** A never-allocated generation is not found. Nothing is gone.
- **Erasure is an account operation, and it is the one sweep that remains.** A hosted product cannot promise that a server keeps everything forever, and no record covered this before. Deleting an account enumerates the registered addresses and `deleteAll`s them. It is drastically simpler than a per-generation sweep, because **the credential is revoked first**: principal resolution then fails at the Worker, no device can dial anything, and resurrection is structurally impossible rather than defended against. A dumb, re-runnable batch job with no client-facing protocol.
- **The register of addresses is why erasure can be complete.** A Durable Object namespace has no enumeration API, and the application document's row list omits every row deleted during a generation's life. That was ADR-0283's reason for recording addresses and it is unchanged; only its consumer moved.

## Consequences

- Gone with the deletion verb: the tombstone, the sever, the per-generation sweep and its alarm, the on-wake gate, `410`, and the client path that classifies a failed upgrade to tell a deleted generation from a bad network. That last one should be checked before deletion rather than assumed: a client may still want to tell a refused credential from a transient failure, and only the `410` arm of it dies here.
- Two ledger columns lose their only reader and go with them. `lastConnectedAt` existed to approximate "has every device moved", which was a question about whether deleting was safe. Per-generation `size` existed to make a deletion's cost actionable, and the write-behind fan-in that maintained it, a subrequest per fold per document, is deleted with it. Where a size is still wanted, the application document's object already sees every edit through the change feed (ADR-0277), so one object can report rather than thirty thousand.
- `?state-vector` goes too, unbuilt and unmissed: its only named consumer was a dashboard that does not exist, and the copy verb computes the same thing locally. It can come back when something asks for it, without the reserved-table-name rule it needed as a path segment.
- **The cost, measured rather than asserted.** Durable Object SQLite storage is $0.20 per GB-month, there is no documented limit on object count per namespace or account, and an empty object has a storage floor around 12 KB. A person at the platform ceiling of 30,000 rows is about 30,001 objects per generation, so twelve generations in a year is roughly 360,000 objects: 0.6 GB of real data, and about 4.3 GB once the per-object floor is counted. That is near **$1 per user per month at the end of a first year**, growing by about that much each year. The floor, not the bytes and not the count, is the whole cost, and it is worth measuring against one real mint before it is treated as settled.
- **Deletion machinery only ever saves money when it is used.** A person who never presses delete costs the same either way, so what is being bought here is the generations somebody would have deleted, which for a personal store is close to none.
- What is refused: reclaiming server storage for one generation. The cheap partial, if clutter becomes the complaint, is a bit on the ledger row that hides a generation from the browse list without reclaiming anything. It needs no sever, no sweep, and no status code. A genuine spill is an operator action that runs the account sweep scoped to one generation, which is rare, manual, and re-runnable.

## Considered alternatives

- **Empty a generation without tombstoning it.** Reopens the resurrection hazard exactly, because an emptied object and a never-written one are the same object.
- **Keep per-generation deletion.** The measurement above says its whole complexity defends about a dollar a month per user of storage that most people will never ask to reclaim.
