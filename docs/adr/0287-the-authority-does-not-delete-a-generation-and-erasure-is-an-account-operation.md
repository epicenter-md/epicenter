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
- **The cost, verified against Cloudflare's documentation rather than asserted.** SQLite-backed storage is $0.20 per GB-month with 5 GB-month included, object count is explicitly unlimited per account and per class, and an empty SQLite database "consumes approximately 12 KB of storage". That 12 KB is **bytes the database occupies, which are then billed as stored data**, not a declared minimum charge: no per-object minimum billing exists in the documentation, and reading it as one is an inference.

  A person at the platform ceiling of 30,000 rows is about 30,001 objects per generation, so twelve generations in a year is roughly 360,000 objects: 0.6 GB of real data and about 4.9 GB once the per-object overhead is counted. **The included tier is per account, not per person**, so "one user costs nothing" is an artifact of the allotment rather than of the design. At a thousand such people the bill is about $983 a month against $119 for the data alone: **the overhead costs 8.2 times what the content costs**, and it grows by roughly $0.98 per person per month for every year of accumulated history, linearly, forever.
- **Two costs the 12 KB constant hides, and both matter more than it does.** Write metadata accretes with edit *history* rather than with current state, is documented as remaining "until you call `deleteAll()`", and is therefore unbounded under a decision never to call it. And rows written on a mint are not free at scale: at ten thousand people, minting thirty thousand objects twelve times a year is somewhere between $850 and $6,150 a month depending on rows per object, which is a number the documentation does not give. That second cost is proportional to the **mint rate** and is untouched by this record: it argues against minting thirty thousand objects twelve times a year, not against keeping what was minted.
- **An object that never writes costs nothing at all**, and this is a lever worth taking deliberately. The documentation is explicit that a Durable Object "fully ceases to exist if, when it shuts down, its storage is empty", so a row whose document has no content should never be `PUT` during a mint. Iterating a mint over `record.documents()`, the chains that exist, rather than over rows, gets that for free and can move the object count by an order of magnitude for applications where most rows carry no prose.
- **Minting is rate-limited and the limit is not quantified.** Creating thirty thousand *new* stubs in a burst is exactly the uncached lookup Cloudflare throttles with "your account is generating too much load on Durable Objects", advising backoff and spreading lookups across requests. The mint path needs pacing and retry as a design constraint rather than as an operational discovery.
- **Hibernation is conditional, and one condition is easy to break.** Idle objects eligible for hibernation are not billed for duration, but an object holding an outbound WebSocket is billed for up to fifteen minutes per connection with no incoming requests. A hub that dials outward rather than being dialled would cost more than everything above put together.
- **Deletion machinery only ever saves money when it is used.** A person who never presses delete costs the same either way, so what is being bought here is the generations somebody would have deleted, which for a personal store is close to none.
- What is refused: reclaiming server storage for one generation. The cheap partial, if clutter becomes the complaint, is a bit on the ledger row that hides a generation from the browse list without reclaiming anything. It needs no sever, no sweep, and no status code. A genuine spill is an operator action that runs the account sweep scoped to one generation, which is rare, manual, and re-runnable.

## Considered alternatives

- **Empty a generation without tombstoning it.** Reopens the resurrection hazard exactly, because an emptied object and a never-written one are the same object.
- **Keep per-generation deletion.** The measurement above says its whole complexity defends about a dollar a month per user of storage that most people will never ask to reclaim.
