# The Point of CRDTs Is Consistency, Not Fairness

The point of CRDTs is eventual consistency, not fairness.

This surprises people. When two users edit the same field offline and sync, you'd expect the later edit to win. That's "fair," right? But Yjs, the CRDT library powering Notion, Figma plugins, and countless collaborative tools, doesn't work that way.

## Yjs Uses ClientID, Not Timestamps

When you create a Yjs document, your device gets a random `clientID`. When conflicts happen, the higher clientID wins. Period.

```
Alice's laptop: clientID = 500
Bob's phone:    clientID = 800

Alice edits at 3:00pm: title = "Draft"
Bob edits at 2:00pm:   title = "Final"

Result: "Final" wins. Not because Bob edited later. He didn't.
Bob wins because 800 > 500.
```

From Kevin Jahns (dmonad), the creator of Yjs:

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [dmonad, GitHub issue #520](https://github.com/yjs/yjs/issues/520)

This seems broken. Why would anyone design it this way?

## Because Timestamps Lie

Here's the problem with "last write wins" based on timestamps:

> "Systems for conflict resolution should not rely on time (as in 'wall clock time'). First of all, time is not synced between devices. Secondly, who is to say that changes from desktop client should supersede changes from mobile client just because they happened 'later' (however you wanna measure this)?"
>
> Source: [dmonad, GitHub issue #520](https://github.com/yjs/yjs/issues/520)

Clocks drift. Your laptop might be 5 minutes fast. Your phone might be 2 minutes behind. NTP sync can make clocks jump backward. Offline devices don't sync at all.

```
Laptop clock: 3:05pm (5 minutes fast)
Phone clock:  3:00pm (correct)

Laptop edits at real-time 2:58pm → timestamp says 3:03pm
Phone edits at real-time 3:01pm → timestamp says 3:01pm

With timestamp LWW: Laptop wins (3:03 > 3:01)
But phone edited LATER in reality.
```

If you use timestamps, the device with the fast clock _always_ wins. That's not fair either. It's just a different kind of unfair that _feels_ more intuitive until it burns you.

## The Real Danger: Non-Convergence

Here's what actually matters:

| With clientID ordering      | With timestamp ordering (clock skew) |
| --------------------------- | ------------------------------------ |
| Device A sees "Phone Title" | Device A sees "Laptop Title"         |
| Device B sees "Phone Title" | Device B sees "Phone Title"          |
| Device C sees "Phone Title" | Device C sees "Laptop Title"         |
| **All agree**               | **Data corruption**                  |

A "wrong" winner is annoying. Non-convergence is catastrophic.

When devices disagree on reality, you don't have a sync bug. You have data corruption. Users see different values. Subsequent edits diverge further. There's no single source of truth anymore.

ClientID ordering is arbitrary, but it's _deterministic_. Every device will converge to the same state. Always. That's the actual goal.

## The Goal Isn't Fairness

> The goal isn't "fair" conflict resolution. The goal is **every device agreeing on reality**.

You can add timestamp-based LWW yourself if you really need it (see [y-lwwmap](https://github.com/rozek/y-lwwmap)). But understand the tradeoff: you're betting your devices have decent clocks, and you're accepting occasional non-convergence as acceptable risk.

For most apps, the better solution is designing your data so conflicts rarely happen in the first place. Use nested structures where Alice edits one field and Bob edits another. No conflict at all.

---

_Related:_

- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md) - Deep dive into clientID ordering with code examples
- [CRDT Offline Sync: Why Determinism Beats "Fairness"](./crdt-offline-sync-determinism.md) - Walking through concrete offline scenarios
- [y-lwwmap: A Last-Write-Wins Alternative](./y-lwwmap-last-write-wins-alternative.md) - When you actually need timestamp-based conflict resolution
