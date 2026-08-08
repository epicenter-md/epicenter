# The transport in `workerd`, measured

Produced by `evidence/workerd/probe.ts` against the throwaway `apps/sync-lab`
deployment. Regenerate with:

```sh
bun --cwd apps/sync-lab run deploy
bun run packages/data/evidence/workerd/probe.ts https://<worker>.workers.dev
```

Every experiment carries a control that must fail if the test is not live, and
the control is reported beside the result. That is not ceremony: three
experiments earlier on this branch passed for hollow reasons and each was caught
because a number looked odd, not because an assertion failed.

Two runs are recorded, `wrangler dev` and real Cloudflare, because the whole
point of the second is that the first is not evidence about production.

## 1. The value cap is not where it is documented

Bisected to the byte, from 1,024 up to 8 MiB.

| | local `wrangler dev` | real Cloudflare |
| --- | --- | --- |
| largest value that stores | 2,199,994 | **2,199,994** |
| smallest value refused | 2,199,995 | **2,199,995** |
| the failure | `SQLITE_TOOBIG` | `SQLITE_TOOBIG` |
| control: 1 KB stores, 8 MB does not | held | held |

**The design record quotes 2,097,152 as the cap and it is not the enforced
wall.** It is Cloudflare's documented limit; the engine refuses at 2,199,995, so
the constant the transport chunks at sits 102,842 bytes *under* the wall rather
than on it.

That does not change the decision, and the distinction still matters. Chunking
at the documented number is right, because a documented limit is the one
Cloudflare is entitled to start enforcing and because the headroom also absorbs
the row's `seq` and `chunk` columns. But "2,097,152 is the cap" is the kind of
claim that gets quoted for years, and it was wrong by 102 KB in the direction
nobody would have checked. The two runs agreeing to the byte is what says this
is the engine's limit rather than an artifact of local emulation.

## 2. An update past the cap, through a real socket

One transaction inserting 5,000,000 characters, sent by one replica and read
back on another.

| | real Cloudflare |
| --- | --- |
| reassembled length on the **other** replica | 5,000,000 |
| entries in the log | 1 |
| bytes stored | 5,000,187 |
| chunks it must have taken | 3 |
| control: it really exceeded one value | held |
| control: no unresolved dependencies on the reader | held |

The second control is the one that matters. Yjs buffers an update whose
dependencies are missing **silently**, with no throw, no event and no public
reader, so a reassembly that dropped a chunk would leave the reader looking
empty and reporting success. The assertion is on the receiving replica's own
document, never on a counter kept by the harness.

## 3. Sustained traffic, and the snapshot replacing the log

Pushes one per row, coalescing effectively off so the authority is the thing
under load. The right-hand column is after the authority stopped keeping a log
and started keeping a snapshot plus a tail.

| | full log (withdrawn) | snapshot and tail |
| --- | --- | --- |
| messages | 2,000 | 1,500 |
| head position | 2,000 | 1,500 |
| snapshot taken at | never | **979** |
| entries still held | 2,000 | **521** |
| wall clock | 104,095 ms (52.1 ms each) | 106,908 ms (71.3 ms each) |
| bytes stored | 316,178 | 226,507 |
| rows on the other replica | 2,000 | 1,500 |
| control: one incarnation start to end | held | held |
| control: every position contiguous | held | held |
| control: the reader holds every row | held | held |
| control: the tail is shorter than the run | n/a | held (521 of 1,500) |

**The last control is the one that matters**, and it had to be added: the head
does not move when a snapshot is taken, so a run where nothing was ever
snapshotted and one where everything was look identical from `head` alone. The
first version of this experiment could not see the feature it was testing.

The round trip is 4.5x slower against real Cloudflare, which is a network
number rather than an authority number: the probe waits for each ack before
sending again, so this is 2,000 sequential round trips from a laptop to SJC.

**The incarnation control is what makes "sustained" mean anything.** The Durable
Object mints an id per constructor and the probe reports it at the start and the
end; a run that crossed an eviction measured two cold objects, and a single
message through a fresh isolate is the flattering case that produced this
branch's wrong memory numbers. Both runs held one incarnation throughout.

At 158 bytes an entry, the 10 GB Durable Object SQLite ceiling is roughly 68
million entries.

## 4. Every submission is answered rather than swallowed

**NOT RE-MEASURED.** The table below is the run that produced this document, when
the authority still decoded every update and six bytes of garbage came back
refused. The experiment now asserts the opposite for those bytes, that they are
ACCEPTED and acked at a position, and takes its refusal from a submission that
contradicts its own chunk count instead. Rerun `probe.ts` to replace this
section; nothing here has been rewritten to look like a run that did not happen.

