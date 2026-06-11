# Yjs Stores Your Objects by Reference, and That's Why You Can't Fork Your Way to Encryption

We needed to add transparent encryption to our CRDT key-value store. The obvious approach was to copy the 600-line `YKeyValueLww` class, add `encrypt()` at the write boundary, `decrypt()` at the read boundary, and call it done. Maybe 25 lines of changes. We almost did it.

Then we ran the experiments.

## The Setup

`YKeyValueLww` is a last-write-wins key-value store backed by a Yjs `Y.Array`. Each entry is `{ key, val, ts }`. The class maintains an in-memory `Map` for O(1) lookups and resolves conflicts using timestamps. When two devices write to the same key, the observer compares timestamps and deletes the loser from the array.

The encryption goal is simple: `val` should be ciphertext in the Y.Array and plaintext when consumers read it. Everything else stays the same: conflict resolution, timestamps, sync.

```typescript
// Before encryption: plaintext everywhere
kv.set('tab-1', { url: 'https://bank.com' });
// Y.Array: { key: 'tab-1', val: { url: 'https://bank.com' }, ts: 1000 }

// After encryption: ciphertext in Y.Array, plaintext to consumers
kv.set('tab-1', { url: 'https://bank.com' });
// Y.Array: { key: 'tab-1', val: { v: 1, ct: '...' }, ts: 1000 }
// kv.get('tab-1') → { url: 'https://bank.com' }
```

Two approaches present themselves: fork the class and add encryption inline, or compose a wrapper around the unchanged class. The fork looks simpler. It isn't.

## Yjs ContentAny Stores References, Not Copies

When you push an object into a `Y.Array`, Yjs wraps it in a `ContentAny` internally. Here's the relevant source:

```javascript
// yjs/src/structs/ContentAny.js
export class ContentAny {
  constructor (arr) {
    this.arr = arr    // stores the reference directly
  }
  getContent () {
    return this.arr   // returns the same reference
  }
}
```

`this.arr = arr`. That's it. No deep clone, no serialization, no defensive copy. The JavaScript object you pushed into the array is the exact same object that comes back from `getContent()` and `toArray()`.

We verified this empirically:

```typescript
const doc = new Y.Doc();
const yarray = doc.getArray('test');
const obj = { key: 'a', val: 'hello', ts: 1000 };

let observerObj;
yarray.observe((event) => {
  observerObj = event.changes.added[0].content.getContent()[0];
});

yarray.push([obj]);

obj === observerObj;           // true: same JS object
obj === yarray.toArray()[0];   // true: same JS object
```

This holds for local operations (same document, same JavaScript runtime). Remote operations. Where updates are decoded from binary. Naturally produce new objects.

## Why Reference Equality Is Load-Bearing

`YKeyValueLww` uses `indexOf()` to find entries in the array during conflict resolution. `indexOf` uses strict equality (`===`). The code works because the objects in the map are the same objects in the array:

```
set('tab-1', data)
    │
    ├── pending.set('tab-1', entry)     ← same object
    └── yarray.push([entry])            ← same object
                │
                ▼  (observer fires)
          map.set('tab-1', entry)       ← same object (from getContent())
```

One object, three locations. All `===` each other. This makes `indexOf` work:

```typescript
// Later, during conflict resolution:
const existing = this.map.get('tab-1');           // the object in the map
const oldIndex = yarray.toArray().indexOf(existing);  // finds it in the array
// Works because existing IS the same object that's in the array.
```

The conflict resolution code has six calls to `indexOf`, each relying on this identity:

```typescript
getAllEntries().indexOf(existing)    // constructor dedup (×2)
getAllEntries().indexOf(existing)    // observer: find old winner's index (×2)
getAllEntries().indexOf(newEntry)    // observer: find new loser's index (×2)
```

## What Happens When You Fork and Decrypt Into the Map

In a fork, the observer would decrypt each incoming entry before storing it in the map:

```typescript
// Fork approach: observer decrypts into NEW objects
const decryptedEntry = { ...rawEntry, val: decrypt(rawEntry.val) };
this.map.set(rawEntry.key, decryptedEntry);
```

