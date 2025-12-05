# Why You Can't Nest Y Types in Plain Objects

> **Related**: For the TypeScript typing solution to Y.Map's single generic parameter, see: [Working Around Y.Map's Single Generic Parameter](./20251001T215503-ymap-generic-limitations.md)

I hit this wall building a YJS-based system: I had a structure where I knew the keys (`rowsById`, `rowOrder`), and I thought "why use a Y.Map when I know these keys at compile time?"

So I tried this:

```typescript
const plainObject = {
  rowsById: new Y.Map(),
  rowOrder: new Y.Array(),
};

tables.set('posts', plainObject);
```

Seems reasonable, right? The Y types are there, TypeScript is happy, no union types to deal with.

But it doesn't work.

## The Error

When you try to use the Y types retrieved from a plain object, you get:

```
Invalid access: Add Yjs type to a document before reading data.
```

And worse: mutations silently fail. Here's what I tested:

```typescript
const ydoc = new Y.Doc();
const tables = ydoc.getMap('tables');

const plainObject = {
  rowsById: new Y.Map(),
  rowOrder: new Y.Array(),
};

tables.set('posts', plainObject);

// Retrieve and try to use
const retrieved = tables.get('posts');
const postRow = new Y.Map();
postRow.set('id', '123');
postRow.set('title', 'Test Post');

retrieved.rowsById.set('123', postRow);

console.log('Size:', retrieved.rowsById.size); // 0 😞
console.log('Data:', retrieved.rowsById.get('123')); // undefined 😞
```

The Y types exist as instances, but they're non-functional. Observers don't fire. Mutations don't persist. Size stays at zero.

## Why This Happens

YJS uses a **document tree structure**. Every shared type (Y.Map, Y.Array, Y.Text) needs to be integrated into this tree to function. When you store a plain object containing Y types in a Y.Map, those nested Y types become **orphaned**.

They exist as JavaScript instances, but they're not connected to the CRDT document structure. No parent-child relationship. No change tracking. No synchronization.

Think of it like React components: you can create a component instance, but until it's actually mounted in the React tree, it won't render or respond to state changes.

## The Working Solution

You must use Y.Map (or another Y type) as the container:

```typescript
const ydoc = new Y.Doc();
const tables = ydoc.getMap('tables');

// Use Y.Map as container
const tableMap = new Y.Map();
tableMap.set('rowsById', new Y.Map());
tableMap.set('rowOrder', new Y.Array());

tables.set('posts', tableMap);

// Now it works
const retrieved = tables.get('posts');
const rowsById = retrieved.get('rowsById');

const postRow = new Y.Map();
postRow.set('id', '123');
postRow.set('title', 'Test Post');

rowsById.set('123', postRow);

console.log('Size:', rowsById.size); // 1 ✅
console.log('Data:', rowsById.get('123')?.get('title')); // "Test Post" ✅
```

### What's Different?

When you use Y.Map as the container:

1. **Document Integration**: The nested Y.Map and Y.Array are properly integrated into the document tree
2. **Observers Work**: Change events propagate correctly
3. **Mutations Persist**: Data actually gets stored in the CRDT structure
4. **Sync Ready**: Changes can be synchronized across clients

## The Document Tree Visualization

Here's what the structure looks like internally:

**With Plain Object (broken):**
```
ydoc
  └─ tables (Y.Map)
      └─ "posts" → { ... } (plain object)
          ├─ rowsById: Y.Map (orphaned! ❌)
          └─ rowOrder: Y.Array (orphaned! ❌)
```

The Y types exist but aren't part of the tree. No parent reference, no integration.

**With Y.Map Container (working):**
```
ydoc
  └─ tables (Y.Map)
      └─ "posts" → Y.Map
          ├─ "rowsById" → Y.Map (integrated ✅)
          └─ "rowOrder" → Y.Array (integrated ✅)
```

Every Y type has a parent reference, creating a connected tree structure. Changes propagate up, observers work, CRDT operations function correctly.

## Testing This Yourself

I wrote a simple test to verify this behavior:

```typescript
import * as Y from 'yjs';

// Test 1: Plain object (fails)
const ydoc1 = new Y.Doc();
const tables1 = ydoc1.getMap('tables');

const plainObject = {
  rowsById: new Y.Map(),
  rowOrder: new Y.Array(),
};

tables1.set('posts', plainObject);

const retrieved1 = tables1.get('posts');
retrieved1.rowsById.observe((event) => {
  console.log('Observer fired!'); // Never fires
});

retrieved1.rowsById.set('key', new Y.Map());
console.log('Plain object - Size:', retrieved1.rowsById.size); // 0

// Test 2: Y.Map container (works)
const ydoc2 = new Y.Doc();
const tables2 = ydoc2.getMap('tables');

const tableMap = new Y.Map();
tableMap.set('rowsById', new Y.Map());
tableMap.set('rowOrder', new Y.Array());

tables2.set('posts', tableMap);

const retrieved2 = tables2.get('posts');
const rowsById2 = retrieved2.get('rowsById');

rowsById2.observe((event) => {
  console.log('Observer fired!'); // Fires ✅
});

rowsById2.set('key', new Y.Map());
console.log('Y.Map container - Size:', rowsById2.size); // 1 ✅
```

## The Implications

This means:

1. **Can't use plain objects for nested Y types**: Even if keys are known at compile time
2. **Y.Map is required for tree integration**: Not optional, even when it creates typing challenges
3. **Type safety requires abstraction**: Wrap access in helper methods to hide union type complexity

## Related: What About JSON-Encodable Objects?

You *can* store plain JSON objects in Y.Map:

```typescript
const ymap = new Y.Map();
ymap.set('config', { theme: 'dark', language: 'en' }); // ✅ Works fine
```

This works because the plain object is **serialized**. It becomes a value, not a container for other Y types.

The rule: Y types inside a structure need Y.Map/Y.Array as their container. Plain values can go anywhere.

## The Takeaway

YJS isn't like regular JavaScript data structures. Every shared type needs document tree integration to function. Plain objects create orphaned Y types that look like they should work but silently fail.

When building YJS structures:
- Use Y.Map/Y.Array/Y.Text for containers of other Y types
- Use plain objects only for serializable data
- Wrap access in typed helpers to manage the complexity

The document tree requirement is fundamental to how CRDTs work. You can't shortcut it, even when it creates typing challenges.