| | real Cloudflare |
| --- | --- |
| the authority answered | a frame |
| the answer is a refusal | yes |
| nothing was stored | held |
| control: the socket is still open | held |

The last line is the whole reason the ack exists, and it did not change. `workerd`
swallows a throw in `webSocketMessage` **without closing the socket**, so an
answer that travelled as an exception would be indistinguishable from success to
the client, and the client would drop the work believing it was delivered. What
changed is only what the answer says: an ack for anything that arrives whole, a
refusal for framing the collector cannot honour or a storage failure.

## What did not survive contact with the runtime

**The authority could not load at all as designed.** Its validator diffed
against `Y.encodeStateVector(new Y.Doc())`, evaluated once at module scope.
Constructing a `Y.Doc` mints a clientID through `crypto.getRandomValues`, and
generating random values in global scope is a *disallowed operation* in a
Worker, so the module threw during startup rather than misbehaving later. It was
fixed by writing the constant out as `new Uint8Array([0])`, and then outlived by
the entry below.

**And then the validator went entirely.** The `diffUpdateV2` filter measured in
section 4 has been removed, and `src/sync/authority.ts` now makes no Yjs call at
all. It was never a proof: it let through 44 poison pills of about 5,900
single-byte corruptions of a full update and 4 of about 490 on an increment, and
integrating into a throwaway `Y.Doc`, the most an authority could do, still leaks
3, because whether bytes throw depends on structs the *receiver* holds. It was
also the most expensive step in an append at 283 MB rss and 45 ms on a 27.7 MB
update, more than hydrating an entire `Y.Doc` (108 MB, 35 ms), which is now
reproducible with `evidence/bench/validate.ts`; the only thing
coupling the server to Yjs's version, so a format change could make it refuse a
valid client's writes; and the reason end-to-end encryption was impossible, since
that works exactly as long as the authority never reads the bytes. The empty
state vector went with it, so the central claim now holds for a stronger reason:
there is nothing here that a document could be constructed for. **Those costs are now measured by
`evidence/bench/validate.ts`, one OS process per cell, rather than quoted from a
script that was never committed.** The leak counts are pinned as an
ordering by `evidence/validation.test.ts`, which is kept precisely because it is
the record of why there is no filter.

**Two transients, neither explained.** A run against production once returned
non-JSON from the first probe request on a brand-new partition. And a
1,500-message run once stalled at message 461 waiting for an acknowledgement
past the 60-second timeout, before any snapshot had been taken; later runs at
700 and 1,500 messages passed with snapshots firing at 491 and 979, and
`wrangler tail` recorded no exception in the Durable Object. Neither reproduced
and neither has a cause. They are recorded rather than smoothed over, because a
probe that is retried until it passes is not evidence, and because `workerd`
swallowing a throw without closing the socket would look exactly like this.

**Two real bugs the probe found that the tests did not.** The snapshot trigger
is a ratio, which is scale-free and therefore true almost immediately on a small
document: a live run snapshotted on nearly every message and ground to a halt
around the two hundredth. It now has a floor. And a refusal aimed at a snapshot
offer was being read by the client as a refusal of its in-flight push, because
the acknowledgement path checked the submission number and the refusal path did
not.

## What a randomised schedule found that scenarios did not

`src/sync/transport.test.ts` runs a seeded fuzz: three replicas, random creates,
updates, deletes and prose, random disconnects and reconnects, snapshots firing
throughout, checked against a model held outside the system. It failed 63 of 150
seeds on its first run and found two defects no written scenario reached.

- **Re-delivery was reported as a gap.** Any entry that was not exactly the next
  one raised an error, including one already applied, so the recovery path the
  hibernation wake deliberately uses reported data loss.
- **A gap wedged a replica forever.** The cursor refuses to advance past a gap,
  correctly, so every later entry is also a gap. A replica sat at position 108
  receiving 118, 119 and 121 and rejecting all of them, silently.

Both are fixed and the sweep is now 300 seeds with no failures. The fuzz runs in
one process over an in-order wire, so it says nothing about the two items below.

## What is still unmeasured

- **Genuine hibernation eviction.** These runs held one incarnation, which is
  what the sustained claim needed, but it means the wake path that rebuilds
  connections from their attachments has not been exercised under a real
  eviction. `wrangler dev` cannot trigger one honestly.
- **Memory on the authority under a large reassembly.** The 5 MB paste worked;
  nothing here measures what the Durable Object's heap does while holding the
  chunks of a much larger submission.
- **More than two replicas**, and a replica reconnecting mid-catch-up.
