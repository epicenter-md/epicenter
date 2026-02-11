# Memory Management in Yjs: Y.Map vs YKeyValue

> **Important**: The YKeyValue advantage described here only applies when `gc: true` (the default). With `gc: false` (needed for version history/snapshots), Y.Map is actually more efficient. See [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md) for the full comparison.

Yjs is a CRDT library that enables real-time collaboration. But there's a subtle issue that can cause your app to consume unbounded memory over time: Y.Map retains all historical values for each key.

## The Problem: Y.Map's Unbounded Growth

When you update a key in Y.Map, Yjs doesn't just overwrite the old value. It needs to remember what was there so it can merge correctly when syncing with other clients.

```typescript
const map = doc.getMap('settings');

map.set('theme', 'light');  // 1 item stored
map.set('theme', 'dark');   // 2 items stored (old value retained!)
map.set('theme', 'light');  // 3 items stored
map.set('theme', 'dark');   // 4 items stored
// ... after 1000 updates: 1000 items stored
```

For key-value patterns where the same keys are updated repeatedly, this causes unbounded memory growth.

## Benchmark Results

We benchmarked Y.Map vs YKeyValue (an alternative data structure) for typical KV patterns:

| Scenario | Y.Map Size | YKeyValue Size | Ratio |
|----------|------------|----------------|-------|
| 5 keys, 1 update each | 194 B | 225 B | Similar |
| 5 keys, 10 updates each | 562 B | 241 B | **Y.Map 2.3x larger** |
| 5 keys, 100 updates each | 4.43 KB | 254 B | **Y.Map 18x larger** |
| 5 keys, 1000 updates each | 44 KB | 259 B | **Y.Map 174x larger** |
| 10 keys, 10000 updates each | 961 KB | 507 B | **Y.Map 1940x larger** |

The pattern is clear: YKeyValue stays bounded while Y.Map grows linearly with update count.

## How YKeyValue Works

YKeyValue uses Y.Array with an append-and-cleanup strategy:

1. **Append new entries to the right**: When you set a key, push `{key, val}` to the end
2. **Remove old duplicates**: Delete any previous entry with the same key
3. **Right-side precedence**: If concurrent edits add the same key, rightmost wins

```typescript
// Same operations, constant size:
array: [{key:'theme', val:'light'}]                    // 1 item
array: [{key:'theme', val:'dark'}]                     // still 1 item!
array: [{key:'theme', val:'light'}]                    // still 1 item!
```

**Why Y.Array doesn't have the same problem**: When you delete from Y.Array, Yjs marks the item as a "tombstone" but doesn't retain the full value—just enough metadata to know it was deleted.

## The Trade-off

| Aspect | Y.Map | YKeyValue |
|--------|-------|-----------|
| Memory | Unbounded growth | Bounded |
| Set performance | O(1) | O(n) worst case* |
| Get performance | O(1) | O(1) |
| Built-in | Yes | No (custom) |

*YKeyValue scans to find and delete the old entry. In practice, this is fast for small maps.

## When to Use Each

**Use Y.Map when:**
- Keys are set once and rarely updated
- You need maximum write performance
- Memory growth is acceptable for your use case

**Use YKeyValue when:**
- Keys are updated frequently
- Your app runs indefinitely (memory growth matters)
- You're storing table rows or settings that change over time

## Epicenter's Choice

Epicenter uses YKeyValue for both tables and KV storage:

```
Y.Doc
├── tables (Y.Map<tableName, YKeyValue>)
│    └── posts (YKeyValue) ← bounded memory
│
└── kv (YKeyValue) ← bounded memory
```

Local-first apps run indefinitely. Users don't restart them like web pages. Unbounded memory growth will eventually cause problems, so we chose bounded memory even with the slight performance trade-off.

## Implementation

Here's the core of YKeyValue:

```typescript
class YKeyValue<T> {
  private yarray: Y.Array<{ key: string; val: T }>;
  private map: Map<string, { key: string; val: T }>;  // In-memory index

  set(key: string, val: T): void {
    const entry = { key, val };
    const existing = this.map.get(key);

    this.doc.transact(() => {
      // Delete old entry if exists
      if (existing) {
        const index = this.findIndex(key);
        if (index !== -1) this.yarray.delete(index);
      }
      // Append new entry
      this.yarray.push([entry]);
    });

    this.map.set(key, entry);
  }

  get(key: string): T | undefined {
    return this.map.get(key)?.val;  // O(1) via in-memory index
  }
}
```

The in-memory Map provides O(1) reads while Y.Array provides bounded storage.

## Conclusion

Y.Map is great for many use cases, but its unbounded memory growth is a hidden trap for key-value patterns with frequent updates. YKeyValue solves this with a simple append-and-cleanup strategy.

If you're building a local-first app that runs for extended periods, consider your memory characteristics carefully. The difference between 507 bytes and 961 KB might not matter at first, but it compounds over time.