Now the map holds decrypted objects and the array holds encrypted objects. They're different JavaScript objects.

```
FORK: Three different objects for the same key
════════════════════════════════════════════════

  yarray entry:  { key:'tab-1', val: CIPHERTEXT, ts:1000 }    Object #1
  map entry:     { key:'tab-1', val: PLAINTEXT,  ts:1000 }    Object #2  ← NEW
  pending entry: { key:'tab-1', val: PLAINTEXT,  ts:1000 }    Object #3  ← NEW

  Object #1 !== Object #2 !== Object #3
```

The next time a conflict arrives for this key, the observer tries to find the old entry's position in the array to delete the loser:

```
CONFLICT ARRIVES: Device B wrote to 'tab-1' with higher timestamp
═══════════════════════════════════════════════════════════════════

  yarray now:  [ {val:CIPHERTEXT_A, ts:1000},  {val:CIPHERTEXT_B, ts:2000} ]
                 ↑ Object #1 (old)              ↑ Object #4 (new, from sync)

  Step 1:  existing = map.get('tab-1')
           → Object #2 (the decrypted copy)

  Step 2:  oldIndex = yarray.toArray().indexOf(existing)
           → searching array for Object #2
           → array contains Object #1 and Object #4
           → Object #2 is not in the array
           → indexOf returns -1

  Step 3:  if (oldIndex !== -1) yarray.delete(oldIndex)
           → -1, so nothing is deleted

  Result:  Loser entry stays in the array. Forever.
           Next conflict adds another entry. And another.
           The array grows without bound. 💥
```

This isn't a theoretical concern. We wrote a test that simulates the exact scenario:

```typescript
// Store a decrypted copy in the map (fork approach)
const decryptedEntry = { ...entry, val: 'DECRYPTED' };
map.set('x', decryptedEntry);

// Later: try to find it in the array
const allEntries = yarray.toArray();
const existing = map.get('x');
allEntries.indexOf(existing);  // -1, not found
```

The test passes. The entry is not found. Conflict resolution breaks.

## The Deletion Handler Breaks Too

The observer's deletion handler has the same issue:

```typescript
event.changes.deleted.forEach((deletedItem) => {
  const entry = deletedItem.content.getContent()[0];
  // Reference equality: only process if this is the entry in our map
  if (this.map.get(entry.key) === entry) {
    this.map.delete(entry.key);
  }
});
```

`entry` is the raw object from the array (encrypted). `this.map.get(entry.key)` is the decrypted copy. `===` fails. Deletions stop propagating to the map.

## Could You Work Around It?

You could replace `indexOf(existing)` with a `findIndex` that matches by key and timestamp:

```typescript
// Instead of reference equality:
allEntries.indexOf(existing)

// Match by content:
allEntries.findIndex(e => e.key === existing.key && e.ts === existing.ts)
```

This fixes the immediate problem, but now you're maintaining a modified copy of 600 lines of CRDT logic that must stay in sync with the original class. Every bug fix, every optimization, every edge case correction needs to be applied in two places. The CRDT logic in `YKeyValueLww` was carefully developed over months with subtle invariants around pending entries, transaction nesting, monotonic clocks, and positional tiebreakers. Forking it to add 25 lines of encryption means owning all 600 lines forever.

## What About Keeping the Map Encrypted?

There's a subtler variant of the fork. Instead of decrypting into the map (which breaks `indexOf`), keep the encrypted blobs in the map untouched. The map holds the same objects as the yarray. Reference equality holds. `indexOf` works. Problem solved?

Not quite. The map now contains ciphertext, and consumers read `.map` directly. Table-helper accesses it in seven places. Every consumer would need to decrypt on read, or you need a second map:

