# TinyBase MergeableStore vs Yjs Performance

I was comparing TinyBase and Yjs to understand the performance tradeoffs. I like TinyBase for its cell-level last-write-wins semantics. When two clients edit different cells in the same row, both changes survive. That's powerful for structured data where Yjs's character-level CRDT feels like overkill.

But I wanted to compare TinyBase's MergeableStore performance against raw Yjs. Here's what I found.

**Note:** TinyBase also has a regular `Store` which is just a wrapper around plain JavaScript objects. No CRDT, no conflict resolution. That's obviously more efficient than Yjs, but it's not a fair comparison. The fair comparison is `MergeableStore` vs Yjs since both provide CRDT capabilities with automatic conflict resolution.

## The Quick Takeaways

1. **TinyBase is faster at reads** (~1.5x) thanks to its relational structure
2. **Yjs is faster at writes** (~10-12x) and sync (~2x)
3. **Yjs is more compact** in storage (~2.5x smaller) and memory (~2.7x less heap)
4. **Yjs has built-in delta sync** (100x smaller incremental updates)
5. **TinyBase's cell-level LWW is semantically different** from Yjs's operation-based merging. Pick based on your conflict resolution needs, not just performance

## Benchmark Results

### Read Performance

| Operation | TinyBase MergeableStore | Yjs | Winner |
|-----------|-------------------------|-----|--------|
| 10k random cell reads | 1.47 ms | 7.81 ms | TinyBase (5.3x) |
| 10k random cell reads (warm) | 3.65 ms | 5.45 ms | TinyBase (1.5x) |

TinyBase wins on read speed. Its table/row/cell structure provides efficient lookups.

### Write Performance (Transacted)

| Operation | TinyBase MergeableStore | Yjs | Winner |
|-----------|-------------------------|-----|--------|
| 1,000 rows | 8.43 ms | 0.69 ms | Yjs (12.3x) |
| 10,000 rows | 104.30 ms | 9.39 ms | Yjs (11.1x) |

Yjs crushes TinyBase on writes. The Y.Map structure is highly optimized.

### Synchronization

| Operation | TinyBase MergeableStore | Yjs | Winner |
|-----------|-------------------------|-----|--------|
| Merge 1500 rows | 5.71 ms | 3.08 ms | Yjs (1.9x) |

Yjs's binary encoding is more efficient for sync operations.

### Incremental Sync (Delta Updates)

This is where Yjs really shines:

| Metric | TinyBase | Yjs |
|--------|----------|-----|
| Full state (1000 rows) | 77.48 KB | 43.12 KB |
| Delta after adding 10 rows | N/A (requires Synchronizer) | 440 B |

Yjs has built-in state-vector based delta sync. Adding 10 rows to a 1000-row document creates a 440-byte update instead of re-sending 43KB. That's 100x smaller.

TinyBase MergeableStore uses Synchronizers for incremental sync, which handles the delta logic differently (WebSocket-based, not state-vector based).

### Storage Size

| Row Count | TinyBase MergeableStore | Yjs V2 | Winner |
|-----------|-------------------------|--------|--------|
| 1,000 rows × 3 fields | 174.14 KB | 67.20 KB | Yjs (2.6x smaller) |
| 10,000 rows × 3 fields | 1.72 MB | 691.23 KB | Yjs (2.5x smaller) |

MergeableStore stores HLC timestamps as strings for every cell. Yjs packs similar metadata into a more efficient binary format.

### Memory Usage

| Row Count | TinyBase MergeableStore | Yjs | Winner |
|-----------|-------------------------|-----|--------|
| 10,000 rows | 27.72 MB | 19.75 MB | Yjs (1.4x less) |
| 50,000 rows | 122.43 MB | 44.72 MB | Yjs (2.7x less) |

Yjs uses significantly less runtime memory. Despite its operation-based CRDT maintaining more internal structures, its binary encoding is more memory-efficient than TinyBase's JSON-based HLC timestamps.

