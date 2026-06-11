# Root vs Nested: The Two Worlds of `.get()` in Yjs

Yjs has two completely different behaviors hidden behind similar-looking method names. Understanding this distinction is fundamental to working with Yjs correctly.

## The Core Insight

**At the document root, `.getMap()` creates or retrieves a named singleton.**

**Inside a Y.Map, `.get()` returns what's there or undefined.**

These are not the same operation. They're not even close.

## Root Level: Named Singletons

When you call `doc.getMap('name')`, you're not asking "give me whatever Y.Map is stored under this key." You're saying "give me THE Y.Map named 'name' for this document."

```typescript
const doc = new Y.Doc();

// First call: creates the map
const tables1 = doc.getMap('tables');

// Second call: returns the SAME map
const tables2 = doc.getMap('tables');

console.log(tables1 === tables2); // true: same instance
```

The map is created on first access and returned on subsequent access. It's a get-or-create pattern, but more importantly, it's tied to the document's identity.

### This Works Across Clients

Here's where it gets interesting. When two clients both call `doc.getMap('tables')` before syncing:

```
CLIENT A                           CLIENT B
────────                           ────────
doc.getMap('tables')               doc.getMap('tables')
tables.set('posts', ...)           tables.set('users', ...)

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

AFTER SYNC: Both clients have the SAME Y.Map
            containing both 'posts' AND 'users'
```

The root-level maps **merge**. Yjs recognizes that both clients are referring to the same named singleton. The contents from both clients are combined.

This is what makes root-level shared types "safe" for concurrent creation.

## Nested Level: Standard Lookups

Inside a Y.Map, `.get()` behaves like a normal Map lookup:

```typescript
const tables = doc.getMap('tables');

// This might be undefined
const posts = tables.get('posts');

if (posts === undefined) {
	// The key doesn't exist: nothing was created
}
```

There's no magic here. If the key doesn't exist, you get `undefined`. If it does exist, you get the value.

### Why This Matters for Nested Y.Maps

When you store a Y.Map inside another Y.Map:

```typescript
const tables = doc.getMap('tables');

// Creating a NEW Y.Map and assigning it to a key
tables.set('posts', new Y.Map());
```

You're not creating a "named singleton." You're:

1. Creating a brand-new Y.Map instance
2. Storing a reference to it under the key 'posts'

If two clients do this concurrently:

```
CLIENT A                           CLIENT B
────────                           ────────
tables.set('posts', new Y.Map())   tables.set('posts', new Y.Map())
// A creates YMap-A                // B creates YMap-B

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

AFTER SYNC: ONE of these Y.Maps wins.
            The other is completely discarded.
```

This is the "nested Y.Map trap" in action. Two different Y.Map instances are competing for the same key. Yjs picks one deterministically. The losing one, and all its contents, is gone.

## The Method Name Confusion

Here's the naming that trips people up:

| Method                 | Context       | Behavior                  |
| ---------------------- | ------------- | ------------------------- |
| `doc.getMap('name')`   | Document root | Get-or-create singleton   |
| `doc.getArray('name')` | Document root | Get-or-create singleton   |
| `doc.getText('name')`  | Document root | Get-or-create singleton   |
| `ymap.get('key')`      | Inside Y.Map  | Return value or undefined |

The `get` prefix suggests the same semantics. They're fundamentally different.

A clearer API might have been:

```typescript
// Root level (hypothetical)
doc.ensureMap('name'); // Creates if missing
doc.ensureArray('name'); // Creates if missing

// Nested level
ymap.get('key'); // Standard lookup
```

But that's not what we have. So we adapt.

## Why Root Level Is Different

From [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md), root-level types are special because they're identified by **name** across all clients:

> Each item inserted in a Yjs document is given a unique ID, formed from an ID(clientID, clock) pair.

But root-level types don't follow this pattern. They're identified by their string name, not by client operations. When Client A creates `doc.getMap('tables')` and Client B creates `doc.getMap('tables')`, they're both referring to the same conceptual object: "the tables map for this document."

Nested Y.Maps, by contrast, are regular items with client-specific IDs. When two clients create `new Y.Map()` and assign it to the same key, they've created two different items with two different IDs competing for one slot.

## Practical Implications

### Root Level: Use Freely

```typescript
// These are always safe for concurrent access
const tables = doc.getMap('tables');
const users = doc.getMap('users');
const settings = doc.getMap('settings');
```

Multiple clients can call these methods before syncing. The resulting maps will merge their contents.

### Nested Level: Be Careful

```typescript
// DANGEROUS if two clients might do this concurrently
tables.set('posts', new Y.Map());

// SAFER: Use unique IDs so collisions are impossible
const tableId = crypto.randomUUID();
tables.set(tableId, new Y.Map([['name', 'Posts']]));

// SAFEST: Structure your data so creation happens at root level
// (See "Solutions" in yjs-nested-maps-lww-trap.md)
```

## The Mental Model

Think of it this way:

**Root level**: You're declaring that "this named thing exists in this document." All clients agree on what "this named thing" means.

**Nested level**: You're storing a value at a key. If two clients store different values at the same key, one wins.

The root level is special. The nested level is normal. Don't confuse them.

## Quick Reference

| Question                  | Root Level            | Nested Level            |
| ------------------------- | --------------------- | ----------------------- |
| Method name               | `doc.getMap('name')`  | `ymap.get('key')`       |
| Returns if missing        | New empty shared type | `undefined`             |
| Concurrent creation       | Merges contents       | One wins                |
| Safe for concurrent setup | Yes                   | Only if keys are unique |
| Identity                  | By name               | By client ID + clock    |

## Try It Yourself

Copy this into a file and run with `bun run demo.ts` (requires `yjs` installed):

```typescript
import * as Y from 'yjs';

// Two separate clients
const docA = new Y.Doc();
const docB = new Y.Doc();

// ROOT LEVEL: Both get the "tables" map
const tablesA = docA.getMap('tables');
const tablesB = docB.getMap('tables');

// Each adds different keys
tablesA.set('fromA', 'Alice');
tablesB.set('fromB', 'Bob');

// NESTED LEVEL: Both create a NEW Y.Map at the same key
tablesA.set('posts', new Y.Map([['data', "Alice's posts"]]));
tablesB.set('posts', new Y.Map([['data', "Bob's posts"]]));

// Sync both ways
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

// Check results
console.log('Root-level keys:', [...tablesA.keys()]);
// → ["fromA", "fromB", "posts"]: MERGED!

console.log(
	'Nested Y.Map data:',
	(tablesA.get('posts') as Y.Map<string>).get('data'),
);
// → Either "Alice's posts" OR "Bob's posts": ONE WINS, other is GONE
```

Run it a few times. The root-level keys always merge. The nested Y.Map is always one or the other. Never both.

## Summary

1. **`doc.getMap('name')`** is a get-or-create singleton identified by name
2. **`ymap.get('key')`** is a standard lookup that returns undefined if missing
3. Root-level shared types merge across clients
4. Nested shared types compete for map keys. One wins, others are lost
5. The similar naming (`get*` vs `.get()`) obscures this fundamental difference

Understanding this distinction is the key to structuring Yjs documents safely.

---

_See also:_

- [The Nested Y.Map Trap](./yjs-nested-maps-lww-trap.md): Full deep-dive on the collision problem
- [The Curious Case of `.get()` in Yjs](./yjs-get-naming-quirk.md): Original observation about the naming quirk
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md): How Yjs identifies and stores items
