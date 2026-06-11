# SvelteMap Over $state for Keyed Collections

When your data has IDs. Workspace rows, conversations, recordings. Store it in a `SvelteMap`, not a `$state` array. Derive the array form with `$derived` when you need it for rendering.

## The Problem

Say you have a list of conversations, each with an `id`. The tempting thing is:

```typescript
let conversations = $state<Conversation[]>(readAll());
```

This works until you need to look one up:

```typescript
const metadata = $derived(conversations.find((c) => c.id === conversationId));
```

That's O(n) on every access. Worse, Svelte's reactivity tracks the entire array. Updating one conversation re-renders everything that reads `conversations`, even if they only care about a single item.

## The Fix: SvelteMap + $derived

```typescript
const conversationsMap = fromTable(workspace.tables.conversations);

const conversations = $derived(
    conversationsMap.values().toArray().sort((a, b) => b.updatedAt - a.updatedAt),
);
```

Two lines. The `SvelteMap` gives you O(1) lookups (`map.get(id)`), and Svelte tracks each key independently. Updating conversation A doesn't re-render a component that only reads conversation B.

The `$derived` array is a cached materialization. It recomputes only when the map changes, and it gives you a stable reference (critical for TanStack Table, which enters an infinite loop if `get data()` returns a new array on every call).

## The Three-Layer Pattern

Every workspace-backed collection in this codebase follows this shape:

```typescript
// 1. Map: reactive source (private, suffixed with Map)
const recordingsMap = fromTable(workspace.tables.recordings);

// 2. Derived array: cached materialization (private, no suffix)
const recordings = $derived(
    recordingsMap.values().toArray().sort((a, b) => b.timestamp - a.timestamp),
);

// 3. Getter: public API (matches the derived name)
return {
    get recordings() {
        return recordings;
    },
    get(id: string) {
        return recordingsMap.get(id);
    },
};
```

Naming convention: `{name}Map` → `{name}` → `get {name}()`.

## What fromTable Does Under the Hood

`fromTable()` from `@epicenter/svelte` wraps the manual SvelteMap + observe pattern into a single call:

```typescript
export function fromTable<TRow extends BaseRow>(
    table: TableHelper<TRow>,
): SvelteMap<string, TRow> & { destroy: () => void } {
    const map = new SvelteMap<string, TRow>();

    // Seed with current valid rows
    for (const row of table.getAllValid()) {
        map.set(row.id, row);
    }

    // Granular updates: only touch changed rows
    const unobserve = table.observe((changedIds) => {
        for (const id of changedIds) {
            const result = table.get(id);
            switch (result.status) {
                case 'valid':
                    map.set(id, result.row);
                    break;
                case 'not_found':
                case 'invalid':
                    map.delete(id);
                    break;
            }
        }
    });

    return Object.assign(map, { destroy: unobserve });
}
```

The observer fires on local writes, remote CRDT sync, and migration. You write to the workspace table (`workspace.tables.X.set()`), the observer picks it up, and the SvelteMap updates. Unidirectional. Never write to the SvelteMap directly.

## Why Not $state<T[]>?

Three concrete problems:

**1. O(n) lookups.** Every `.find(item => item.id === id)` scans the whole array. With a SvelteMap, `.get(id)` is O(1).

**2. Coarse reactivity.** Svelte's deep proxy on `$state` arrays tracks the array structure. Mutating one item re-triggers any `$derived` that reads the array, even if it only cares about a different item. SvelteMap tracks each key independently.

**3. Referential instability.** If you derive a sorted array inside a getter (not `$derived`), every access creates a new array. TanStack Table's internal `$derived` sees "data changed" → updates internal `$state` → re-triggers `$derived` → infinite loop → page freeze.

`$derived` caches the result, so consumers get the same reference until the underlying SvelteMap actually changes.

## When $state Arrays Are Fine

Not every array needs a SvelteMap. Use `$state<T[]>` when:

- **Items don't have stable IDs.** Terminal history entries, command history strings. Sequential data without identity.
- **Order is the primary concern.** Open file tabs (`$state<FileId[]>`) where the position in the array is the point, not keyed lookup.
- **The list is local UI state.** Small arrays that aren't workspace-backed and don't need granular per-item reactivity.
- **Primitives.** `$state<string[]>` for a list of tags. No identity, no object structure to track granularly.

The rule: if items have IDs and you'll ever need `.find()` or `.get()`, use SvelteMap.

## The .observe() Sync Mechanism

The workspace `.observe()` callback receives a `Set<string>` of changed IDs. This is how SvelteMap stays in sync across multiple clients:

```
User A writes → Yjs CRDT updates → observer fires on User A's device
                                 → CRDT syncs to User B
                                 → observer fires on User B's device
                                 → SvelteMap.set() → UI re-renders
```

Both `fromTable()` and manual `.observe()` implementations follow the same loop: re-read each changed ID from the table, update or delete in the SvelteMap. The table is the source of truth. The SvelteMap is a reactive projection.

## Decision Tree

```
Your data has items with IDs?
├─ YES → Use SvelteMap
│   ├─ Workspace table? → fromTable()
│   ├─ Workspace KV (single key)? → fromKv()
│   ├─ Browser API (Chrome tabs)? → new SvelteMap() + event listeners
│   └─ Need sorted/filtered array? → $derived(map.values().toArray().sort(...))
│
└─ NO → $state is fine
    ├─ Primitives (boolean, string, number) → $state(value)
    ├─ Sequential data without IDs → $state<T[]>([])
    └─ Ordered list where position matters → $state<T[]>([])
```
