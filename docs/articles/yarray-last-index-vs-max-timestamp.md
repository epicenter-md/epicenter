# Y.Array Append-Only Logs: Last Index vs Max Timestamp

You're building on Yjs. You have an append-only `Y.Array` where the "current" value is the latest entry. Two clients push concurrently before syncing. Yjs orders them by `clientID`, not by time. So the "last" entry might not be the one that happened most recently.

The obvious fix: add a timestamp field to each entry, scan for the max. This is what every Yjs tutorial suggests. And it's wrong, not because it doesn't work, but because it solves nothing.

## The Setup

When two clients push to the end of a `Y.Array` before syncing with each other, both entries survive (Yjs never drops concurrent operations). But the array order is determined by `clientID`: a random number assigned when the document is created. The client with the higher ID gets its entry placed to the right.

```
Client A (clientID = 5):  pushes {mode: 'binary'}
Client B (clientID = 12): pushes {mode: 'text'}

After sync, array: [{mode:'binary'}, {mode:'text'}]
"Last" entry = {mode:'text'} because clientID 12 > 5
```

If Client A actually acted later in wall-clock time, the "last entry" is the wrong winner. So you add a `ts` field and scan for the maximum, right?

## The Comparison

| Approach | Convergence | "Correct" winner in concurrent case | Retrieval |
|---|---|---|---|
| Last index | All clients agree | Arbitrary (clientID ordering) | `arr[arr.length - 1]`: O(1) |
| Max timestamp | All clients agree | Arbitrary (clock skew) | O(n) sweep through array |

Both rows say "arbitrary." That's the whole point.

## Why Timestamps Don't Fix This

Clocks drift. Your laptop might be 5 seconds ahead. Your phone might be 3 seconds behind. NTP sync can make clocks jump. Offline devices don't sync at all.

```
Client A's clock: 3 seconds fast
Client B's clock: accurate

Client B acts at real-time 14:00:00 → timestamp 14:00:00
Client A acts at real-time 14:00:01 → timestamp 14:00:04

Max timestamp picks Client A (14:00:04 > 14:00:00) ✓ correct this time

But flip the clocks:
Client A's clock: accurate
Client B's clock: 3 seconds fast

Client A acts at real-time 14:00:01 → timestamp 14:00:01
Client B acts at real-time 14:00:00 → timestamp 14:00:03

Max timestamp picks Client B (14:00:03 > 14:00:01) ✗ wrong
```

The device with the faster clock wins. That's not "correct". It's a different kind of arbitrary that feels more intuitive until it burns you. As Kevin Jahns (Yjs creator) [put it](https://github.com/yjs/yjs/issues/520):

> "Systems for conflict resolution should not rely on time. Time is not synced between devices."

## What Actually Matters: Convergence

After sync, every client sees the exact same `Y.Array` in the exact same order. Whether you pick "last index" or "max timestamp," all clients pick the same winner. The data is consistent across every device.

That's the property that matters. Not which entry "wins", that both approaches give you a consistent answer everywhere.

| Property | Last index | Max timestamp |
|---|---|---|
| All clients agree after sync | Yes | Yes |
| Deterministic winner | Yes (clientID order) | Yes (stored timestamps)* |
| Can diverge across clients | No | No* |
| O(1) retrieval | Yes | No: O(n) scan |
| Extra schema field | No | Yes (`ts: number`) |
| Vulnerable to skew | No (no clocks involved) | Yes |

*Both approaches are always deterministic: all clients see the same data and pick the same winner. The distinction is that clientID ordering requires no external input, while timestamps encode a clock value that may not reflect real-world ordering due to clock skew.

## When Does Concurrent Push Actually Happen?

Only when two clients push to the same `Y.Array` within the same sync cycle. On LAN, that's milliseconds. On a bad connection, maybe seconds.

For something like file mode switches (triggered by explicit user actions or shell commands), this requires two humans to independently decide to change the same file's content mode within that window. It doesn't happen.

For something like cursor positions or real-time keystrokes where concurrent operations are constant: different story, different data structure.

## The Cost of "Cheap Insurance"

The timestamp costs one number per entry. Cheap, right? But the real cost isn't storage:

1. **O(n) retrieval.** To find the current entry, you scan every entry for the max timestamp. You can't short-circuit from the tail: an entry earlier in the array could have the highest timestamp if that client's clock was ahead. It's always a full scan, compared to a single index read.

2. **Schema complexity.** Every entry needs a `ts` field. Every write path needs `Date.now()`. Every read path needs a scan function instead of an index read.

3. **False confidence.** The timestamp makes it _feel_ like you have last-writer-wins semantics. You don't. You have last-writer-wins-if-their-clock-is-ahead semantics. The false confidence is worse than honestly acknowledging the arbitrary tiebreaker.

4. **Open questions that don't need opening.** Should it be wall-clock time or a logical clock? A Lamport timestamp? A hybrid logical clock? HLCs would give you correct causal ordering, but they add real operational complexity (clock state, message piggybacking), and for what? To correctly resolve a tiebreaker in a concurrent case that essentially never happens for user-initiated actions. The juice isn't worth the squeeze.

## The Decision

Use last index. `arr[arr.length - 1]`.

You get convergence. You get O(1). You get a simpler schema. And in the astronomically rare concurrent case, you get an arbitrary winner, which is exactly what you'd get with timestamps anyway, just through a different mechanism.

Save the timestamps for data structures where concurrent operations are frequent and ordering actually matters to the user. For append-only logs tracking rare, explicit actions, last index is the right call.

---

_Related:_

- [The Point of CRDTs Is Consistency, Not Fairness](./crdt-consistency-not-fairness.md): Why Yjs uses clientID ordering
- [Y.Array Tombstones Are Tiny](./y-array-tombstones-are-tiny.md): Storage characteristics of Y.Array
- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md): Deep dive into clientID ordering
