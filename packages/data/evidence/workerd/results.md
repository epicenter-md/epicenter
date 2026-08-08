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

## 3. Sustained traffic through one instance

2,000 pushes, one per row, coalescing effectively off so the authority is the
thing under load.

| | local `wrangler dev` | real Cloudflare |
| --- | --- | --- |
| messages | 2,000 | 2,000 |
| entries in the log | 2,000 | 2,000 |
| wall clock | 22,988 ms (11.5 ms each) | 104,095 ms (52.1 ms each) |
| bytes stored | 316,178 | 316,178 |
| bytes per entry | 158 | 158 |
| rows on the other replica | 2,000 | 2,000 |
| control: one incarnation start to end | held | held |
| control: every position contiguous | held | held |
| control: the reader holds every row | held | held |

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

## 4. A refusal is answered rather than swallowed

Six bytes of garbage in a push frame.

| | real Cloudflare |
| --- | --- |
| the authority answered | a frame |
| the answer is a refusal | yes |
| nothing was stored | held |
| control: the socket is still open | held |

The last line is the whole reason the ack exists. `workerd` swallows a throw in
`webSocketMessage` **without closing the socket**, so a refusal that travelled
as an exception would be indistinguishable from success to the client, and the
client would drop the work believing it was delivered.

## What did not survive contact with the runtime

**The authority could not load at all as designed.** Its validator diffed
against `Y.encodeStateVector(new Y.Doc())`, evaluated once at module scope.
Constructing a `Y.Doc` mints a clientID through `crypto.getRandomValues`, and
generating random values in global scope is a *disallowed operation* in a
Worker, so the module threw during startup rather than misbehaving later. The
constant is now written out as `new Uint8Array([0])`, which is pinned against
the library in `evidence/invariants.test.ts` and has the side benefit of making
the file's central claim literally true: the authority never constructs a
document.

**One transient.** A run against production once returned non-JSON from the
first probe request on a brand-new partition and the script died. It did not
reproduce across later runs and is recorded here rather than smoothed over,
because a probe that is retried until it passes is not evidence.

## What is still unmeasured

- **Genuine hibernation eviction.** These runs held one incarnation, which is
  what the sustained claim needed, but it means the wake path that rebuilds
  connections from their attachments has not been exercised under a real
  eviction. `wrangler dev` cannot trigger one honestly.
- **Memory on the authority under a large reassembly.** The 5 MB paste worked;
  nothing here measures what the Durable Object's heap does while holding the
  chunks of a much larger submission.
- **More than two replicas**, and a replica reconnecting mid-catch-up.