## Why MergeableStore Is Larger

MergeableStore adds Hybrid Logical Clock (HLC) timestamps to every cell:

```typescript
// What MergeableStore actually stores
{
  pets: {
    fido: {
      species: ['dog', 'client1-1704067200-0'],
      color: ['brown', 'client1-1704067200-1']
    }
  }
}
```

Every cell carries its timestamp as a string. For a table with 10,000 rows × 3 cells, that's 30,000 timestamps stored as human-readable strings. Yjs packs similar metadata into a binary format.

## The Minimal Reproduction

```typescript
/**
 * TinyBase MergeableStore vs Yjs Benchmark
 * Run with: bun run benchmark.ts
 * Dependencies: bun add tinybase yjs
 */
import * as Y from 'yjs';
import { createMergeableStore } from 'tinybase';

const ROW_COUNT = 10_000;

// Write performance
const store = createMergeableStore();
const writeStart = performance.now();
store.transaction(() => {
  for (let i = 0; i < ROW_COUNT; i++) {
    store.setRow('todos', `todo-${i}`, { title: `Todo ${i}`, completed: false });
  }
});
console.log(`TinyBase write: ${(performance.now() - writeStart).toFixed(2)}ms`);

const doc = new Y.Doc();
const table = doc.getMap<Y.Map<unknown>>('todos');
const yjsStart = performance.now();
doc.transact(() => {
  for (let i = 0; i < ROW_COUNT; i++) {
    const row = new Y.Map();
    row.set('title', `Todo ${i}`);
    row.set('completed', false);
    table.set(`todo-${i}`, row);
  }
});
console.log(`Yjs write: ${(performance.now() - yjsStart).toFixed(2)}ms`);

// Storage size
const tbSize = new TextEncoder().encode(
  JSON.stringify(store.getMergeableContent())
).length;
const yjsSize = Y.encodeStateAsUpdateV2(doc).length;

console.log(`\nStorage (${ROW_COUNT} rows):`);
console.log(`  TinyBase: ${(tbSize / 1024).toFixed(1)} KB`);
console.log(`  Yjs V2:   ${(yjsSize / 1024).toFixed(1)} KB`);

// Read performance
const ids = Array.from({ length: 10000 }, () =>
  `todo-${Math.floor(Math.random() * ROW_COUNT)}`
);

const tbReadStart = performance.now();
for (const id of ids) {
  store.getCell('todos', id, 'title');
  store.getCell('todos', id, 'completed');
}
console.log(`\nTinyBase read (10k): ${(performance.now() - tbReadStart).toFixed(2)}ms`);

const yjsReadStart = performance.now();
for (const id of ids) {
  table.get(id)?.get('title');
  table.get(id)?.get('completed');
}
console.log(`Yjs read (10k): ${(performance.now() - yjsReadStart).toFixed(2)}ms`);
```

## Sample Output

```
TinyBase write: 98.40ms
Yjs write: 9.91ms

Storage (10000 rows):
  TinyBase: 1720.5 KB
  Yjs V2:   691.2 KB

TinyBase read (10k): 1.47ms
Yjs read (10k): 5.45ms
```

## When to Use Which

**Use TinyBase MergeableStore when:**
- Your workload is read-heavy (dashboards, reports, browsing)
- You need cell-level last-write-wins semantics specifically
- The relational API (tables, rows, cells, queries, indexes) is valuable
- You want human-readable JSON for debugging sync issues

**Use raw Yjs when:**
- Your workload is write-heavy (real-time collaboration, frequent updates)
- Sync performance and payload size are critical
- You need collaborative text editing (Y.Text)
- You're building for bandwidth-constrained environments
- Memory efficiency matters at scale

The lesson: TinyBase MergeableStore wins on reads, Yjs wins on everything else. But TinyBase offers a different conflict resolution model (cell-level LWW vs operation-based) that might be exactly what you need for structured data. Choose based on semantics first, performance second.