```
FORK (encrypted map)                    COMPOSITION (what we're doing)
────────────────────                    ──────────────────────────────
yarray: [enc_A, enc_B, enc_C]          yarray: [enc_A, enc_B, enc_C]
map:    { k1: enc_A, k2: enc_C }       inner.map: { k1: enc_A, k2: enc_C }
          ↑                                          ↑
  same refs → indexOf works ✓            same refs → indexOf works ✓

But consumers need plaintext...         wrapper.decryptedMap: { k1: plain_A, k2: plain_C }

So you ALSO need:                       ← already have it
decryptedMap: { k1: plain_A, ... }
```

Both approaches land on the same two-map architecture. Encrypted map for CRDT internals, decrypted map for consumers. The fork just gets there with 600 extra lines of duplicated CRDT logic.

The fork also has an interface problem. If it exposes `.map` (the encrypted map), every consumer needs to know about encryption. Table-helper, KV consumers, anything that reads entries. If it exposes the decrypted map as `.map` instead, you're back to the original `indexOf` failure: different objects in the map versus the array. There's no way to serve both the CRDT internals and the consumers with a single map when encryption is involved.

## Composition: Let the Engine Stay the Engine

The composition approach wraps the unchanged `YKeyValueLww` and maintains a separate plaintext map:

```
                    YOUR APP CODE
                    (tables, KV)
                         │
                   reads wrapper.map (plaintext)
                         │
  ┌──────────────────────┴──────────────────────────┐
  │        Encrypted Wrapper (~100 lines)            │
  │                                                  │
  │  wrapper.map: Map<string, Entry<PLAINTEXT>>      │
  │       ↑ kept in sync by observing inner          │
  │                                                  │
  │  set(): encrypt → inner.set()                    │
  │  get(): wrapper.map.get() → plaintext            │
  └──────────────────────┬──────────────────────────┘
                         │
  ┌──────────────────────┴──────────────────────────┐
  │  YKeyValueLww<EncryptedBlob>  (UNCHANGED)        │
  │                                                  │
  │  inner.map: same objects as yarray entries        │
  │  indexOf: works because === holds                │
  │  All CRDT logic: untouched                       │
  └──────────────────────┬──────────────────────────┘
                         │
  ┌──────────────────────┴──────────────────────────┐
  │  Y.Array (ContentAny stores references)          │
  └─────────────────────────────────────────────────┘
```

The inner `YKeyValueLww` doesn't know encryption exists. It sees `EncryptedBlob` objects as just another value type. Its map entries are the same JS objects as the array entries. `indexOf` works. Conflict resolution works. Pending works. Every invariant holds because nothing was changed.

The wrapper observes the inner class and decrypts each change into its own map. Table helpers read `wrapper.map` and see plaintext. Zero changes to consumers.

## The Full Experiment Results

We ran eight tests to verify every aspect of reference equality in Yjs:

```
TEST                                              RESULT
────────────────────────────────────────────────────────────
push → observer getContent()                      SAME REFERENCE  ✓
push → toArray()                                  SAME REFERENCE  ✓
Sync to another doc → toArray()                   DIFFERENT       ✓ (decoded from binary)
After sync roundtrip, local doc references        STILL SAME      ✓
indexOf(copy) where copy = {...obj}               RETURNS -1      ✓
Simulated fork: decrypted entry in map            indexOf → -1    ✓ BREAKS
Mutate object after push → toArray sees it        YES             ✓ (reference, not copy)
Composition: inner map ref vs wrapper map ref     inner=found     ✓
```

Experiment 7 is particularly telling: mutating an object's property after `push()` changes what `toArray()` returns. Yjs doesn't snapshot the object on insert. It holds the pointer.

## The Takeaway

When you build on top of a CRDT, the CRDT's internal assumptions become your constraints. Yjs stores objects by reference and uses reference equality for structural operations like conflict resolution. Any layer that creates new objects for the same logical entries, whether through decryption, migration, or transformation, breaks that identity chain. And even if you avoid creating new objects by keeping the map encrypted, you still need a decrypted map for consumers, which is composition's architecture anyway, minus the maintenance burden.

Composition respects the boundary. The CRDT engine stays untouched; the encryption layer sits above it with its own cache. A hundred lines of wrapper code beats six hundred lines of forked CRDT logic that you'd need to maintain in parallel, and the reference equality invariant never comes into question.
