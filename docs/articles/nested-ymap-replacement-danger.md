# Why Replacing Nested Y.Maps Loses Concurrent Edits

We avoid nesting Y.Maps inside each other when possible. When we do use them, we never replace the nested map. Only edit keys within it.

Here's a scenario that shows why. It will silently lose data in a collaborative app.

## The Setup

Two clients share a Y.Doc with nested maps:

```typescript
// Initial state (both clients)
const settings = doc.getMap('settings');
const editor = settings.get('editor'); // a Y.Map
// editor contains: { fontSize: 14, tabSize: 2 }
```

## The Conflict

Client A wants to reset editor settings. They create a fresh map:

```typescript
// Client A
const newEditor = new Y.Map();
newEditor.set('fontSize', 12);
newEditor.set('tabSize', 4);
settings.set('editor', newEditor); // DANGER
```

Meanwhile, Client B updates a single setting:

```typescript
// Client B
const editor = settings.get('editor');
editor.set('fontSize', 16);
```

Both changes happen concurrently (before sync).

## What Happens After Sync

Client A's `set('editor', newEditor)` wins (or loses, depending on client IDs). Either way, one of these outcomes occurs:

1. **A wins**: B's `fontSize: 16` edit is gone. The new map has `fontSize: 12`.
2. **B wins**: A's entire reset is ignored. But A thinks they reset settings.

The problem: Client A replaced the *container*, not the contents. Client B edited something *inside* that container. These operations conflict at the wrong level.

## The Safe Pattern

Never replace a nested Y.Map. Edit keys within it:

```typescript
// Client A (safe version)
const editor = settings.get('editor');
editor.set('fontSize', 12);
editor.set('tabSize', 4);
// Don't replace the map itself
```

Now both edits target the same Y.Map. The CRDT handles key-level conflicts correctly. Worst case: one `fontSize` value wins. But no edit is silently discarded.

## When Replacement IS Safe

Replacing nested maps is fine when:

1. **Initial creation**: The map doesn't exist yet, so no concurrent edits are possible.
2. **Epoch-based migrations**: You bump a version number that all clients recognize means "discard old state."
3. **Single-writer contexts**: Only one client ever modifies this subtree.

## The Rule

Think of nested Y.Maps like database rows. You update fields within them. You don't delete and recreate the row to change a field; that loses concurrent updates to other fields.

Same principle. Edit the contents, not the container.
