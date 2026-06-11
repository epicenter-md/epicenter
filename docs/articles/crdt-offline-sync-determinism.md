# CRDT Offline Sync: Why Determinism Beats "Fairness"

When building offline-first apps with CRDTs, you'll eventually ask: "What happens when two devices edit the same data while offline?" The answer is more nuanced than you might expect, and understanding it will save you from over-engineering your sync layer.

---

## Walking Through the Offline Scenario

**Setup**: You have a laptop and phone, both go offline.

### Scenario 1: Different cells (99% of the time)

```
Laptop (offline): edits row-1.title = "Draft"
Phone (offline):  edits row-1.views = 100

They sync.

Result: { title: "Draft", views: 100 }  ✅ BOTH preserved
```

No conflict. Y.Map of Y.Maps handles this perfectly. Each cell is an independent key, so edits to different cells merge without issue.

### Scenario 2: Same cell (rare edge case)

```
Laptop (offline, clientID=500): edits row-1.title = "Laptop Title"
Phone (offline, clientID=800):  edits row-1.title = "Phone Title"

They sync.

Result: "Phone Title" (800 > 500)
```

One wins, one loses. **But both devices see the same result.** That's the guarantee.

### Scenario 3: Same cell, "wrong" winner

```
Laptop (offline, clientID=900): edits row-1.title = "Old" at 2pm
Phone (offline, clientID=100):  edits row-1.title = "New" at 3pm

They sync.

Result: "Old" (900 > 100, even though phone edited later)
```

This is the "surprising" behavior. The laptop's earlier edit wins because it has a higher clientID, not because of when the edit happened.

But how often does this actually happen? You need:

- Same user (or users)
- Same exact cell
- Both offline simultaneously
- Both editing before either syncs

That's a narrow intersection in practice.

---

## Why NOT Use Timestamp-Based LWW?

**Because determinism is more important than "fairness."**

Here's how dmonad (Yjs creator) explains it:

> "Systems for conflict resolution should not rely on time (as in 'wall clock time'). First of all, time is not synced between devices. Secondly, who is to say that changes from desktop client should supersede changes from mobile client just because they happened 'later' (however you wanna measure this)?"
>
> Source: [dmonad, GitHub issue #520](https://github.com/yjs/yjs/issues/520)

### The core problem with timestamps

```
Laptop clock: 3:05pm (5 minutes fast)
Phone clock:  3:00pm (correct)

Laptop edits at real-time 2:58pm → timestamp says 3:03pm
Phone edits at real-time 3:01pm → timestamp says 3:01pm

With timestamp LWW: Laptop wins (3:03 > 3:01)
But phone edited LATER in reality.
```

**Timestamps lie.** And when they lie, you get non-deterministic behavior where different devices might see different "winners" depending on when they synced.

### What "deterministic" means

**ClientID ordering:**

```
- Device A syncs first, sees "Phone Title"
- Device B syncs later, sees "Phone Title"
- Device C syncs much later, sees "Phone Title"

ALL DEVICES CONVERGE TO SAME STATE. ALWAYS.
```

**Timestamp ordering (with clock skew):**

```
- Device A syncs, sees "Laptop Title" (based on its clock comparison)
- Device B syncs, sees "Phone Title" (based on its clock comparison)

DEVICES MIGHT DISAGREE. DATA CORRUPTION.
```

### The tradeoff

| Approach               | Guarantee                            | Risk                                      |
| ---------------------- | ------------------------------------ | ----------------------------------------- |
| **ClientID ordering**  | 100% deterministic convergence       | "Wrong" winner ~50% of same-key conflicts |
| **Timestamp ordering** | "Intuitive" winner when clocks agree | Non-convergence when clocks disagree      |

Yjs chose determinism because **non-convergence is catastrophic**. A "wrong" winner is annoying; data corruption is fatal.

The actual conflict resolution happens in Yjs source ([updates.js#L357](https://github.com/yjs/yjs/blob/main/src/utils/updates.js#L357)):

```javascript
// Higher clientID wins when comparing different clients
return dec2.curr.id.client - dec1.curr.id.client;
```

---

## When Would You Want Timestamp LWW?

Only if:

1. You trust all devices have accurate clocks (NTP always working)
2. You're okay with occasional non-convergence as acceptable risk
3. "Later edit wins" is a product requirement users explicitly expect

For most apps, **clientID ordering + good data modeling** (cell-level granularity with Y.Map of Y.Maps) is the right choice.

---

## The Bottom Line

Design your data so conflicts are rare (different cells = no conflict), and trust the CRDT to handle the rare same-cell case deterministically. Don't add timestamp complexity unless users are actually complaining. And even then, understand you're trading guaranteed convergence for intuitive-but-risky ordering.

The goal isn't "fair" conflict resolution. The goal is **every device agreeing on reality**.

---

_Related:_

- [The Point of CRDTs Is Consistency, Not Fairness](./crdt-consistency-not-fairness.md) - The core insight: determinism beats intuition
- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md) - Why CRDTs use clientID ordering instead of timestamps

_Primary sources:_

- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Maintainer confirms higher clientID wins
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - Technical documentation
