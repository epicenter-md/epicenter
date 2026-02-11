# CRDT Conflict Resolution Strategies

When building collaborative or offline-first applications with CRDTs, you need a strategy for resolving conflicts when two clients edit the same key concurrently. This article compares three approaches: clientID-based ordering, wall-clock Last Write Wins (LWW), and Hybrid Logical Clocks (HLC).

## The Problem

Two clients edit the same key while offline:

```
Client A: sets "title" = "Meeting Notes"
Client B: sets "title" = "Project Update"
```

When they sync, which value wins? The answer depends on your conflict resolution strategy.

## 1. ClientID-Based Ordering

This is the simplest approach and what Yjs uses internally for Y.Map and Y.Array.

### How It Works

Each client has a unique, randomly-assigned clientID (a number). When concurrent writes happen, Yjs's CRDT merge algorithm produces a deterministic order based on these IDs:

```typescript
Client A (clientID: 847291): sets "x" = "A"
Client B (clientID: 293847): sets "x" = "B"  // concurrent

// After sync: deterministic winner based on clientID ordering
// The "rightmost" entry after CRDT merge wins
```

### Properties

| Property | Value |
|----------|-------|
| Deterministic | Yes - all clients converge to same result |
| Clock sync needed | No |
| Intuitive winner | No - winner feels arbitrary |
| Implementation complexity | Trivial (built into Yjs) |

### When to Use

- Real-time collaboration where convergence matters more than "who wins"
- Systems where you don't care which concurrent edit survives
- When you want zero configuration

### Implementation

This is what `YKeyValue` uses - it's automatic when you use Yjs's built-in structures:

```typescript
// YKeyValue uses Y.Array with "rightmost wins" cleanup
// The order after CRDT merge is determined by clientIDs
const kv = new YKeyValue(yarray);
kv.set('key', 'value'); // Winner determined by Yjs internals
```

## 2. Wall-Clock Last Write Wins (LWW)

Each write carries a timestamp. The write with the highest timestamp wins.

### How It Works

```typescript
type Entry<T> = {
  key: string;
  val: T;
  time: number; // Wall clock timestamp
};

// Client A at 10:00:01.000
{ key: "title", val: "Meeting Notes", time: 1706400001000 }

// Client B at 10:00:01.500 (concurrent, 500ms later)
{ key: "title", val: "Project Update", time: 1706400001500 }

// After sync: Client B wins because 1500 > 1000
```

### Properties

| Property | Value |
|----------|-------|
| Deterministic | Yes (assuming unique timestamps) |
| Clock sync needed | Yes - sensitive to clock skew |
| Intuitive winner | Yes - "latest edit wins" |
| Implementation complexity | Low |

### The Clock Skew Problem

If Client B's clock is 10 seconds behind, their "later" edit might lose:

```
Real time 10:00:05 - Client A edits (clock says 10:00:05)
Real time 10:00:10 - Client B edits (clock says 10:00:00 - slow!)

Client A wins despite editing first in real time.
```

For most applications, this is acceptable. Users on devices with wildly incorrect clocks will have a degraded experience, but:
- Modern devices sync clocks via NTP
- The failure mode is understandable ("my clock was wrong")
- It's still deterministic - all clients agree on the winner

### When to Use

- Offline-first, multi-device apps where "my most recent edit should win" is the expectation
- When clock skew tolerance of a few seconds is acceptable
- Mobile apps, desktop apps, anywhere users expect "latest wins"

### Implementation

```typescript
// Simplified LWW set operation
set(key: string, val: T): void {
  const entry = { key, val, time: Date.now() };
  // ... append to Y.Array, cleanup old entries
}

// Conflict resolution: compare timestamps
function shouldReplace(existing: Entry, incoming: Entry): boolean {
  return incoming.time > existing.time;
}
```

## 3. Hybrid Logical Clocks (HLC)

HLC combines wall clock time with a logical counter, adding causality guarantees on top of wall-clock ordering.

### How It Works

An HLC timestamp has three components:

```typescript
type HLC = {
  wallTime: number;  // Physical wall clock
  counter: number;   // Logical counter for causality
  nodeId: string;    // Tiebreaker (e.g., Yjs clientID)
};
```

Comparison order:
1. **wallTime** - higher wins (the actual semantic ordering)
2. **counter** - higher wins (preserves causality)
3. **nodeId** - arbitrary but deterministic tiebreaker

### The Key Insight

The `nodeId` is just a tiebreaker for the rare edge case where `wallTime` AND `counter` are identical. In practice, this almost never happens.

**HLC is essentially wall-clock LWW with a deterministic tiebreaker.**

The counter exists to preserve causality: if you *see* edit A and then make edit B, the HLC algorithm ensures B gets a higher timestamp even if your wall clock hasn't advanced.

### Properties

| Property | Value |
|----------|-------|
| Deterministic | Yes |
| Clock sync needed | Tolerates bounded skew |
| Intuitive winner | Yes - mostly "latest wins" |
| Causality preserved | Yes |
| Implementation complexity | Medium |

### When to Use

- Systems requiring strict causality guarantees
- When you need wall-clock intuition but can't tolerate any ambiguity
- Distributed databases, event sourcing systems

### Implementation with Yjs

In a Yjs-based system, you can use the built-in `clientID` as the nodeId:

```typescript
type HLCEntry<T> = {
  key: string;
  val: T;
  wallTime: number;
  counter: number;
  // nodeId comes from doc.clientID
};

function compareHLC(a: HLCEntry, b: HLCEntry, aNodeId: number, bNodeId: number): number {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return aNodeId - bNodeId; // Tiebreaker
}
```

## Comparison Summary

| Strategy | Deterministic | Clock Independent | Intuitive | Complexity | Best For |
|----------|--------------|-------------------|-----------|------------|----------|
| ClientID | Yes | Yes | No | Trivial | Real-time collab |
| Wall-clock LWW | Yes | No | Yes | Low | Offline-first apps |
| HLC | Yes | Mostly | Yes | Medium | Causality-critical systems |

## Our Approach

In epicenter, we provide both:

- **`YKeyValue`** - Uses clientID-based ordering (Yjs default). Best for real-time collaboration where convergence is the priority.

- **`YKeyValueLWW`** - Uses wall-clock LWW with Yjs clientID as the tiebreaker. Best for offline-first scenarios where "latest edit wins" semantics are expected.

For most offline-first applications, wall-clock LWW is the right choice. The clock skew risk is minimal on modern devices, and the "latest wins" behavior matches user expectations.

## Further Reading

- [Lamport Timestamps](https://en.wikipedia.org/wiki/Lamport_timestamp) - The foundation of logical clocks
- [Hybrid Logical Clocks paper](https://cse.buffalo.edu/tech-reports/2014-04.pdf) - Original HLC paper
- [Yjs Internals](https://github.com/yjs/yjs) - How Yjs implements CRDT ordering
